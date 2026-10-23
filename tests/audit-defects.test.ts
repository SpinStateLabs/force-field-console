// Regression tests for the 2026-10 audit defects (billing ordering, suspend failure,
// blind estate writes, concurrent checkouts, stale-claim takeover, advance 501).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import billingHandler from "../netlify/functions/billing.mts";
import estateHandler from "../netlify/functions/estate.mts";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { freshStore } from "./helpers";
import { createUser, getUserById, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { stripeConfig } from "../src/lib/stripe";
import { STALE_CLAIM_MS, claimEvent, handleStripeEvent } from "../src/lib/billing";
import { getEstate, publicEstate, queueEstate, resolveRoute, resumeEstate, saveEstate, suspendEstate, advanceEstate } from "../src/lib/estates";

const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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
  stopFails = false;
  async stopMachine(app: string, id: string) {
    this.calls.push(`stop ${app} ${id}`);
    if (this.stopFails) throw new Error("fly 503");
  }
  async startMachine(app: string, id: string) { this.calls.push(`start ${app} ${id}`); }
}

async function readyEstateFor(u: User, machine = "m_1") {
  const e = await queueEstate(u);
  e.status = "ready";
  e.step = "done";
  e.machine_id = machine;
  e.volume_id = "vol_1";
  e.url = `https://${e.app}.fly.dev`;
  await saveEstate(e);
  return e;
}

describe("defect 1: subscription events are ordered", () => {
  let user: User;
  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, STRIPE_ENV);
    user = await createUser("order@example.com", "sufficiently-long-pass");
  });
  afterEach(() => {
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  });

  const ev = (id: string, type: string, created: number, over: Partial<any> = {}) => ({
    id,
    type,
    created,
    data: { object: sub(over, user.id) },
  });

  it("a late 'active' after 'deleted' does not resume a cancelled estate", async () => {
    user.tier = "operator";
    const e = await readyEstateFor(user);
    const fly = new StopFly();
    const deps = { cfg: stripeConfig()!, fly: fly as any };
    await handleStripeEvent(ev("e_del", "customer.subscription.deleted", 200, { status: "canceled" }), deps);
    expect((await getEstate(user.id))!.status).toBe("suspended");

    const late = await handleStripeEvent(ev("e_act", "customer.subscription.updated", 100, { status: "active" }), deps);
    expect(late.handled).toBe(false);
    expect(late.note).toMatch(/stale|out of order/i);
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
    expect((await getEstate(user.id))!.status).toBe("suspended");
    expect(fly.calls).toEqual([`stop ${e.app} m_1`]); // never started again
  });

  it("an event in the same second as the cancellation does not undo it either", async () => {
    await readyEstateFor(user);
    const deps = { cfg: stripeConfig()!, fly: new StopFly() as any };
    await handleStripeEvent(ev("e_del", "customer.subscription.deleted", 200, { status: "canceled" }), deps);
    const tie = await handleStripeEvent(ev("e_act", "customer.subscription.updated", 200, { status: "active" }), deps);
    expect(tie.handled).toBe(false);
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
  });

  it("newer events still apply in order, and the high-water mark is per subscription", async () => {
    const deps = { cfg: stripeConfig()!, fly: null };
    await handleStripeEvent(ev("a", "customer.subscription.updated", 100, { status: "active" }), deps);
    expect((await getUserById(user.id))!.tier).toBe("operator");
    await handleStripeEvent(ev("b", "customer.subscription.updated", 300, { status: "unpaid" }), deps);
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
    // another subscription id has its own mark
    const other = await handleStripeEvent({ id: "c", type: "customer.subscription.updated", created: 50, data: { object: sub({ id: "sub_2", status: "active" }, user.id) } }, deps);
    expect(other.handled).toBe(true);
    expect((await getUserById(user.id))!.tier).toBe("operator");
  });
});

