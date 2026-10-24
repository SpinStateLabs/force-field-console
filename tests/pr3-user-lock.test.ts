// Second review of the durable-suspend PR: one lock per USER across subscriptions, several granting
// subscriptions, the pending flag written before the slow quiesce, and readCurrent honoured.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelFly, RICH_CONFIG } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { SUB_LOCK_TTL_MS, handleStripeEvent, retryPendingSuspend, withUserLock } from "../src/lib/billing";
import { renewSelfAgents } from "../src/lib/renewal";
import { getEstate, queueEstate, readback, saveEstate, setEstateAnthropicKey, suspendEstate, type Estate } from "../src/lib/estates";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };

let user: User;
let fly: ModelFly;
let statuses: Record<string, string>;
const origDelay = readback.delayMs;

function sub(id: string, status: string) {
  return { id, status, customer: "cus_1", items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] }, metadata: { user_id: user.id } };
}
const ev = (id: string, type: string, created: number, s: any) => ({ id, type, created, data: { object: s } });
/** Stripe stand-in for getSubscription: answers each subscription with its current status in `statuses`. */
const fetchImpl = (async (u: any) => {
  const id = String(u).split("/").pop()!;
  return new Response(JSON.stringify(sub(id, statuses[id] ?? "canceled")), { status: 200 });
}) as any;
const deps = () => ({ cfg: stripeConfig()!, fly: fly as any, fetchImpl });

beforeEach(async () => {
  freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV);
  readback.delayMs = 5;
  user = await createUser("lock@example.com", "sufficiently-long-pass");
  fly = new ModelFly();
  statuses = {};
});
afterEach(() => {
  readback.delayMs = origDelay;
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV)]) delete process.env[k];
});

