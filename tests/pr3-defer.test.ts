// The webhook only QUEUES a resume (no Fly call inline), the tick starts the machine; an orphaned
// start can never hide a running machine behind a suspended record; the inline quiesce has a budget;
// a stopped machine of a paying customer is found by the tick.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import tickHandler from "../netlify/functions/estate-tick.mts";
import healthHandler from "../netlify/functions/health.mts";
import { ModelFly, machinesApiHandler } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent, retryPendingSuspend } from "../src/lib/billing";
import { WAIT_S, getEstate, quiesceBudget, queueEstate, readback, resumeEstate, saveEstate, suspendEstate, updateMachineGuarded, type Estate } from "../src/lib/estates";

const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };
let user: User;
let fly: ModelFly;
const origDelay = readback.delayMs;
const origBudget = quiesceBudget.ms;

function sub(id: string, status: string) {
  return { id, status, customer: "cus_1", items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] }, metadata: { user_id: user.id } };
}
const ev = (id: string, type: string, created: number, s: any) => ({ id, type, created, data: { object: s } });
const deps = () => ({ cfg: stripeConfig()!, fly: fly as any });

beforeEach(async () => {
  freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV);
  readback.delayMs = 3;
  user = await createUser("defer@example.com", "sufficiently-long-pass");
  fly = new ModelFly();
});
afterEach(() => {
  readback.delayMs = origDelay;
  quiesceBudget.ms = origBudget;
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV)]) delete process.env[k];
});

