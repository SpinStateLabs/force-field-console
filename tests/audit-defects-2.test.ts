// Red-team follow-up for PR #1: ordering under concurrency, owned-field merges, bounded
// suspend retries, sanitised errors, racing-writer mutation guards.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import billingHandler from "../netlify/functions/billing.mts";
import healthHandler from "../netlify/functions/health.mts";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { MemStore, freshStore } from "./helpers";
import { setStoreForTesting } from "../src/lib/store";
import { createUser, getUserById, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { stripeConfig } from "../src/lib/stripe";
import { FlyError } from "../src/lib/fly";
import { advanceSubscriptionMark, handleStripeEvent } from "../src/lib/billing";
import {
  MAX_SUSPEND_RETRIES,
  advanceEstate,
  checkEstateHealth,
  clearSuspendPending,
  estateKey,
  getEstate,
  publicEstate,
  queueEstate,
  saveEstate,
  suspendEstate,
} from "../src/lib/estates";

const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

function sub(over: Partial<any> = {}, userId?: string) {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] },
    metadata: userId ? { user_id: userId } : {},
    ...over,
  };
}

class StopFly {
  calls: string[] = [];
  stopError: Error | null = null;
  async stopMachine(app: string, id: string) {
    this.calls.push(`stop ${app} ${id}`);
    if (this.stopError) throw this.stopError;
  }
  async startMachine(app: string, id: string) { this.calls.push(`start ${app} ${id}`); }
}

/** A store that lets a test land a competing write between a caller's read and its write. */
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

async function readyEstateFor(u: User) {
  const e = await queueEstate(u);
  e.status = "ready";
  e.step = "done";
  e.machine_id = "m_1";
  e.volume_id = "vol_1";
  e.url = `https://${e.app}.fly.dev`;
  await saveEstate(e);
  return e;
}

describe("HIGH 2: subscription ordering is a serialised compare-and-set", () => {
  let user: User;
  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, STRIPE_ENV);
    user = await createUser("race@example.com", "sufficiently-long-pass");
  });
  afterEach(() => {
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  });

  const ev = (id: string, type: string, created: number, status: string) => ({ id, type, created, data: { object: sub({ status }, user.id) } });

  for (const order of ["deleted-first", "active-first"] as const) {
    it(`deleted(200) and a late active(100) delivered concurrently (${order}) end cancelled`, async () => {
      user.tier = "operator";
      const { saveUser } = await import("../src/lib/users");
      await saveUser(user);
      await readyEstateFor(user);
      const deps = { cfg: stripeConfig()!, fly: new StopFly() as any };
      const del = () => handleStripeEvent(ev("e_del", "customer.subscription.deleted", 200, "canceled"), deps);
      const act = () => handleStripeEvent(ev("e_act", "customer.subscription.updated", 100, "active"), deps);
      const batch = order === "deleted-first" ? [del(), act()] : [act(), del()];
      await Promise.allSettled(batch);
      // anything that lost the lock is redelivered by Stripe
      await Promise.allSettled([del().catch(() => null), act().catch(() => null)]);
      expect((await getUserById(user.id))!.tier).toBe("sandbox");
      expect((await getEstate(user.id))!.status).toBe("suspended");
    });
  }

  it("checkout.session.completed is ordered by the same mark: a stale one cannot resume a cancelled subscription", async () => {
    await readyEstateFor(user);
    const deps = {
      cfg: stripeConfig()!,
      fly: new StopFly() as any,
      fetchImpl: (async () => new Response(JSON.stringify(sub({ status: "active" }, user.id)), { status: 200 })) as any,
    };
    await handleStripeEvent(ev("e_del", "customer.subscription.deleted", 200, "canceled"), deps);
    const r = await handleStripeEvent(
      { id: "e_co", type: "checkout.session.completed", created: 100, data: { object: { mode: "subscription", subscription: "sub_1", customer: "cus_1", client_reference_id: user.id } } },
      deps,
    );
    expect(r.handled).toBe(false);
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
  });

  it("a redelivery of the SAME event after a failed apply is not mistaken for a stale one", async () => {
    expect(await advanceSubscriptionMark("sub_9", 200, "canceled", "evt_a")).toBe(true);
    expect(await advanceSubscriptionMark("sub_9", 200, "canceled", "evt_a")).toBe(true);
    expect(await advanceSubscriptionMark("sub_9", 100, "active", "evt_b")).toBe(false);
  });
});