async function payingOn(subId: string) {
  user.tier = "operator";
  user.billing = { customer_id: "cus_1", subscription_id: subId, status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
  await saveUser(user);
  statuses[subId] = "active";
}
async function readyEstate(over: Partial<Estate> = {}) {
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` }, over);
  await saveEstate(e);
  return e;
}
const final = async () => {
  const e = (await getEstate(user.id))!;
  const u = (await getUserById(user.id))!;
  return { estate: e.status, pending: e.suspend_pending ?? null, sub: u.billing?.subscription_id, tier: u.tier, machine: fly.machine("m_1").state, autostartOff: fly.autostartOff("m_1") };
};

describe("MED 1: one lock per user - A cancelled while B is bought (the live rehearsal sequence)", () => {
  it("A 'deleted' mid-suspend (slow stop), B 'created' 100 ms later: B waits, then adopts and RESUMES the estate", async () => {
    await payingOn("sub_A");
    await readyEstate();
    fly.stopDelay = 300;
    statuses.sub_A = "canceled";
    statuses.sub_B = "active";
    const a = handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
    await sleep(100);
    const b = handleStripeEvent(ev("b_new", "customer.subscription.created", 250, sub("sub_B", "active")), deps());
    await Promise.all([a, b]);
    await retryPendingSuspend(user.id, fly as any, new Date());
    expect(await final()).toEqual({ estate: "ready", pending: null, sub: "sub_B", tier: "operator", machine: "started", autostartOff: true });
  });

  for (const order of ["A-first", "B-first"] as const) {
    it(`A 'deleted' and B 'created' fired together (${order}): the customer ends up served by B`, async () => {
      await payingOn("sub_A");
      await readyEstate();
      fly.stopDelay = 40;
      statuses.sub_A = "canceled";
      statuses.sub_B = "active";
      const a = () => handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
      const b = () => handleStripeEvent(ev("b_new", "customer.subscription.created", 250, sub("sub_B", "active")), deps());
      await Promise.all(order === "A-first" ? [a(), b()] : [b(), a()]);
      await retryPendingSuspend(user.id, fly as any, new Date());
      const f = await final();
      expect(f).toMatchObject({ estate: "ready", sub: "sub_B", tier: "operator", pending: null });
      expect(f.machine).toBe("started");
    });
  }

  it("replaying every event afterwards changes nothing", async () => {
    await payingOn("sub_A");
    await readyEstate();
    statuses.sub_A = "canceled";
    statuses.sub_B = "active";
    const events = [ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), ev("b_new", "customer.subscription.created", 250, sub("sub_B", "active"))];
    for (const e of events) await handleStripeEvent(e, deps());
    await retryPendingSuspend(user.id, fly as any, new Date());
    const before = await final();
    for (const e of [...events, ...events]) await handleStripeEvent(e, deps());
    await retryPendingSuspend(user.id, fly as any, new Date());
    expect(await final()).toEqual(before);
    expect(before).toMatchObject({ estate: "ready", sub: "sub_B", tier: "operator" });
  });

  it("the tick's retry and a guarded Fly write take the same per-user lock as the webhook", async () => {
    await payingOn("sub_A");
    const e = await readyEstate();
    fly.machine("m_1").config = RICH_CONFIG();
    // a webhook for the OTHER subscription holds the user lock while it works (slow stop): the guarded write must wait for it
    fly.stopDelay = 250;
    statuses.sub_A = "canceled";
    const del = handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
    await sleep(40);
    const t0 = Date.now();
    await expect(setEstateAnthropicKey(e, fly as any, "sk-ant-" + "a".repeat(40))).rejects.toThrow(/suspend/);
    expect(Date.now() - t0).toBeGreaterThan(100); // it waited for the lock, then saw the suspended estate
    await del;
    expect(await final()).toMatchObject({ estate: "suspended", machine: "stopped", autostartOff: true });
  });
});

describe("MED 2: several simultaneously granting subscriptions", () => {
  it("A, B, C active: cancelling them one by one hands over A -> B -> C and only the last cancellation suspends", async () => {
    await payingOn("sub_A");
    await readyEstate();
    statuses.sub_B = "active";
    statuses.sub_C = "active";
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 110, sub("sub_B", "active")), deps());
    await handleStripeEvent(ev("c_new", "customer.subscription.created", 120, sub("sub_C", "active")), deps());
    expect((await getUserById(user.id))!.billing!.subscription_id).toBe("sub_A");

    statuses.sub_A = "canceled";
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
    expect(await final()).toMatchObject({ estate: "ready", sub: "sub_B", tier: "operator" });

    statuses.sub_B = "canceled";
    await handleStripeEvent(ev("b_del", "customer.subscription.deleted", 210, sub("sub_B", "canceled")), deps());
    expect(await final()).toMatchObject({ estate: "ready", sub: "sub_C", tier: "operator" });

    statuses.sub_C = "canceled";
    await handleStripeEvent(ev("c_del", "customer.subscription.deleted", 220, sub("sub_C", "canceled")), deps());
    expect(await final()).toMatchObject({ estate: "suspended", tier: "sandbox", machine: "stopped", autostartOff: true });
  });

  it("a remembered subscription that was cancelled meanwhile is forgotten: the current one's cancellation suspends", async () => {
    await payingOn("sub_A");
    await readyEstate();
    statuses.sub_B = "active";
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 110, sub("sub_B", "active")), deps());
    statuses.sub_B = "canceled";
    await handleStripeEvent(ev("b_del", "customer.subscription.deleted", 150, sub("sub_B", "canceled")), deps());
    expect((await getUserById(user.id))!.billing!.other_subs ?? {}).toEqual({});
    statuses.sub_A = "canceled";
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
    expect((await getEstate(user.id))!.status).toBe("suspended");
  });

  it("a remembered subscription that Stripe no longer reports as granting is skipped at hand-over time", async () => {
    await payingOn("sub_A");
    await readyEstate();
    statuses.sub_B = "active";
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 110, sub("sub_B", "active")), deps());
    statuses.sub_B = "unpaid"; // changed at Stripe, event not seen yet
    statuses.sub_A = "canceled";
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
    expect((await getEstate(user.id))!.status).toBe("suspended");
    // the unverified candidate was NOT adopted: the record still mirrors the cancelled current subscription
    const b = (await getUserById(user.id))!.billing!;
    expect(b.subscription_id).toBe("sub_A");
    expect(b.status).toBe("canceled");
  });
});

describe("the tick's retry waits for the user lock", () => {
  it("retryPendingSuspend does nothing while another transition holds the user's lock, then completes", async () => {
    await readyEstate();
    fly.failStop = true;
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(Date.now() - 3_600_000), "canceled");
    expect((await getEstate(user.id))!.suspend_pending).toBeTruthy();
    fly.failStop = false;
    fly.log.length = 0;
    const holder = withUserLock(user.id, async () => {
      await sleep(250);
    });
    await sleep(30);
    const retry = retryPendingSuspend(user.id, fly as any, new Date());
    await sleep(120);
    expect(fly.log).toEqual([]); // still waiting for the lock
    await holder;
    const r = await retry;
    expect(r.outcome).toBe("suspended");
    expect(fly.log).toContain("stop m_1");
  });
});

describe("LOW 3: the pending flag is written BEFORE the slow quiesce, and the lock outlives it", () => {
  it("during a slow stop the estate already shows suspend_pending (gateway and guarded writers refuse)", async () => {
    await readyEstate();
    fly.stopDelay = 150;
    const run = suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    await sleep(60);
    const mid = (await getEstate(user.id))!;
    expect(mid.status).toBe("ready");
    expect(mid.suspend_pending).toBeTruthy();
    await run;
    const done = (await getEstate(user.id))!;
    expect(done.status).toBe("suspended");
    expect(done.suspend_pending ?? null).toBeNull();
    expect(done.health ?? null).toBeNull();
  });

  it("the user lock TTL covers the worst case of one suspend (several minutes)", () => {
    expect(SUB_LOCK_TTL_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe("LOW 4: readCurrent is honoured", () => {
  it("token renewal and key placement write back the machine's CURRENT config (read inside the lock), not a rebuilt one", async () => {
    const e = await readyEstate();
    fly.machine("m_1").config = RICH_CONFIG();
    fly.machine("m_1").config.env.SOMETHING_SET_ONLY_ON_FLY = "keep-me";
    const expected = structuredClone(fly.machine("m_1").config);
    await renewSelfAgents(e, fly as any);
    expect(fly.machine("m_1").config).toEqual(expected);
    await setEstateAnthropicKey((await getEstate(user.id))!, fly as any, "sk-ant-" + "a".repeat(40));
    expect(fly.machine("m_1").config).toEqual(expected);
    // and the read happened before each write
    const upd = fly.log.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith("update"));
    expect(upd.length).toBe(2);
    for (const [, i] of upd) expect(fly.log.slice(0, i).some((l) => l === "get m_1")).toBe(true);
  });
});
