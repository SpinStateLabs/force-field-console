// Third review of the durable-suspend PR: a re-grant must reconcile the REAL machine (never just clear
// a flag), a failed resume is retried by the tick and surfaced, adoption checks the customer, failed
// suspensions are retried slowly, a stale lock is reported.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import tickHandler from "../netlify/functions/estate-tick.mts";
import healthHandler from "../netlify/functions/health.mts";
import { ModelFly, machinesApiHandler } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent, retryPendingSuspend } from "../src/lib/billing";
import { MAX_RESUME_RETRIES, SLOW_RETRY_MS, getEstate, publicEstate, queueEstate, readback, saveEstate, suspendEstate, type Estate } from "../src/lib/estates";
import { SUB_LOCK_TTL_MS } from "../src/lib/locks";
import { portalStore } from "../src/lib/store";

const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };

let user: User;
let fly: ModelFly;
let statuses: Record<string, string>;
let candidateOverride: Record<string, any> = {};
const origDelay = readback.delayMs;

function sub(id: string, status: string, over: any = {}) {
  return { id, status, customer: "cus_1", items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] }, metadata: { user_id: user.id }, ...over };
}
const ev = (id: string, type: string, created: number, s: any) => ({ id, type, created, data: { object: s } });
const fetchImpl = (async (u: any) => {
  const id = String(u).split("/").pop()!;
  return new Response(JSON.stringify(sub(id, statuses[id] ?? "canceled", candidateOverride[id] ?? {})), { status: 200 });
}) as any;
const deps = () => ({ cfg: stripeConfig()!, fly: fly as any, fetchImpl });

beforeEach(async () => {
  freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV);
  readback.delayMs = 3;
  user = await createUser("rec@example.com", "sufficiently-long-pass");
  fly = new ModelFly();
  statuses = {};
  candidateOverride = {};
});
afterEach(() => {
  readback.delayMs = origDelay;
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV)]) delete process.env[k];
  delete process.env.URL;
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
  fly.machine("m_1");
  return e;
}
const final = async () => {
  const e = (await getEstate(user.id))!;
  const u = (await getUserById(user.id))!;
  return { estate: e.status, pending: e.suspend_pending ?? null, sub: u.billing?.subscription_id, tier: u.tier, machine: fly.machine("m_1").state, autostartOff: fly.autostartOff("m_1") };
};
/** Run the real tick against the model (the Machines API behind globalThis.fetch). */
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

describe("MED a: a re-grant reconciles the real machine instead of clearing the flag", () => {
  it("the wait times out after the stop (machine stopped, autostart off, flag pending); then B is created: the estate must be RUNNING", async () => {
    await payingOn("sub_A");
    await readyEstate();
    fly.waitNever = true;
    statuses.sub_A = "canceled";
    statuses.sub_B = "active";
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
    expect(await final()).toMatchObject({ estate: "ready", machine: "stopped", autostartOff: true });
    expect((await getEstate(user.id))!.suspend_pending).toBeTruthy();
    fly.waitNever = false;
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 250, sub("sub_B", "active")), deps());
    expect(await final()).toMatchObject({ estate: "ready", machine: "started", autostartOff: false, pending: null, sub: "sub_B", tier: "operator" });
    expect(fly.ping("m_1")).toBe("started");
  });

  it("same when the SAME subscription is reactivated", async () => {
    await payingOn("sub_A");
    await readyEstate();
    fly.waitNever = true;
    statuses.sub_A = "canceled";
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
    fly.waitNever = false;
    statuses.sub_A = "active";
    await handleStripeEvent(ev("a_upd", "customer.subscription.updated", 300, sub("sub_A", "active")), deps());
    expect(await final()).toMatchObject({ estate: "ready", machine: "started", autostartOff: false, pending: null });
  });

  it("the tick does the same when no further Stripe event comes (paying user, flagged estate, dead machine)", async () => {
    await payingOn("sub_A");
    await readyEstate({ suspend_pending: { reason: "x", since: "2026-01-01T00:00:00.000Z", attempts: 1, last_error: "machine stop failed", next_retry_at: null, failed: false } });
    fly.machine("m_1", { state: "stopped" }).config.services[0].autostart = false;
    const body = await tick();
    expect(body.outcomes.resume_retry_ok).toBe(1);
    expect(await final()).toMatchObject({ estate: "ready", machine: "started", autostartOff: false, pending: null });
  });
});