describe("HIGH 1: a stored value without an etag is an error, never 'absent'", () => {
  it("is covered in store.test.ts (adapter throws)", () => {
    expect(true).toBe(true);
  });
});

describe("MED 3: authoritative writes merge only the fields they own", () => {
  let user: User;
  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    user = await createUser("own@example.com", "sufficiently-long-pass");
  });
  afterEach(() => {
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
  });

  it("suspend from a stale copy keeps the worker's step and its live lease", async () => {
    await queueEstate(user);
    const stale = (await getEstate(user.id))!;
    const worker = (await getEstate(user.id))!;
    worker.step = "allocate_ips";
    worker.lease_until = new Date(Date.now() + 25_000).toISOString();
    await saveEstate(worker);
    await suspendEstate(stale, null, new Date(), "canceled");
    const stored = (await getEstate(user.id))!;
    expect(stored.status).toBe("suspended");
    expect(stored.step).toBe("allocate_ips");
    expect(stored.lease_until).toBe(worker.lease_until);
    expect(stored.suspended_from).toBe("provisioning");
  });

  it("clearing a pending suspension from a stale copy does not roll a ready estate back to provisioning", async () => {
    const e = await queueEstate(user);
    e.suspend_pending = { reason: "x", since: new Date().toISOString(), attempts: 1, last_error: "machine stop failed", next_retry_at: null, failed: false };
    await saveEstate(e);
    const stale = (await getEstate(user.id))!; // status provisioning
    const worker = (await getEstate(user.id))!;
    worker.status = "ready";
    worker.step = "done";
    worker.machine_id = "m_1";
    await saveEstate(worker);
    await clearSuspendPending(stale, "active again");
    const stored = (await getEstate(user.id))!;
    expect(stored.suspend_pending).toBeNull();
    expect(stored.status).toBe("ready");
    expect(stored.machine_id).toBe("m_1");
  });
});

describe("MED 4/5: bounded, backed-off, sanitised suspend retries", () => {
  let user: User;
  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    user = await createUser("cap@example.com", "sufficiently-long-pass");
  });
  afterEach(() => {
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
    delete process.env.URL;
  });

  const rawMsg = "Fly POST /apps/ff-est-abc/machines/m_1/stop answered HTTP 500: internal detail";

  it("treats a Fly 404 on stop as already stopped", async () => {
    await readyEstateFor(user);
    const fly = new StopFly();
    fly.stopError = new FlyError(404, "Fly POST /apps/x/machines/m_1/stop answered HTTP 404");
    const r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    expect(r.status).toBe("suspended");
    expect(r.suspend_pending ?? null).toBeNull();
  });

  it("never shows Fly paths or raw errors through publicEstate, in the pending record, health or log", async () => {
    await readyEstateFor(user);
    const fly = new StopFly();
    fly.stopError = new Error(rawMsg);
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    const shown = JSON.stringify(publicEstate((await getEstate(user.id))!));
    expect(shown).not.toContain("/apps/");
    expect(shown).not.toContain("HTTP 500");
    expect(shown).not.toContain("internal detail");
    expect(shown).toMatch(/suspend pending/i);
  });

  it("backs off, caps at MAX_SUSPEND_RETRIES, then marks suspend_failed and the tick stops retrying", async () => {
    await readyEstateFor(user);
    const fly = new StopFly();
    fly.stopError = new Error(rawMsg);
    const t0 = new Date();
    let e = (await getEstate(user.id))!;
    e = await suspendEstate(e, fly as any, t0, "canceled");
    expect(e.suspend_pending!.next_retry_at).toBeTruthy();
    expect(new Date(e.suspend_pending!.next_retry_at!).getTime()).toBeGreaterThan(t0.getTime());

    // inside the backoff window the tick does not retry
    process.env.URL = "https://portal.test";
    const stops: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      if (init?.method === "POST" && String(url).includes("/stop")) stops.push(String(url));
      return new Response("boom", { status: 500 });
    }) as any;
    try {
      let body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(stops.length).toBe(0);
      expect(body.outcomes.suspend_retry_failed ?? 0).toBe(0);

      for (let i = 1; i < MAX_SUSPEND_RETRIES; i++) e = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(t0.getTime() + i * 3_600_000), "canceled");
      expect(e.suspend_pending!.attempts).toBe(MAX_SUSPEND_RETRIES);
      expect(e.suspend_pending!.failed).toBe(true);
      expect(e.health?.note).toMatch(/suspend failed/i);
      expect(e.status).toBe("ready"); // still not claimed suspended
      stops.length = 0;
      body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(stops.length).toBe(0);
      expect(body.suspend_failed).toBe(1);

      // surfaced in /api/health
      const h = await (await healthHandler(new Request("http://portal.test/api/health"), ctx)).json();
      expect(h.suspend_failed).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("LOW 6: checkout session creation carries a Stripe idempotency key", () => {
  it("sends Idempotency-Key derived from the claim token", async () => {
    freshStore();
    Object.assign(process.env, STRIPE_ENV);
    process.env.URL = "https://force-field-console.netlify.app";
    const user = await createUser("idem@example.com", "sufficiently-long-pass");
    let key: string | null = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: any, init?: any) => {
      key = new Headers(init?.headers).get("idempotency-key");
      return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }), { status: 200 });
    }) as any;
    try {
      const res = await billingHandler(
        new Request("http://portal.test/api/billing/checkout", {
          method: "POST",
          headers: { cookie: sessionCookie(await issueSession(user.id)).split(";")[0] },
          body: JSON.stringify({ tier: "operator" }),
        }),
        ctx,
      );
      expect(res.status).toBe(200);
      expect(key).toMatch(/^checkout-[0-9a-f]{32}$/);
    } finally {
      globalThis.fetch = realFetch;
      for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
      delete process.env.URL;
    }
  });
});