describe("defect 2: a failed stop never marks the estate suspended", () => {
  let user: User;
  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV, STRIPE_ENV);
    user = await createUser("stop@example.com", "sufficiently-long-pass");
  });
  afterEach(() => {
    for (const k of [...Object.keys(FLY_ENV), ...Object.keys(STRIPE_ENV)]) delete process.env[k];
    delete process.env.URL;
  });

  it("records suspend_pending, keeps the gateway refusing, surfaces it in health, and a retry completes the suspension", async () => {
    const e = await readyEstateFor(user);
    const fly = new StopFly();
    fly.stopFails = true;
    const r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "subscription canceled");
    expect(r.status).not.toBe("suspended");
    expect((r as any).suspend_pending).toMatchObject({ reason: "subscription canceled" });
    const stored = (await getEstate(user.id))!;
    expect(stored.status).toBe("ready");
    expect((stored as any).suspend_pending).toBeTruthy();
    expect(stored.health?.ok).toBe(false);
    expect(stored.health?.note).toMatch(/suspend pending/i);
    expect((publicEstate(stored) as any).suspend_pending).toBeTruthy();
    expect(resolveRoute(user, stored)).toMatchObject({ kind: "refuse", status: 403, code: "estate_suspended" });

    fly.stopFails = false;
    const done = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "retry");
    expect(done.status).toBe("suspended");
    expect((done as any).suspend_pending).toBeNull();
    expect(fly.calls.filter((c) => c.startsWith("stop")).length).toBe(2);
    expect(e.app).toBeTruthy();
  });

  it("the tick retries a pending suspension and reports it", async () => {
    await readyEstateFor(user);
    const failing = new StopFly();
    failing.stopFails = true;
    await suspendEstate((await getEstate(user.id))!, failing as any, new Date(), "subscription canceled");

    const stops: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      const u = String(url);
      if (init?.method === "POST" && u.includes("/machines/m_1/stop")) {
        stops.push(u);
        return new Response("{}", { status: 200 });
      }
      return new Response("", { status: 404 });
    }) as any;
    try {
      const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(stops.length).toBe(1);
      expect(body.outcomes.suspend_retry_ok).toBe(1);
      expect((await getEstate(user.id))!.status).toBe("suspended");
      expect(((await getEstate(user.id)) as any).suspend_pending).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a failed stop on subscription.deleted leaves the estate un-suspended but refusing; reactivation clears the pending flag", async () => {
    user.tier = "operator";
    await readyEstateFor(user);
    const fly = new StopFly();
    fly.stopFails = true;
    const deps = { cfg: stripeConfig()!, fly: fly as any };
    await handleStripeEvent({ id: "d", type: "customer.subscription.deleted", created: 10, data: { object: sub({ status: "canceled" }, user.id) } }, deps);
    let cur = (await getEstate(user.id))!;
    expect(cur.status).toBe("ready");
    expect((cur as any).suspend_pending).toBeTruthy();
    await handleStripeEvent({ id: "r", type: "customer.subscription.updated", created: 20, data: { object: sub({ status: "active" }, user.id) } }, deps);
    cur = (await getEstate(user.id))!;
    expect(cur.status).toBe("ready");
    expect((cur as any).suspend_pending).toBeNull();
  });
});

describe("defect 3: a worker's blind save cannot undo a suspend", () => {
  let user: User;
  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    user = await createUser("race@example.com", "sufficiently-long-pass");
  });
  afterEach(() => {
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
  });

  it("saveEstate of a stale copy keeps the suspension (suspend wins) but keeps the worker's progress", async () => {
    await queueEstate(user);
    const workerCopy = (await getEstate(user.id))!; // the worker loaded the record...
    const admin = (await getEstate(user.id))!;
    await suspendEstate(admin, new StopFly() as any, new Date(), "canceled"); // ...then a suspend landed
    workerCopy.step = "allocate_ips"; // the worker finishes its step and saves
    workerCopy.status = "provisioning";
    await saveEstate(workerCopy);
    const stored = (await getEstate(user.id))!;
    expect(stored.status).toBe("suspended");
    expect(stored.suspended_at).toBeTruthy();
    expect(stored.step).toBe("allocate_ips");
    expect(workerCopy.status).toBe("suspended"); // the caller sees the truth too

    // resume is a deliberate change and still works
    const back = await resumeEstate((await getEstate(user.id))!, new StopFly() as any);
    expect(back.status).toBe("provisioning");
    expect((await getEstate(user.id))!.status).toBe("provisioning");
  });

  it("a suspend that lands mid-step survives the step's own save", async () => {
    await queueEstate(user);
    const fly: any = {
      async createApp() {
        // a webhook suspends the estate while the worker is inside the create_app step
        await suspendEstate((await getEstate(user.id))!, new StopFly() as any, new Date(), "canceled");
      },
    };
    const r = await advanceEstate((await getEstate(user.id))!, fly);
    expect((await getEstate(user.id))!.status).toBe("suspended");
    expect(r.estate.status).toBe("suspended");
  });
});