describe("MED b: a resume that failed to start is retried by the tick, bounded, and surfaced", () => {
  async function suspendedPayingAfterFailedResume() {
    await payingOn("sub_A");
    await readyEstate();
    statuses.sub_A = "canceled";
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
    expect((await getEstate(user.id))!.status).toBe("suspended");
    fly.failStart = true;
    statuses.sub_B = "active";
    await expect(handleStripeEvent(ev("b_new", "customer.subscription.created", 250, sub("sub_B", "active")), deps())).rejects.toThrow();
    expect(await final()).toMatchObject({ estate: "suspended", machine: "stopped", autostartOff: true, sub: "sub_B", tier: "operator" });
  }

  it("the tick resumes the paying customer's estate once Fly can start the machine", async () => {
    await suspendedPayingAfterFailedResume();
    fly.failStart = false;
    const body = await tick();
    expect(body.outcomes.resume_retry_ok).toBe(1);
    expect(await final()).toMatchObject({ estate: "ready", machine: "started", autostartOff: false });
    expect((await getEstate(user.id))!.resume_pending ?? null).toBeNull();
  });

  it("while Fly keeps failing: backoff, a cap, then resume_failed in /api/health and the public estate, with no Fly detail text", async () => {
    await suspendedPayingAfterFailedResume();
    const first = await tick();
    expect(first.outcomes.resume_retry_failed).toBe(1);
    let e = (await getEstate(user.id))!;
    expect(e.resume_pending!.attempts).toBe(1);
    expect(e.health?.note).toMatch(/resume pending/);
    // inside the backoff window the next tick leaves it alone
    const second = await tick();
    expect(second.outcomes.resume_retry_failed ?? 0).toBe(0);
    expect((await getEstate(user.id))!.resume_pending!.attempts).toBe(1);
    // exhaust the retries (time moves on)
    for (let i = 1; i < MAX_RESUME_RETRIES; i++) await retryPendingSuspend(user.id, fly as any, new Date(Date.now() + i * 3_600_000));
    e = (await getEstate(user.id))!;
    expect(e.resume_pending!.failed).toBe(true);
    expect(e.resume_pending!.next_retry_at).toBeTruthy(); // slow retry, bounded
    expect(e.health?.note).toMatch(/resume failed/);
    await tick(); // writes the counter
    const h = await (await healthHandler(new Request("http://portal.test/api/health"), ctx)).json();
    expect(h.resume_failed).toBe(true);
    const shown = JSON.stringify(publicEstate((await getEstate(user.id))!));
    expect(shown).not.toMatch(/HTTP|answered|\/apps\/|503/);
    expect(await final()).toMatchObject({ estate: "suspended", machine: "stopped", autostartOff: true });
  });
});

describe("LOW: hand-over candidates must belong to the customer and the user", () => {
  for (const [name, over] of [
    ["another customer", { customer: "cus_OTHER" }],
    ["another user in the metadata", { metadata: { user_id: "someone-else" } }],
  ] as const) {
    it(`a remembered subscription that Stripe returns under ${name} is not adopted: the cancellation suspends`, async () => {
      await payingOn("sub_A");
      await readyEstate();
      statuses.sub_B = "active";
      await handleStripeEvent(ev("b_new", "customer.subscription.created", 110, sub("sub_B", "active")), deps());
      statuses.sub_A = "canceled";
      candidateOverride.sub_B = over;
      await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled")), deps());
      const u = (await getUserById(user.id))!;
      expect(u.billing!.customer_id).toBe("cus_1");
      expect(u.billing!.subscription_id).toBe("sub_A");
      expect((await getEstate(user.id))!.status).toBe("suspended");
    });
  }
});

