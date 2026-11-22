// Review #29 r4 (F1/F2/F3): ONE rule for every driver that creates, resumes, revives or releases an estate: the
// user's current subscription is ACTIVE and has its own paid invoice (paid_subscriptions/<sub>). The webhook already
// obeyed it (X2); these tests drive the scheduled tick and the hand-over, which did not.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { ModelFly, machinesApiHandler } from "./model-fly";
import { freshStore, type MemStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent, mayRunEstate, retryPendingSuspend } from "../src/lib/billing";
import { getEstate, queueEstate, readback, saveEstate, type Estate } from "../src/lib/estates";

const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };
let store: MemStore;
let user: User;
let fly: ModelFly;
const origDelay = readback.delayMs;

function sub(id: string, status: string) {
  return { id, status, customer: "cus_1", items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] }, metadata: { user_id: user.id } };
}
const ev = (id: string, type: string, created: number, s: any, livemode = true) => ({ id, type, created, livemode, data: { object: s } });
/** Stripe stand-in for the hand-over's verification read of a remembered subscription. */
const stripeKnows = (subs: any[]) =>
  (async (url: string) => {
    const s = subs.find((x) => new URL(url).pathname === "/v1/subscriptions/" + x.id);
    return new Response(JSON.stringify(s ?? { error: { message: "no" } }), { status: s ? 200 : 404, headers: { "content-type": "application/json" } });
  }) as any;
const deps = (fetchImpl?: any) => ({ cfg: stripeConfig()!, fly: fly as any, ...(fetchImpl ? { fetchImpl } : {}) });
const paid = (id: string) => store.setJSON("paid_subscriptions/" + id, { customer: "cus_1", first_paid_invoice: "in_" + id, at: "2026-11-01T00:00:00Z" });

beforeEach(async () => {
  store = freshStore();
  await paid("sub_A"); // the ex-customer's old subscription paid; sub_B (the new one) has NOT unless a test says so
  Object.assign(process.env, STRIPE_ENV, FLY_ENV);
  readback.delayMs = 3;
  user = await createUser("drivers@example.com", "sufficiently-long-pass");
  fly = new ModelFly();
});
afterEach(() => {
  readback.delayMs = origDelay;
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV)]) delete process.env[k];
});

