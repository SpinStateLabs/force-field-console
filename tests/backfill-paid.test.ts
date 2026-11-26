// Deploy step 0 of PR 29: the paid_subscriptions backfill (selection rule, read-only plan, create-only apply), and the
// MEASURED behaviour of the first tick after deploy for a running, legitimately paid estate that has no record yet.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { ModelFly, machinesApiHandler } from "./model-fly";
import { freshStore, type MemStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent, isPaidSubscription } from "../src/lib/billing";
import { getEstate, queueEstate, readback, resolveRoute, saveEstate } from "../src/lib/estates";
import { applyBackfill, planBackfill, selectFirstTierPayment } from "../src/lib/backfill-paid";

const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov", STRIPE_PRICE_PACK: "price_pack" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };
const SANDBOX_ENV = { ESTATE_URL: "https://sandbox.example", ESTATE_SHARED_SECRET: "sandbox-secret" };
const NOW = new Date("2026-11-22T06:00:00.000Z");
let store: MemStore;
let user: User;
let fly: ModelFly;
const origDelay = readback.delayMs;

const inv = (over: Record<string, any> = {}) => ({
  id: "in_1", object: "invoice", created: 100, subscription: "sub_1", customer: "cus_1", amount_paid: 2400, currency: "cad", status: "paid",
  lines: { data: [{ price: { id: "price_op" }, amount: 2400 }] },
  ...over,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stripe stand-in: subscriptions by id, paid invoices per subscription (paged by `pageSize`). */
function stripe(subs: Record<string, any>, invoices: Record<string, any[]>, opts: { pageSize?: number; fail?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    if (opts.fail) return json(opts.fail, { error: { message: "down" } });
    const u = new URL(url);
    const m = /^\/v1\/subscriptions\/([^/]+)$/.exec(u.pathname);
    if (m) return subs[m[1]] ? json(200, subs[m[1]]) : json(404, { error: { message: "No such subscription" } });
    if (u.pathname === "/v1/invoices") {
      const all = invoices[u.searchParams.get("subscription") ?? ""] ?? [];
      const after = u.searchParams.get("starting_after");
      const start = after ? all.findIndex((i) => i.id === after) + 1 : 0;
      const size = opts.pageSize ?? 100;
      const data = all.slice(start, start + size);
      return json(200, { object: "list", data, has_more: start + size < all.length });
    }
    return json(404, { error: { message: "no route" } });
  }) as any;
  return { impl, calls };
}

beforeEach(async () => {
  store = freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV, SANDBOX_ENV);
  readback.delayMs = 3;
  user = await createUser("backfill@example.com", "sufficiently-long-pass");
  fly = new ModelFly();
});
afterEach(() => {
  readback.delayMs = origDelay;
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV), ...Object.keys(SANDBOX_ENV)]) delete process.env[k];
});