describe("LOW: failed suspensions are retried slowly, boundedly", () => {
  const failedPending = (next: string | null) => ({ reason: "canceled", since: "2026-01-01T00:00:00.000Z", attempts: 12, last_error: "machine stop failed", next_retry_at: next, failed: true });

  it("a failed suspension whose slow-retry time has come is retried by the tick (and completes)", async () => {
    await readyEstate({ suspend_pending: failedPending(new Date(Date.now() - 1000).toISOString()) });
    const body = await tick();
    expect(body.outcomes.suspend_retry_ok).toBe(1);
    expect(await final()).toMatchObject({ estate: "suspended", machine: "stopped", autostartOff: true, pending: null });
  });

  it("one whose slow retries are used up (next_retry_at null) is left for the operator", async () => {
    await readyEstate({ suspend_pending: failedPending(null) });
    const body = await tick();
    expect(body.outcomes.suspend_retry_ok ?? 0).toBe(0);
    expect(body.suspend_failed).toBe(1);
    expect((await getEstate(user.id))!.status).toBe("ready");
  });

  it("the first failure past the cap schedules the slow retry", async () => {
    await readyEstate();
    fly.failStop = true;
    let r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    for (let i = 1; i < 10; i++) r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(Date.now() + i * 3_600_000), "canceled");
    expect(r.suspend_pending!.failed).toBe(true);
    const next = new Date(r.suspend_pending!.next_retry_at!).getTime();
    expect(next).toBeGreaterThan(Date.now() + 9 * 3_600_000 + SLOW_RETRY_MS - 60_000);
  });
});

describe("LOW: a stale user lock is reported by the tick", () => {
  it("a lock held for minutes (killed webhook) makes the due retry report lock_busy and lock_stale", async () => {
    await payingOn("sub_A");
    await readyEstate({ suspend_pending: { reason: "x", since: "2026-01-01T00:00:00.000Z", attempts: 1, last_error: "machine stop failed", next_retry_at: null, failed: false } });
    // acquired ~4.5 minutes ago, expires in 30 s
    await (await portalStore()).setJSON("user_locks/" + user.id, { token: "dead-webhook", expires_at: new Date(Date.now() + 30_000).toISOString() });
    expect(SUB_LOCK_TTL_MS).toBeGreaterThan(4 * 60_000);
    const body = await tick();
    expect(body.outcomes.lock_busy).toBe(1);
    expect(body.outcomes.lock_stale).toBe(1);
  }, 15000);
});

describe("survivors of earlier rounds", () => {
  it("M13: an adopted subscription does not stay in other_subs", async () => {
    user.tier = "sandbox";
    user.billing = { customer_id: "cus_1", subscription_id: "sub_A", status: "canceled", price_id: "price_op", tier: "sandbox", current_period_end: null, updated_at: "t", other_subs: { sub_B: { status: "active", price_id: "price_op" } } };
    await saveUser(user);
    await readyEstate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    fly.machine("m_1", { state: "stopped" });
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 250, sub("sub_B", "active")), deps());
    const b = (await getUserById(user.id))!.billing!;
    expect(b.subscription_id).toBe("sub_B");
    expect(b.other_subs ?? {}).toEqual({});
  });

  it("M15: the tick retries a SUSPENDED estate whose pending flag came from a failed resume rollback", async () => {
    // not paying; suspended; the machine was left started with autostart on by a failed rollback
    await readyEstate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z", suspend_pending: { reason: "resume failed", since: "2026-01-01T00:00:00.000Z", attempts: 0, last_error: "machine stop failed", next_retry_at: null, failed: false } });
    const body = await tick();
    expect(body.outcomes.suspend_retry_ok).toBe(1);
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("suspended");
    expect(e.suspend_pending ?? null).toBeNull();
    expect(fly.machine("m_1").state).toBe("stopped");
    expect(fly.autostartOff("m_1")).toBe(true);
  });
});