async function payingOn(subId: string, status = "active") {
  user.tier = "operator";
  user.billing = { customer_id: "cus_1", subscription_id: subId, status, price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
  await saveUser(user);
}
async function readyEstate(over: Partial<Estate> = {}) {
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` }, over);
  await saveEstate(e);
  fly.machine("m_1");
  return e;
}
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
/** An ex-customer: paid sub_A, ready estate, sub_A cancelled (the estate is suspended, the machine stopped). */
async function exCustomer() {
  await payingOn("sub_A");
  await readyEstate();
  await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
  const e = (await getEstate(user.id))!;
  expect(e.status).toBe("suspended");
  expect(fly.machine("m_1").state).toBe("stopped");
}

describe("F1: the scheduled tick never resumes an estate for an unpaid subscription", () => {
  it.each(["trialing", "active"])("ex-customer starts sub_B %s with no paid invoice: the webhook declines AND the tick leaves it suspended", async (status) => {
    await exCustomer();
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 300, sub("sub_B", status)), deps());
    const u = (await getUserById(user.id))!;
    expect(u.billing).toMatchObject({ subscription_id: "sub_B", status });
    expect(u.tier).toBe("operator");
    await tick();
    await tick();
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("suspended");
    expect(e.resume_pending ?? null).toBeNull();
    expect(fly.machine("m_1").state).toBe("stopped");
  });

  it("retryPendingSuspend (the tick's per-estate step) does not resume it either", async () => {
    await exCustomer();
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 300, sub("sub_B", "trialing")), deps());
    const r = await retryPendingSuspend(user.id, fly as any, new Date());
    expect(r.outcome).not.toBe("resumed");
    expect((await getEstate(user.id))!.status).toBe("suspended");
    expect(fly.machine("m_1").state).toBe("stopped");
  });

  it("control: once sub_B's own invoice is paid, the estate resumes (webhook queues it, the tick starts it)", async () => {
    await exCustomer();
    await paid("sub_B");
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 300, sub("sub_B", "active")), deps());
    await tick();
    expect((await getEstate(user.id))!.status).toBe("ready");
    expect(fly.machine("m_1").state).toBe("started");
  });

  it("mayRunEstate is the one rule: active AND this subscription paid", async () => {
    await payingOn("sub_A", "active");
    expect(await mayRunEstate(await getUserById(user.id))).toBe(true);
    await payingOn("sub_A", "trialing");
    expect(await mayRunEstate(await getUserById(user.id))).toBe(false);
    await payingOn("sub_A", "past_due");
    expect(await mayRunEstate(await getUserById(user.id))).toBe(false);
    await payingOn("sub_B", "active");
    expect(await mayRunEstate(await getUserById(user.id))).toBe(false);
    expect(await mayRunEstate(null)).toBe(false);
  });
});

describe("F2: hand-over to an unpaid remembered subscription suspends the running estate", () => {
  it.each(["trialing", "active"])("paid sub_A cancelled while unpaid sub_B (%s) waits: B is adopted and the ready estate is suspended", async (status) => {
    await payingOn("sub_A");
    await readyEstate();
    const subB = sub("sub_B", status);
    const r1 = await handleStripeEvent(ev("b_new", "customer.subscription.created", 150, subB), deps(stripeKnows([subB])));
    expect(r1.handled).toBe(false); // tracked only: sub_A is current and grants
    expect((await getUserById(user.id))!.billing?.other_subs?.sub_B).toBeTruthy();
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps(stripeKnows([subB])));
    const u = (await getUserById(user.id))!;
    expect(u.billing).toMatchObject({ subscription_id: "sub_B", status });
    const e = (await getEstate(user.id))!;
    expect(e.status === "suspended" || Boolean(e.suspend_pending)).toBe(true);
    await tick();
    expect((await getEstate(user.id))!.status).toBe("suspended");
    expect(fly.machine("m_1").state).toBe("stopped");
  });

  it("control: hand-over to a PAID sub_B keeps the estate running", async () => {
    await payingOn("sub_A");
    await readyEstate();
    await paid("sub_B");
    const subB = sub("sub_B", "active");
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 150, subB), deps(stripeKnows([subB])));
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps(stripeKnows([subB])));
    expect((await getEstate(user.id))!.status).toBe("ready");
    expect(fly.machine("m_1").state).toBe("started");
  });
});

describe("F3: a test-held record is never released by an unpaid live subscription", () => {
  it("test-mode grant on paid sub_A holds the record; sub_A ends; live unpaid sub_B active keeps the hold and the tick provisions nothing", async () => {
    await handleStripeEvent(ev("a_new", "customer.subscription.created", 100, sub("sub_A", "active"), false), deps());
    const held = (await getEstate(user.id))!;
    expect(held).toMatchObject({ status: "pending_manual", test_hold: true });
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled"), false), deps());
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 300, sub("sub_B", "active")), deps());
    expect((await getUserById(user.id))!.billing).toMatchObject({ subscription_id: "sub_B", status: "active" });
    const after = (await getEstate(user.id))!;
    expect(after.test_hold).toBe(true);
    expect(after.status).toBe("pending_manual");
    await tick();
    const t = (await getEstate(user.id))!;
    expect(t.test_hold).toBe(true);
    expect(t.machine_id ?? null).toBeNull();
  });

  it("control: the same with a PAID live sub_B releases the hold", async () => {
    await handleStripeEvent(ev("a_new", "customer.subscription.created", 100, sub("sub_A", "active"), false), deps());
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled"), false), deps());
    await paid("sub_B");
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 300, sub("sub_B", "active")), deps());
    expect((await getEstate(user.id))!.test_hold ?? false).toBe(false);
  });
});