describe("defect 4: concurrent checkouts create one Stripe session", () => {
  let user: User;
  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, STRIPE_ENV);
    process.env.URL = "https://force-field-console.netlify.app";
    user = await createUser("pay2@example.com", "sufficiently-long-pass");
  });
  afterEach(() => {
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
    delete process.env.URL;
  });

  it("a claim expires after its short TTL and one racing taker wins it", async () => {
    const { claimCheckout, CHECKOUT_CLAIM_TTL_MS } = await import("../src/lib/billing");
    const t0 = new Date("2026-01-01T00:00:00Z");
    expect(await claimCheckout(user.id, t0)).toBeTruthy();
    expect(await claimCheckout(user.id, new Date(t0.getTime() + 1000))).toBeNull();
    const later = new Date(t0.getTime() + CHECKOUT_CLAIM_TTL_MS + 1);
    const got = await Promise.all([claimCheckout(user.id, later), claimCheckout(user.id, later)]);
    expect(got.filter(Boolean).length).toBe(1);
  });

  const post = async () =>
    billingHandler(
      new Request("http://portal.test/api/billing/checkout", {
        method: "POST",
        headers: { cookie: sessionCookie(await issueSession(user.id)).split(";")[0] },
        body: JSON.stringify({ tier: "operator" }),
      }),
      ctx,
    );

  it("two simultaneous checkouts: one session, the other gets 409 checkout_in_progress", async () => {
    let created = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      created += 1;
      await new Promise((r) => setTimeout(r, 20));
      return jsonResponse(200, { id: "cs_" + created, url: "https://checkout.stripe.com/c/cs_" + created });
    }) as any;
    try {
      const [a, b] = await Promise.all([post(), post()]);
      expect(created).toBe(1);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect((await loser.json()).error.code).toBe("checkout_in_progress");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a failed session creation releases the claim so the user can retry at once", async () => {
    const realFetch = globalThis.fetch;
    let fail = true;
    globalThis.fetch = (async () => (fail ? jsonResponse(500, { error: { message: "down" } }) : jsonResponse(200, { id: "cs_9", url: "https://checkout.stripe.com/c/cs_9" }))) as any;
    try {
      expect((await post()).status).toBe(502);
      fail = false;
      expect((await post()).status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("defect 5: stale-claim takeover is a conditional write", () => {
  beforeEach(() => {
    freshStore();
  });

  it("two retries racing to take over the same stale claim: exactly one wins", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    expect(await claimEvent("evt_race", "t", t0)).toBe(true);
    const later = new Date(t0.getTime() + STALE_CLAIM_MS + 1000);
    const results = await Promise.all([claimEvent("evt_race", "t", later), claimEvent("evt_race", "t", later)]);
    expect(results.filter(Boolean).length).toBe(1);
  });
});

describe("defect 6: /api/estate/advance answers 501 when unconfigured", () => {
  let user: User;
  beforeEach(async () => {
    freshStore();
    user = await createUser("adv@example.com", "sufficiently-long-pass");
    delete process.env.FLY_API_TOKEN;
  });
  afterEach(() => {
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
  });

  it("501 provisioning_not_configured, not a 200 'idle'; configured behaviour is unchanged", async () => {
    await queueEstate(user);
    const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
    const req = () => new Request("http://portal.test/api/estate/advance", { method: "POST", headers: { cookie }, body: "{}" });
    const off = await estateHandler(req(), ctx);
    expect(off.status).toBe(501);
    expect((await off.json()).error.code).toBe("provisioning_not_configured");
    Object.assign(process.env, FLY_ENV);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as any; // never reach a real Fly
    try {
      const on = await estateHandler(req(), ctx);
      expect(on.status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
