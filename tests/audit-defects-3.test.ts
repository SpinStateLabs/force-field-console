// Second red-team follow-up for PR #1: the tick's suspend retry vs a reactivation, a cancel
// mid-createMachine, the public health endpoint, a stable idempotency key, and mutation guards
// for the lock / compare-and-set / token checks.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import billingHandler from "../netlify/functions/billing.mts";
import healthHandler from "../netlify/functions/health.mts";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { ModelFly, machinesApiHandler } from './model-fly';
import { MemStore, freshStore } from "./helpers";
import { setStoreForTesting } from "../src/lib/store";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { stripeConfig } from "../src/lib/stripe";
import { FlyError } from "../src/lib/fly";
import { advanceSubscriptionMark, claimCheckout, handleStripeEvent, releaseCheckout, retryPendingSuspend, withSubscriptionLock } from "../src/lib/billing";
import { clearSuspendPending, getEstate, queueEstate, saveEstate, suspendEstate, type Estate } from "../src/lib/estates";

const ctx = {} as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

function sub(status: string, userId: string) {
  return { id: "sub_1", status, customer: "cus_1", items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] }, metadata: { user_id: userId } };
}

class SlowFly {
  calls: string[] = [];
  stopDelay = 0;
  startDelay = 0;
  stopFail = false;
  machines: { id: string; name: string }[] = [];
  model = new ModelFly();
  getMachine(a: string, i: string) { return this.model.getMachine(a, i); }
  updateMachine(a: string, i: string, c: any, o?: any) { return this.model.updateMachine(a, i, c, o); }
  waitMachine(a: string, i: string, s: string) { return this.model.waitMachine(a, i, s); }
  async stopMachine(a: string, id: string) {
    this.calls.push("stop " + id);
    await sleep(this.stopDelay);
    if (this.stopFail) throw new FlyError(503, "x", "boom");
    await this.model.stopMachine(a, id);
  }
  async startMachine(a: string, id: string) {
    this.calls.push("start " + id);
    await sleep(this.startDelay);
    await this.model.startMachine(a, id);
  }
  async listMachines() { return this.machines; }
}

class RacingStore extends MemStore {
  hook: (() => Promise<void>) | null = null;
  async getWithEtag(key: string) {
    const r = await super.getWithEtag(key);
    if (this.hook) {
      const h = this.hook;
      this.hook = null;
      await h();
    }
    return r;
  }
}

class CountingStore extends MemStore {
  lists = 0;
  async list(o?: { prefix?: string }) {
    this.lists += 1;
    return super.list(o);
  }
}

const PENDING = { reason: "subscription canceled", since: "2026-01-01T00:00:00.000Z", attempts: 1, last_error: "machine stop failed", next_retry_at: null, failed: false };

let user: User;
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV);
  user = await createUser("a@example.com", "sufficiently-long-pass");
});
afterEach(() => {
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV)]) delete process.env[k];
  delete process.env.URL;
});