describe("mutation guards (each of these goes red when its guard is reverted)", () => {
  let user: User;
  let rs: RacingStore;
  beforeEach(async () => {
    rs = new RacingStore();
    setStoreForTesting(rs);
    process.env.SESSION_SECRET = "test-secret-0123456789";
    Object.assign(process.env, FLY_ENV);
    user = await createUser("mut@example.com", "sufficiently-long-pass");
  });
  afterEach(() => {
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
  });

  it("(a) saveEstate is a conditional write: a suspend landing between its read and its write still wins", async () => {
    await queueEstate(user);
    const worker = (await getEstate(user.id))!;
    worker.step = "allocate_ips";
    rs.hook = async () => {
      const cur = await rs.get(estateKey(user.id));
      cur.status = "suspended";
      cur.suspended_from = "provisioning";
      cur.suspended_at = new Date().toISOString();
      await rs.setJSON(estateKey(user.id), cur);
    };
    await saveEstate(worker);
    const stored = (await getEstate(user.id))!;
    expect(stored.status).toBe("suspended");
    expect(stored.step).toBe("allocate_ips");
  });

  it("(b) advanceEstate does not provision further while a suspension is pending", async () => {
    const e = await queueEstate(user);
    e.suspend_pending = { reason: "x", since: new Date().toISOString(), attempts: 1, last_error: "machine stop failed", next_retry_at: null, failed: false };
    await saveEstate(e);
    let created = 0;
    const fly: any = { async createApp() { created += 1; } };
    const r = await advanceEstate((await getEstate(user.id))!, fly);
    expect(r.outcome).toBe("idle");
    expect(created).toBe(0);
  });

  it("(c) checkEstateHealth skips an estate with a pending suspension and leaves its health flag alone", async () => {
    const e = await readyEstateFor(user);
    e.suspend_pending = { reason: "x", since: new Date().toISOString(), attempts: 1, last_error: "machine stop failed", next_retry_at: null, failed: false };
    e.health = { ok: false, checked_at: new Date().toISOString(), note: "suspend pending: machine stop failed; retrying" };
    await saveEstate(e);
    let looked = 0;
    const fly: any = { async getApp() { looked += 1; return { name: "app" }; } };
    const out = await checkEstateHealth((await getEstate(user.id))!, fly, { fetchImpl: (async () => new Response(JSON.stringify({ ok: true, appendable: true }), { status: 200 })) as any });
    expect(out).toBe("skipped");
    expect(looked).toBe(0);
    expect((await getEstate(user.id))!.health?.ok).toBe(false);
  });
});