async function payingOn(subId: string, status = "active") {
  user.tier = status === "active" ? "operator" : "sandbox";
  user.billing = { customer_id: "cus_1", subscription_id: subId, status, price_id: "price_op", tier: user.tier, current_period_end: null, updated_at: "t" };
  await saveUser(user);
}
async function estate(over: Partial<Estate> = {}) {
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` }, over);
  await saveEstate(e);
  fly.machine("m_1");
  return e;
}
const stopQuietly = () => {
  const m = fly.machine("m_1");
  m.state = "stopped";
  m.config.services[0].autostart = false;
};
async function tick() {
  const api = machinesApiHandler(fly);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => (await api(String(url), init)) ?? new Response("", { status: 404 })) as any;
  try {
    return await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("DESIGN: the webhook queues a resume and returns; the tick starts the machine", () => {
  it("a re-grant makes NO Fly call inline, marks resume_pending with an honest note, and the tick then starts the machine", async () => {
    await payingOn("sub_A", "canceled");
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    stopQuietly();
    fly.log.length = 0;
    await handleStripeEvent(ev("a_back", "customer.subscription.updated", 300, sub("sub_A", "active")), deps());
    expect(fly.log).toEqual([]); // nothing on Fly inline
    const queued = (await getEstate(user.id))!;
    expect(queued.status).toBe("suspended");
    expect(queued.resume_pending).toMatchObject({ attempts: 0, failed: false });
    expect(queued.health?.note).toMatch(/resume pending.*within about 2 minutes/);
    expect(fly.machine("m_1").state).toBe("stopped");

    const body = await tick();
    expect(body.outcomes.resume_retry_ok).toBe(1);
    expect((await getEstate(user.id))!.status).toBe("ready");
    expect(fly.machine("m_1").state).toBe("started");
  });

  it("an estate with no machine on Fly (nothing to start) is resumed inline", async () => {
    await payingOn("sub_A", "canceled");
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z", machine_id: null });
    await handleStripeEvent(ev("a_back", "customer.subscription.updated", 300, sub("sub_A", "active")), deps());
    expect((await getEstate(user.id))!.status).toBe("ready");
  });

  it("a cancel keeps working inline and persists suspend_pending before its first Fly call", async () => {
    await payingOn("sub_A");
    await estate();
    const seen: any[] = [];
    const orig = fly.getMachine.bind(fly);
    fly.getMachine = async (a: string, id: string) => {
      seen.push(((await getEstate(user.id))!.suspend_pending ?? null) !== null);
      return orig(a, id);
    };
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
    expect(seen[0]).toBe(true); // already pending when Fly was first asked
    expect((await getEstate(user.id))!.status).toBe("suspended");
    expect(fly.machine("m_1").state).toBe("stopped");
  });

  it("the inline quiesce stops starting new Fly calls once its time budget is spent, leaving a retryable pending state", async () => {
    await payingOn("sub_A");
    await estate();
    quiesceBudget.ms = 30;
    fly.updateDelay = 80; // the config update alone outlasts the budget
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("ready");
    expect(e.suspend_pending).toBeTruthy();
    expect(fly.log).not.toContain("stop m_1"); // no new call after the budget
    // the tick (unlimited by that budget) completes it
    quiesceBudget.ms = 20_000;
    fly.updateDelay = 0;
    const r = await retryPendingSuspend(user.id, fly as any, new Date(Date.now() + 3_600_000));
    expect(r.outcome).toBe("suspended");
    expect(fly.machine("m_1").state).toBe("stopped");
  });
});

describe("MED: a resume whose start landed but was not confirmed cannot hide a running machine", () => {
  it("(a) the failed confirmation flags the estate, and a later cancel stops the running machine", async () => {
    await payingOn("sub_A", "canceled");
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    stopQuietly();
    fly.waitNever = true; // the start lands (machine runs) but the wait never confirms
    await expect(resumeEstate((await getEstate(user.id))!, fly as any)).rejects.toBeTruthy();
    expect(fly.machine("m_1").state).toBe("started");
    const flagged = (await getEstate(user.id))!;
    expect(flagged.status).toBe("suspended");
    expect(flagged.suspend_pending).toBeTruthy();
    fly.waitNever = false;
    await payingOn("sub_A", "active");
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 400, sub("sub_A", "canceled")), deps());
    expect(fly.machine("m_1").state).toBe("stopped");
    const after = (await getEstate(user.id))!;
    expect(after.status).toBe("suspended");
    expect(after.suspend_pending ?? null).toBeNull();
  });

  it("(b) a suspended record is verified against the machine: a running machine behind it is stopped by the next cancel", async () => {
    await payingOn("sub_A");
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" }); // no flag
    expect(fly.machine("m_1").state).toBe("started"); // orphan
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
    expect(fly.machine("m_1").state).toBe("stopped");
    expect(fly.autostartOff("m_1")).toBe(true);
    expect((await getEstate(user.id))!.status).toBe("suspended");
  });

  it("(b) a suspended record whose machine IS stopped costs one read and nothing else", async () => {
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    stopQuietly();
    fly.log.length = 0;
    const r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "again");
    expect(r.status).toBe("suspended");
    expect(fly.log).toEqual(["get m_1"]);
  });
});

describe("LOW: the tick finds a paying customer's ready estate whose machine is stopped", () => {
  it("queues the start, starts it in the same tick, counts it, and /api/health shows machine_stopped", async () => {
    await payingOn("sub_A");
    await estate();
    stopQuietly();
    const body = await tick();
    expect(body.machine_stopped).toBe(1);
    expect(body.outcomes.resume_retry_ok).toBe(1);
    expect(fly.machine("m_1").state).toBe("started");
    expect((await getEstate(user.id))!.resume_pending ?? null).toBeNull();
    const h = await (await healthHandler(new Request("http://portal.test/api/health"), ctx)).json();
    expect(h.machine_stopped).toBe(true);
    const again = await tick();
    expect(again.machine_stopped).toBe(0);
  });

  it("leaves a stopped machine alone when the customer is not paying", async () => {
    await payingOn("sub_A", "canceled");
    await estate();
    stopQuietly();
    const body = await tick();
    expect(body.machine_stopped).toBe(0);
    expect(fly.machine("m_1").state).toBe("stopped");
  });

  it("a stale resume intent (the customer stopped paying meanwhile) is dropped, never acted on", async () => {
    await payingOn("sub_A", "canceled");
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z", resume_pending: { since: "2026-01-01T00:00:00.000Z", attempts: 0, last_error: "", next_retry_at: null, failed: false } });
    stopQuietly();
    await tick();
    const e = (await getEstate(user.id))!;
    expect(e.resume_pending ?? null).toBeNull();
    expect(e.status).toBe("suspended");
    expect(fly.machine("m_1").state).toBe("stopped");
  });
});

describe("survivors", () => {
  it("R7: the webhook / tick wait for Fly is short (a 300 s wait would outlast any function limit)", () => {
    expect(WAIT_S).toBeLessThanOrEqual(10);
    expect(quiesceBudget.ms).toBeLessThanOrEqual(25_000);
  });

  it("R9: resumeEstate really starts the machine and waits for it (it cannot just flip the record)", async () => {
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    stopQuietly();
    const r = await resumeEstate((await getEstate(user.id))!, fly as any);
    expect(r.status).toBe("ready");
    expect(fly.machine("m_1").state).toBe("started");
    expect(fly.log).toContain("start m_1");
    expect(fly.log).toContain("wait m_1 started");
  });

  it("R12: the guarded config writer refuses a missing estate and an estate without a machine", async () => {
    const e = await estate();
    const ghost = { ...e, user_id: "nobody" } as Estate;
    await expect(updateMachineGuarded(ghost, fly as any, () => ({ image: "x" }))).rejects.toThrow(/suspended|being suspended/);
    const noMachine = await createUser("nomach@example.com", "sufficiently-long-pass");
    const e2 = await queueEstate(noMachine);
    e2.status = "ready";
    await saveEstate(e2);
    await expect(updateMachineGuarded({ ...e2, machine_id: null } as Estate, fly as any, () => ({ image: "x" }))).rejects.toThrow(/no machine/);
    expect(fly.log.some((l) => l.startsWith("update"))).toBe(false);
  });
});