async function readyEstate(u: User, over: Partial<Estate> = {}) {
  const e = await queueEstate(u);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` }, over);
  await saveEstate(e);
  return e;
}

async function cancelledBilling(u: User) {
  u.tier = "sandbox";
  u.billing = { customer_id: "cus_1", subscription_id: "sub_1", status: "canceled", price_id: "price_op", tier: "sandbox", current_period_end: null, updated_at: "t" };
  await saveUser(u);
}

describe("MED: the tick's suspend retry cannot override a reactivation", () => {
  it("a retry in flight when 'active' arrives serialises with it: the paying user ends ready, not suspended", async () => {
    await readyEstate(user, { suspend_pending: { ...PENDING } });
    await cancelledBilling(user);
    const webhookFly = new SlowFly();
    const tickModel = new ModelFly();
    tickModel.stopDelay = 80;
    const api = machinesApiHandler(tickModel);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => (await api(String(url), init)) ?? new Response("", { status: 404 })) as any;
    try {
      const tick = tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }));
      await sleep(10);
      await handleStripeEvent({ id: "e_react", type: "customer.subscription.updated", created: 300, data: { object: sub("active", user.id) } }, { cfg: stripeConfig()!, fly: webhookFly as any });
      await tick;
    } finally {
      globalThis.fetch = realFetch;
    }
    await retryPendingSuspend(user.id, webhookFly as any, new Date()); // the webhook queued the resume; the next tick starts it
    const e = (await getEstate(user.id))!;
    expect({ status: e.status, pending: e.suspend_pending ?? null, tier: (await getUserById(user.id))!.tier }).toEqual({ status: "ready", pending: null, tier: "operator" });
    // the machine the tick stopped is started again by the reactivation (the lock ordered them)
    expect(webhookFly.calls).toEqual(["start m_1"]);
  });

  it("the tick re-checks billing before stopping: a paying user's pending flag is cleared and nothing is stopped", async () => {
    await readyEstate(user, { suspend_pending: { ...PENDING } });
    user.tier = "operator";
    user.billing = { customer_id: "cus_1", subscription_id: "sub_1", status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
    await saveUser(user);
    const model = new ModelFly();
    const api = machinesApiHandler(model);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => (await api(String(url), init)) ?? new Response("", { status: 404 })) as any;
    try {
      const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(body.outcomes.resume_retry_ok).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(model.log).not.toContain("stop m_1");
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("ready");
    expect(e.suspend_pending ?? null).toBeNull();
  });

  it("mirror: a retry that FAILS after the flag was cleared does not revive it", async () => {
    await readyEstate(user, { suspend_pending: { ...PENDING } });
    const tickCopy = (await getEstate(user.id))!;
    const model = new ModelFly();
    const fly: any = {
      getMachine: (a: string, i: string) => model.getMachine(a, i),
      updateMachine: (a: string, i: string, c: any, o?: any) => model.updateMachine(a, i, c, o),
      waitMachine: (a: string, i: string, s: string) => model.waitMachine(a, i, s),
      async stopMachine() {
        await clearSuspendPending((await getEstate(user.id))!, "active again");
        throw new FlyError(503, "x", "boom");
      },
    };
    await suspendEstate(tickCopy, fly, new Date(), "retry", { requirePending: true });
    const e = (await getEstate(user.id))!;
    expect(e.suspend_pending ?? null).toBeNull();
    expect(e.status).toBe("ready");
  });
});

describe("LOW a: a cancel while create_machine may be in flight is not marked suspended", () => {
  it("records a pending suspension, then the retry finds the machine on Fly by name, stops it and suspends", async () => {
    const e = await queueEstate(user);
    e.step = "create_machine"; // provisioning, no machine_id yet
    await saveEstate(e);
    const fly = new SlowFly();
    const r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "subscription canceled");
    expect(r.status).toBe("provisioning");
    expect(r.suspend_pending).toBeTruthy();
    expect(fly.calls).toEqual([]);

    fly.machines = [{ id: "m_9", name: "estate" }]; // the in-flight createMachine landed
    const done = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "retry", { requirePending: true });
    expect(done.status).toBe("suspended");
    expect(fly.calls).toEqual(["stop m_9"]);
    const stored = (await getEstate(user.id))!;
    expect(stored.machine_id).toBe("m_9"); // so a later resume can start it
    expect(stored.suspend_pending ?? null).toBeNull();
  });

  it("when no machine ever appeared, the retry suspends without stopping anything", async () => {
    const e = await queueEstate(user);
    e.step = "create_machine";
    await saveEstate(e);
    const fly = new SlowFly();
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    const done = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "retry");
    expect(done.status).toBe("suspended");
    expect(fly.calls).toEqual([]);
  });
});

describe("LOW b: the public health endpoint exposes a boolean and never scans estates", () => {
  it("reads the tick's counter record; no list() on the request path", async () => {
    const cs = new CountingStore();
    setStoreForTesting(cs);
    process.env.SESSION_SECRET = "test-secret-0123456789";
    const u = await createUser("h@example.com", "sufficiently-long-pass");
    await readyEstate(u, { suspend_pending: { ...PENDING, attempts: 10, failed: true } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 404 })) as any;
    try {
      await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }));
    } finally {
      globalThis.fetch = realFetch;
    }
    cs.lists = 0;
    const h = await (await healthHandler(new Request("http://portal.test/api/health"), ctx)).json();
    expect(cs.lists).toBe(0);
    expect(h.suspend_failed).toBe(true);
    expect(h.suspend_failed_estates).toBeUndefined();
  });
});

describe("LOW c: the idempotency key is stable across retries of the same intent", () => {
  it("a failed attempt and its retry send the same Idempotency-Key", async () => {
    process.env.URL = "https://force-field-console.netlify.app";
    const keys: (string | null)[] = [];
    const realFetch = globalThis.fetch;
    let fail = true;
    globalThis.fetch = (async (_u: any, init?: any) => {
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      return fail ? new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 }) : new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }), { status: 200 });
    }) as any;
    const post = async () =>
      billingHandler(new Request("http://portal.test/api/billing/checkout", { method: "POST", headers: { cookie: sessionCookie(await issueSession(user.id)).split(";")[0] }, body: JSON.stringify({ tier: "operator" }) }), ctx);
    try {
      expect((await post()).status).toBe(502);
      fail = false;
      expect((await post()).status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(keys.length).toBe(2);
    expect(keys[0]).toMatch(/^checkout-[0-9a-f]{32}$/);
    expect(keys[1]).toBe(keys[0]);
  });
});

describe("mutation guards: lock, compare-and-set and token checks", () => {
  it("withSubscriptionLock serialises a slow resume with a concurrent cancellation", async () => {
    const e = await readyEstate(user);
    await suspendEstate(e, new SlowFly() as any);
    const fly = new SlowFly();
    fly.startDelay = 80;
    const deps = { cfg: stripeConfig()!, fly: fly as any };
    const act = handleStripeEvent({ id: "ea", type: "customer.subscription.updated", created: 100, data: { object: sub("active", user.id) } }, deps);
    await sleep(10);
    const del = handleStripeEvent({ id: "ed", type: "customer.subscription.deleted", created: 200, data: { object: sub("canceled", user.id) } }, deps);
    await Promise.allSettled([act, del]);
    expect((await getEstate(user.id))!.status).toBe("suspended");
  });

  it("an expired lock is taken over by exactly one waiter (conditional takeover)", async () => {
    const store = (await import("../src/lib/store")).portalStore;
    const st = await store();
    await st.setJSON("stripe_sub_locks/s2", { token: "dead", expires_at: new Date(Date.now() - 1000).toISOString() });
    let active = 0;
    let max = 0;
    const work = async () => {
      active += 1;
      max = Math.max(max, active);
      await sleep(40);
      active -= 1;
    };
    await Promise.all([withSubscriptionLock("s2", work), withSubscriptionLock("s2", work)]);
    expect(max).toBe(1);
  });

  it("releasing a lock never deletes a lock another holder took over", async () => {
    const st = await (await import("../src/lib/store")).portalStore();
    await withSubscriptionLock("s3", async () => {
      await st.setJSON("stripe_sub_locks/s3", { token: "someone-else", expires_at: new Date(Date.now() + 60_000).toISOString() });
    });
    expect((await st.get("stripe_sub_locks/s3"))?.token).toBe("someone-else");
  });

  it("the ordering mark advance is a compare-and-set: a newer mark landing mid-advance wins", async () => {
    const rs = new RacingStore();
    setStoreForTesting(rs);
    expect(await advanceSubscriptionMark("s4", 50, "active", "e0")).toBe(true);
    rs.hook = async () => {
      await rs.setJSON("stripe_subs/s4", { created: 300, status: "canceled", event_id: "e_newer" });
    };
    expect(await advanceSubscriptionMark("s4", 100, "active", "e1")).toBe(false);
    expect((await rs.get("stripe_subs/s4")).created).toBe(300);
  });

  it("releaseCheckout only deletes its own claim", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const a = await claimCheckout(user.id, t0);
    expect(a).toBeTruthy();
    const st = await (await import("../src/lib/store")).portalStore();
    await st.setJSON("checkout_claims/" + user.id, { token: "other-claim", expires_at: new Date(t0.getTime() + 60_000).toISOString() });
    await releaseCheckout(user.id, a!);
    expect(await claimCheckout(user.id, new Date(t0.getTime() + 1000))).toBeNull(); // the other claim is still live
  });

  it("the tick leaves estates with a suspension pending/failed out of provisioning kicks, renewals and health looks", async () => {
    process.env.URL = "https://portal.test";
    await readyEstate(user, { suspend_pending: { ...PENDING, attempts: 10, failed: true }, self_agents: {} }); // renewal due + ready
    const other = await createUser("p@example.com", "sufficiently-long-pass");
    const p = await queueEstate(other); // provisioning
    p.suspend_pending = { ...PENDING, attempts: 10, failed: true };
    await saveEstate(p);
    const kicks: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: any, init?: any) => {
      if (init?.body) kicks.push(JSON.parse(init.body));
      return new Response("", { status: 404 });
    }) as any;
    try {
      const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(kicks).toEqual([]);
      expect(body.outcomes).toEqual({});
      expect(body.suspend_failed).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