async function payingOn(subId = "sub_1", status = "active") {
  user.tier = "operator";
  user.billing = { customer_id: "cus_1", subscription_id: subId, status, price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
  await saveUser(user);
}
/** A legitimately paid customer from before the paid marker: active sub_1, ready estate, machine running, NO record. */
async function legacyReady() {
  await payingOn();
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` });
  await saveEstate(e);
  fly.machine("m_1");
  return e;
}
async function tick() {
  const api = machinesApiHandler(fly);
  const realFetch = globalThis.fetch;
  // Fly's app read and the estate's own /health answer as for a healthy estate, so the tick's health pass (which is
  // not billing-gated) sees a live app; only the billing rule decides what happens below.
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (/^https:\/\/api\.machines\.dev\/v1\/apps\/[^/]+$/.test(u)) return json(200, { name: u.split("/").pop(), status: "deployed" });
    if (/\.fly\.dev\//.test(u)) return json(200, { status: "ok" });
    return (await api(u, init)) ?? new Response("", { status: 404 });
  }) as any;
  try {
    return await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("selection rule (the same tier-payment test as invoice.paid)", () => {
  const cfg = () => stripeConfig()!;
  it("picks the OLDEST paid tier invoice of this subscription and customer", () => {
    const got = selectFirstTierPayment([inv({ id: "in_new", created: 300 }), inv({ id: "in_old", created: 200 })], "sub_1", "cus_1", cfg());
    expect(got?.id).toBe("in_old");
  });
  it("a partly discounted tier line still counts (net > 0)", () => {
    const i = inv({ amount_paid: 1200, lines: { data: [{ price: { id: "price_op" }, amount: 2400, discount_amounts: [{ amount: 1200 }] }] } });
    expect(selectFirstTierPayment([i], "sub_1", "cus_1", cfg())?.id).toBe("in_1");
  });
  it("accepts the newer subscription reference (parent.subscription_details) and an expanded customer", () => {
    const i = inv({ subscription: undefined, parent: { subscription_details: { subscription: "sub_1" } }, customer: { id: "cus_1" } });
    expect(selectFirstTierPayment([i], "sub_1", "cus_1", cfg())?.id).toBe("in_1");
  });
  it.each([
    ["another subscription", { subscription: "sub_2" }],
    ["another customer", { customer: "cus_2" }],
    ["nothing paid", { amount_paid: 0 }],
    ["another currency", { currency: "usd" }],
    ["no currency", { currency: undefined }],
    ["no tier line", { lines: { data: [{ price: { id: "price_other" }, amount: 2400 }] } }],
    ["a tier line at zero next to a paid pack", { amount_paid: 1200, lines: { data: [{ price: { id: "price_op" }, amount: 0 }, { price: { id: "price_pack" }, amount: 1200 }] } }],
    ["a tier line without an amount", { lines: { data: [{ price: { id: "price_op" } }] } }],
    ["a 100% tier coupon (gross amount, discount_amounts) next to a paid pack", { amount_paid: 1200, lines: { data: [{ price: { id: "price_op" }, amount: 2400, discount_amounts: [{ amount: 2400, discount: "di_1" }] }, { price: { id: "price_pack" }, amount: 1200 }] } }],
    ["a positive tier line beside a larger negative tier proration", { amount_paid: 500, lines: { data: [{ price: { id: "price_op" }, amount: 2400 }, { price: { id: "price_op" }, amount: -3000, proration: true }, { price: { id: "price_pack" }, amount: 1100 }] } }],
  ])("rejects %s", (_n, over) => {
    expect(selectFirstTierPayment([inv(over)], "sub_1", "cus_1", cfg())).toBeNull();
  });
});

describe("planBackfill (read-only)", () => {
  it("a paid estate with no record: one 'write' row naming ids only (no email); nothing is written by the plan", async () => {
    await legacyReady();
    const s = stripe({ sub_1: { id: "sub_1", status: "active", customer: "cus_1" } }, { sub_1: [inv()] });
    const before = (await store.list()).blobs.map((b) => b.key).sort();
    const plan = await planBackfill(stripeConfig()!, NOW, s.impl);
    const rows = plan.rows;
    expect(rows).toEqual([
      expect.objectContaining({
        user_id: user.id, estate_status: "ready", role: "current", subscription_id: "sub_1", subscription_status: "active", paid_invoice: "in_1", action: "write",
        would_write: { key: "paid_subscriptions/sub_1", value: { customer: "cus_1", first_paid_invoice: "in_1", at: NOW.toISOString() } },
      }),
    ]);
    expect(plan.estates).toEqual([expect.objectContaining({ user_id: user.id, may_run: true, outlook: "runs" })]);
    expect(JSON.stringify(rows)).not.toContain("backfill@example.com");
    expect((await store.list()).blobs.map((b) => b.key).sort()).toEqual(before);
    expect(s.calls.every((c) => !/POST|DELETE/.test(c))).toBe(true);
  });

  it("skips, with a reason: a record already there, no subscription, Stripe 404, a customer mismatch, no qualifying invoice", async () => {
    const mk = async (email: string, billing: any) => {
      const u = await createUser(email, "sufficiently-long-pass");
      u.tier = billing ? "operator" : "sandbox";
      u.billing = billing;
      await saveUser(u);
      await queueEstate(u);
      return u;
    };
    await store.setJSON("paid_subscriptions/sub_has", { customer: "cus_1", first_paid_invoice: "in_x", at: "t" });
    const b = (sub: string, cus = "cus_1") => ({ customer_id: cus, subscription_id: sub, status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" });
    const has = await mk("a@example.com", b("sub_has"));
    const none = await mk("b@example.com", null);
    const gone = await mk("c@example.com", b("sub_gone"));
    const other = await mk("d@example.com", b("sub_other", "cus_mine"));
    const unpaid = await mk("e@example.com", b("sub_unpaid"));
    const s = stripe(
      { sub_other: { id: "sub_other", status: "active", customer: "cus_theirs" }, sub_unpaid: { id: "sub_unpaid", status: "active", customer: "cus_1" } },
      { sub_unpaid: [inv({ subscription: "sub_unpaid", amount_paid: 0 })] },
    );
    const { rows } = await planBackfill(stripeConfig()!, NOW, s.impl);
    const by = (u: User) => rows.find((r) => r.user_id === u.id)!;
    expect(by(has)).toMatchObject({ action: "skip", reason: "paid record already exists" });
    expect(by(none)).toMatchObject({ action: "skip", reason: "the user has no subscription" });
    expect(by(gone)).toMatchObject({ action: "skip", reason: "Stripe does not know the subscription" });
    expect(by(other)).toMatchObject({ action: "skip", reason: "the subscription's customer does not match the user's billing" });
    expect(by(unpaid)).toMatchObject({ action: "skip", paid_invoice: null });
    expect(rows.filter((r) => r.action === "write")).toEqual([]);
  });

  it("plans the REMEMBERED subscriptions too (billing.other_subs), each confirmed in Stripe", async () => {
    await legacyReady();
    user.billing = { ...user.billing!, other_subs: { sub_2: { status: "trialing", price_id: "price_op" }, sub_3: { status: "active", price_id: "price_op" } } } as any;
    await saveUser(user);
    const s = stripe(
      { sub_1: { id: "sub_1", status: "active", customer: "cus_1" }, sub_2: { id: "sub_2", status: "trialing", customer: "cus_1" }, sub_3: { id: "sub_3", status: "active", customer: "cus_1" } },
      { sub_1: [inv()], sub_3: [inv({ id: "in_3", subscription: "sub_3" })] },
    );
    const { rows } = await planBackfill(stripeConfig()!, NOW, s.impl);
    expect(rows.map((r) => [r.role, r.subscription_id, r.action])).toEqual([["current", "sub_1", "write"], ["remembered", "sub_2", "skip"], ["remembered", "sub_3", "write"]]);
  });

  it("a paid invoice whose lines are truncated without a tier line on page one is flagged for a hand check, not written", async () => {
    await legacyReady();
    const s = stripe({ sub_1: { id: "sub_1", status: "active", customer: "cus_1" } }, { sub_1: [inv({ lines: { data: [{ price: { id: "price_pack" }, amount: 2400 }], has_more: true } })] });
    const { rows } = await planBackfill(stripeConfig()!, NOW, s.impl);
    expect(rows[0]).toMatchObject({ action: "skip" });
    expect(rows[0].reason).toMatch(/truncated/);
  });

  it("lists what the new rule does to every estate: legacy trialing / unpaid records are parked, an unpaid ready one is suspended on its next event", async () => {
    const mk = async (email: string, status: string, sub: string, estate: string) => {
      const u = await createUser(email, "sufficiently-long-pass");
      u.tier = "operator";
      u.billing = { customer_id: "cus_1", subscription_id: sub, status, price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" } as any;
      await saveUser(u);
      const e = await queueEstate(u);
      e.status = estate as any;
      await saveEstate(e);
      return u;
    };
    const trialProv = await mk("t1@example.com", "trialing", "sub_t1", "provisioning");
    const trialManual = await mk("t2@example.com", "trialing", "sub_t2", "pending_manual");
    const unpaidReady = await mk("t3@example.com", "active", "sub_t3", "ready");
    const paidReady = await mk("t4@example.com", "active", "sub_t4", "ready");
    const dunning = await mk("t5@example.com", "past_due", "sub_t5", "ready");
    const subs = Object.fromEntries(["sub_t1", "sub_t2", "sub_t3", "sub_t4", "sub_t5"].map((id) => [id, { id, status: "active", customer: "cus_1" }]));
    const s = stripe(subs, { sub_t4: [inv({ subscription: "sub_t4" })], sub_t5: [inv({ subscription: "sub_t5" })] });
    const { estates } = await planBackfill(stripeConfig()!, NOW, s.impl);
    const by = (u: User) => estates.find((x) => x.user_id === u.id)!.outlook;
    expect(by(trialProv)).toBe("parked (no provisioning)");
    expect(by(trialManual)).toBe("parked (no provisioning)");
    expect(by(unpaidReady)).toBe("suspended on the next subscription event");
    expect(by(paidReady)).toBe("runs");
    expect(by(dunning)).toBe("kept running (paid, not active)");
  });

  it("outlook labels: a suspended estate of an active, paid owner resumes; a test-held record is held", async () => {
    const mk = async (email: string, sub: string, over: Record<string, any>) => {
      const u = await createUser(email, "sufficiently-long-pass");
      u.tier = "operator";
      u.billing = { customer_id: "cus_1", subscription_id: sub, status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" } as any;
      await saveUser(u);
      const e = await queueEstate(u);
      Object.assign(e, over);
      await saveEstate(e, undefined, { owns: over.test_hold ? ["test_hold"] : [] });
      return u;
    };
    const resumes = await mk("r1@example.com", "sub_r1", { status: "suspended" });
    const held = await mk("r2@example.com", "sub_r2", { status: "pending_manual", test_hold: true });
    const subs = Object.fromEntries(["sub_r1", "sub_r2"].map((id) => [id, { id, status: "active", customer: "cus_1" }]));
    const s = stripe(subs, { sub_r1: [inv({ subscription: "sub_r1" })], sub_r2: [inv({ subscription: "sub_r2" })] });
    const { estates } = await planBackfill(stripeConfig()!, NOW, s.impl);
    const by = (u: User) => estates.find((x) => x.user_id === u.id)!;
    expect(by(resumes)).toMatchObject({ may_run: true, outlook: "resumes (suspended; owner active and paid)" });
    expect(by(held).outlook).toBe("held (test-mode grant; never started)");
  });

  it("truncated lines are also flagged when the invoice names its subscription only under parent.subscription_details", async () => {
    await legacyReady();
    const s = stripe(
      { sub_1: { id: "sub_1", status: "active", customer: "cus_1" } },
      { sub_1: [inv({ subscription: undefined, parent: { subscription_details: { subscription: "sub_1" } }, lines: { data: [{ price: { id: "price_pack" }, amount: 2400 }], has_more: true } })] },
    );
    const { rows } = await planBackfill(stripeConfig()!, NOW, s.impl);
    expect(rows[0]).toMatchObject({ action: "skip" });
    expect(rows[0].reason).toMatch(/truncated/);
  });

  it("reads every page of paid invoices", async () => {
    await legacyReady();
    const invoices = Array.from({ length: 5 }, (_, i) => inv({ id: "in_" + i, created: 100 + i, amount_paid: i < 4 ? 0 : 2400 }));
    const s = stripe({ sub_1: { id: "sub_1", status: "active", customer: "cus_1" } }, { sub_1: invoices }, { pageSize: 2 });
    const { rows } = await planBackfill(stripeConfig()!, NOW, s.impl);
    expect(rows[0]).toMatchObject({ action: "write", paid_invoice: "in_4" });
    expect(s.calls.filter((c) => c.includes("/v1/invoices")).length).toBe(3);
  });

  it("a Stripe failure other than 404 stops the plan (a partial plan is never applied)", async () => {
    await legacyReady();
    await expect(planBackfill(stripeConfig()!, NOW, stripe({}, {}, { fail: 500 }).impl)).rejects.toThrow();
  });
});

describe("applyBackfill (create-only, paid_subscriptions/ only)", () => {
  it("writes the planned records and nothing else; an existing record is never overwritten", async () => {
    await legacyReady();
    const s = stripe({ sub_1: { id: "sub_1", status: "active", customer: "cus_1" } }, { sub_1: [inv()] });
    const rows = await planBackfill(stripeConfig()!, NOW, s.impl);
    const before = new Set((await store.list()).blobs.map((b) => b.key));
    expect(await applyBackfill(rows)).toEqual({ written: 1, already: 0 });
    const added = (await store.list()).blobs.map((b) => b.key).filter((k) => !before.has(k));
    expect(added).toEqual(["paid_subscriptions/sub_1"]);
    await store.setJSON("paid_subscriptions/sub_1", { customer: "cus_1", first_paid_invoice: "in_real", at: "t" });
    expect(await applyBackfill(rows)).toEqual({ written: 0, already: 1 });
    expect(((await store.get("paid_subscriptions/sub_1", { type: "json" })) as any).first_paid_invoice).toBe("in_real");
  });

  it("refuses a row whose key is outside paid_subscriptions/", async () => {
    const bad: any = [{ action: "write", would_write: { key: "users/x", value: {} } }];
    await expect(applyBackfill(bad)).rejects.toThrow(/paid_subscriptions/);
  });
});

describe("MEASURED: the first tick after deploy, for a running, legitimately paid estate with no record yet", () => {
  it("machine running: the tick leaves it ready and running (no stop, no suspend) and the gateway still routes to it", async () => {
    await legacyReady();
    await tick();
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("ready");
    expect(e.suspend_pending ?? null).toBeNull();
    expect(fly.machine("m_1").state).toBe("started");
    expect(fly.log.some((l) => /stop/.test(l))).toBe(false);
    expect(resolveRoute((await getUserById(user.id))!, e).kind).toBe("estate");
  });

  it("machine found STOPPED: the tick does NOT restart it (no resume queued); the gateway still routes to the ready record", async () => {
    await legacyReady();
    const m = fly.machine("m_1");
    m.state = "stopped";
    await tick();
    await tick();
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("ready");
    expect(e.resume_pending ?? null).toBeNull();
    expect(fly.machine("m_1").state).toBe("stopped");
    expect(resolveRoute((await getUserById(user.id))!, e).kind).toBe("estate");
  });

  it("the next subscription event for it (a renewal's customer.subscription.updated) SUSPENDS it", async () => {
    await legacyReady();
    const sub = { id: "sub_1", status: "active", customer: "cus_1", items: { data: [{ price: { id: "price_op" }, current_period_end: 1_900_000_000 }] }, metadata: { user_id: user.id } };
    await handleStripeEvent({ id: "evt_r", type: "customer.subscription.updated", created: 1_800_000_100, livemode: true, data: { object: sub } }, { cfg: stripeConfig()!, fly: fly as any });
    const e = (await getEstate(user.id))!;
    expect(e.status === "suspended" || Boolean(e.suspend_pending)).toBe(true);
    expect(fly.machine("m_1").state).toBe("stopped");
  });

  it("a leftover resume_pending on it is DROPPED by the tick (the machine is not started)", async () => {
    const e = await legacyReady();
    fly.machine("m_1").state = "stopped";
    await saveEstate(Object.assign(e, { resume_pending: { since: "2026-11-01T00:00:00Z", attempts: 0, failed: false, next_retry_at: null } }) as any);
    await tick();
    expect((await getEstate(user.id))!.resume_pending ?? null).toBeNull();
    expect(fly.machine("m_1").state).toBe("stopped");
  });

  it("a leftover suspend_pending on it is carried through: the tick stops the machine", async () => {
    const e = await legacyReady();
    await saveEstate(Object.assign(e, { suspend_pending: { since: "2026-11-01T00:00:00Z", attempts: 0, failed: false, next_retry_at: null, reason: "x" } }) as any);
    await tick();
    expect(fly.machine("m_1").state).toBe("stopped");
  });

  it("after the backfill, the stopped machine is restarted by the next tick", async () => {
    await legacyReady();
    fly.machine("m_1").state = "stopped";
    await tick();
    expect(fly.machine("m_1").state).toBe("stopped");
    const s = stripe({ sub_1: { id: "sub_1", status: "active", customer: "cus_1" } }, { sub_1: [inv()] });
    await applyBackfill(await planBackfill(stripeConfig()!, NOW, s.impl));
    expect(await isPaidSubscription("sub_1")).toBe(true);
    await tick(); // finds the machine stopped, queues the start
    await tick(); // starts it
    expect(fly.machine("m_1").state).toBe("started");
  });
});
