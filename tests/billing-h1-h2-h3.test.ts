// Billing audit 2026-11-10, findings H1, H2, H3:
//  H1 an active paid subscription on a price id that is not configured must never silently downgrade or
//     suspend: the tier is kept, the mirror records price_unmatched, an ALERT is logged and /api/health flags it;
//     extra accepted price ids per tier (STRIPE_PRICE_<TIER>_ACCEPTED, comma separated) map to the tier.
//  H2 an estate that exhausts its provisioning attempts logs ALERT provision_failed, /api/health shows
//     provision_failed, and the tick retries it automatically a bounded number of times with backoff.
//  H3 a verified event that cannot be matched to a portal user is still answered 200, but logs ALERT
//     unmatched_payment (event id, type and subscription id; no email, no customer id), is persisted under
//     ops/unmatched_events/<event id> and /api/health shows unmatched_events: true.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import billingHandler from "../netlify/functions/billing.mts";
import healthHandler from "../netlify/functions/health.mts";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { freshStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { signPayload, stripeConfig, tierForPrice } from "../src/lib/stripe";
import { handleStripeEvent } from "../src/lib/billing";
import { FlyError } from "../src/lib/fly";
import { MAX_ATTEMPTS, MAX_AUTO_PROVISION_RETRIES, advanceEstate, getEstate, queueEstate, saveEstate } from "../src/lib/estates";
import { portalStore } from "../src/lib/store";

const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };
const EXTRA = ["STRIPE_PRICE_OPERATOR_ACCEPTED", "STRIPE_PRICE_SOVEREIGN_ACCEPTED", "URL"];

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
const priced = (price: string) => ({ items: { data: [{ price: { id: price }, current_period_end: 1_800_000_000 }] } });

async function health() {
  return (await healthHandler(new Request("http://portal.test/api/health"), ctx)).json();
}

let user: User;
let errors: string[];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  freshStore();
  Object.assign(process.env, STRIPE_ENV);
  user = await createUser("h123@example.com", "sufficiently-long-pass");
  errors = [];
  spy = vi.spyOn(console, "error").mockImplementation((...a: any[]) => {
    errors.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  spy.mockRestore();
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV), ...EXTRA]) delete process.env[k];
});

async function payingOperator() {
  user.tier = "operator";
  user.billing = { customer_id: "cus_1", subscription_id: "sub_1", status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
  await saveUser(user);
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` });
  await saveEstate(e);
}

describe("H1: an active subscription on an unconfigured price keeps the tier and is flagged", () => {
  it("a paying customer moved to an unknown price keeps operator, the estate is not suspended, the state is recorded and alerted", async () => {
    await payingOperator();
    const fly = { stopMachine: vi.fn(), getMachine: vi.fn(), updateMachine: vi.fn() } as any;
    const r = await handleStripeEvent(
      { id: "evt_h1", type: "customer.subscription.updated", created: 100, data: { object: sub(priced("price_new_annual"), user.id) } },
      { cfg: stripeConfig()!, fly },
    );
    expect(r.handled).toBe(true);
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("operator");
    expect(u.billing).toMatchObject({ status: "active", price_id: "price_new_annual", tier: "operator", price_unmatched: true });
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("ready");
    expect(e.suspend_pending ?? null).toBeNull();
    expect(fly.stopMachine).not.toHaveBeenCalled();
    const alerts = errors.filter((l) => l.startsWith("ALERT unmatched_price"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("price_new_annual");
    expect(alerts[0]).not.toContain("h123@example.com");
    expect((await health()).unmatched_price).toBe(true);
  });

  it("the flag clears once the subscription is on a configured price again", async () => {
    await payingOperator();
    const deps = { cfg: stripeConfig()!, fly: null };
    await handleStripeEvent({ id: "evt_a", type: "customer.subscription.updated", created: 100, data: { object: sub(priced("price_new_annual"), user.id) } }, deps);
    expect((await health()).unmatched_price).toBe(true);
    await handleStripeEvent({ id: "evt_b", type: "customer.subscription.updated", created: 200, data: { object: sub(priced("price_sov"), user.id) } }, deps);
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("sovereign");
    expect(u.billing!.price_unmatched).toBeUndefined();
    expect((await health()).unmatched_price).toBe(false);
  });

  it("a cancelled subscription on an unknown price still drops to sandbox and suspends (only paying statuses are kept)", async () => {
    await payingOperator();
    const r = await handleStripeEvent(
      { id: "evt_c", type: "customer.subscription.deleted", created: 100, data: { object: sub({ status: "canceled", ...priced("price_new_annual") }, user.id) } },
      { cfg: stripeConfig()!, fly: null },
    );
    expect(r.handled).toBe(true);
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("sandbox");
    expect((await getEstate(user.id))!.status).toBe("suspended");
  });

  it("the ALERT fires once per unmatched price, not on every later event for it", async () => {
    await payingOperator();
    const deps = { cfg: stripeConfig()!, fly: null };
    await handleStripeEvent({ id: "evt_r1", type: "customer.subscription.updated", created: 100, data: { object: sub(priced("price_new_annual"), user.id) } }, deps);
    await handleStripeEvent({ id: "evt_r2", type: "customer.subscription.updated", created: 200, data: { object: sub(priced("price_new_annual"), user.id) } }, deps);
    expect(errors.filter((l) => l.startsWith("ALERT unmatched_price"))).toHaveLength(1);
    expect((await getUserById(user.id))!.tier).toBe("operator");
  });

  it("fail closed: only active/trialing keep the tier on an unknown price; past_due drops to sandbox and suspends (flagged)", async () => {
    await payingOperator();
    await handleStripeEvent(
      { id: "evt_pd", type: "customer.subscription.updated", created: 100, data: { object: sub({ status: "past_due", ...priced("price_new_annual") }, user.id) } },
      { cfg: stripeConfig()!, fly: null },
    );
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("sandbox");
    expect(u.billing!.price_unmatched).toBe(true);
    expect((await getEstate(user.id))!.status).toBe("suspended");
    expect((await health()).unmatched_price).toBe(true);
  });

  it("C1: past_due -> active on an unknown price does not re-grant, but ALERTs again because the paying customer is left at sandbox", async () => {
    await payingOperator();
    const deps = { cfg: stripeConfig()!, fly: null };
    await handleStripeEvent({ id: "evt_c1a", type: "customer.subscription.updated", created: 100, data: { object: sub({ status: "past_due", ...priced("price_new_annual") }, user.id) } }, deps);
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
    expect(errors.filter((l) => l.startsWith("ALERT unmatched_price"))).toHaveLength(1);
    await handleStripeEvent({ id: "evt_c1b", type: "customer.subscription.updated", created: 200, data: { object: sub(priced("price_new_annual"), user.id) } }, deps);
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("sandbox"); // an unknown price never grants
    expect((await getEstate(user.id))!.status).toBe("suspended");
    const alerts = errors.filter((l) => l.startsWith("ALERT unmatched_price"));
    expect(alerts).toHaveLength(2);
    expect(JSON.parse(alerts[1].slice("ALERT unmatched_price".length))).toMatchObject({ status: "active", tier_kept: null });
    expect((await health()).unmatched_price).toBe(true);
  });

  it("M2: a paid tier that does not come from this subscription (no billing mirror) is not kept on an unknown price", async () => {
    user.tier = "operator"; // e.g. granted by an operator, no Stripe subscription behind it
    user.billing = null;
    await saveUser(user);
    await handleStripeEvent(
      { id: "evt_m2", type: "customer.subscription.created", created: 100, data: { object: sub(priced("price_mystery"), user.id) } },
      { cfg: stripeConfig()!, fly: null },
    );
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("sandbox");
    expect(u.billing!.price_unmatched).toBe(true);
  });

  it("a new user whose first subscription is on an unknown price stays sandbox (no grant from an unknown price) and is flagged", async () => {
    const r = await handleStripeEvent(
      { id: "evt_d", type: "customer.subscription.created", created: 100, data: { object: sub(priced("price_mystery"), user.id) } },
      { cfg: stripeConfig()!, fly: null },
    );
    expect(r.handled).toBe(true);
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("sandbox");
    expect(u.billing!.price_unmatched).toBe(true);
    expect(await getEstate(user.id)).toBeNull();
    expect((await health()).unmatched_price).toBe(true);
  });

  it("STRIPE_PRICE_<TIER>_ACCEPTED adds price ids per tier (comma separated); checkout still uses the primary price", async () => {
    process.env.STRIPE_PRICE_OPERATOR_ACCEPTED = " price_op_2024 , price_op_annual,";
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_sov_annual";
    const cfg = stripeConfig()!;
    expect(tierForPrice(cfg, "price_op")).toBe("operator");
    expect(tierForPrice(cfg, "price_op_2024")).toBe("operator");
    expect(tierForPrice(cfg, "price_op_annual")).toBe("operator");
    expect(tierForPrice(cfg, "price_sov_annual")).toBe("sovereign");
    expect(tierForPrice(cfg, "")).toBeNull();
    expect(cfg.prices).toEqual({ operator: "price_op", sovereign: "price_sov" });

    await payingOperator();
    await handleStripeEvent({ id: "evt_e", type: "customer.subscription.updated", created: 100, data: { object: sub(priced("price_op_annual"), user.id) } }, { cfg, fly: null });
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("operator");
    expect(u.billing!.price_unmatched).toBeUndefined();
  });

  it("an id listed for both tiers is ambiguous and maps to no tier", async () => {
    process.env.STRIPE_PRICE_OPERATOR_ACCEPTED = "price_dup";
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_dup,price_op";
    const cfg = stripeConfig()!;
    expect(tierForPrice(cfg, "price_dup")).toBeNull();
    expect(tierForPrice(cfg, "price_op")).toBeNull();
    expect(tierForPrice(cfg, "price_sov")).toBe("sovereign");
  });

  it("the accepted lists are optional: the all-four gate is unchanged", () => {
    process.env.STRIPE_PRICE_OPERATOR_ACCEPTED = "price_x";
    delete process.env.STRIPE_PRICE_SOVEREIGN;
    expect(stripeConfig()).toBeNull();
  });
});

describe("H2: provisioning that exhausts its attempts is alerted, flagged and retried (bounded)", () => {
  const failingFly = () => ({ createApp: vi.fn(async () => { throw new FlyError(500, "boom"); }) }) as any;

  async function exhaust(fly: any, base: Date) {
    let e = (await getEstate(user.id))!;
    for (let i = 0; i < MAX_ATTEMPTS; i++) e = (await advanceEstate(e, fly, { now: new Date(base.getTime() + i * 60_000) })).estate;
    return e;
  }

  beforeEach(async () => {
    Object.assign(process.env, FLY_ENV);
    user.tier = "operator";
    user.billing = { customer_id: "cus_1", subscription_id: "sub_1", status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
    await saveUser(user);
    await queueEstate(user);
  });

  it("logs ALERT provision_failed exactly once at the transition to error, with no email", async () => {
    const e = await exhaust(failingFly(), new Date());
    expect(e.status).toBe("error");
    const alerts = errors.filter((l) => l.startsWith("ALERT provision_failed"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).not.toContain("h123@example.com");
    expect(e.provision_retry?.next_retry_at).toBeTruthy();
  });

  it("the tick counts it, /api/health shows provision_failed, and a due auto-retry puts it back to provisioning", async () => {
    await exhaust(failingFly(), new Date(Date.now() - 10 * 3_600_000));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as any;
    try {
      const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(body.provision_failed).toBe(1);
      expect(body.outcomes.provision_auto_retry).toBe(1);
      expect((await health()).provision_failed).toBe(true);
      const e = (await getEstate(user.id))!;
      expect(e.status).toBe("provisioning");
      expect(e.attempts).toBe(0);
      expect(e.provision_retry).toMatchObject({ count: 1, next_retry_at: null });
      // a second tick does not retry again (it is provisioning now, not error)
      const again = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(again.outcomes.provision_auto_retry ?? 0).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("auto-retries are bounded by MAX_AUTO_PROVISION_RETRIES with growing backoff; then only an operator or the dashboard retries", async () => {
    const fly = failingFly();
    let t = new Date(Date.now() - 1000 * 3_600_000);
    let e = await exhaust(fly, t);
    const gaps: number[] = [];
    for (let n = 1; n <= MAX_AUTO_PROVISION_RETRIES; n++) {
      const at = new Date(e.provision_retry!.next_retry_at!);
      gaps.push(at.getTime() - new Date(e.updated_at).getTime());
      const { autoRetryFailedEstate } = await import("../src/lib/estates");
      expect(await autoRetryFailedEstate(e, at)).toBe(true);
      e = (await getEstate(user.id))!;
      expect(e.provision_retry!.count).toBe(n);
      t = new Date(at.getTime() + 1000);
      e = await exhaust(fly, t);
      expect(e.status).toBe("error");
    }
    expect(e.provision_retry!.next_retry_at).toBeNull();
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
    expect(errors.filter((l) => l.startsWith("ALERT provision_failed"))).toHaveLength(MAX_AUTO_PROVISION_RETRIES + 1);
    const { autoRetryFailedEstate } = await import("../src/lib/estates");
    expect(await autoRetryFailedEstate(e, new Date(Date.now() + 365 * 86_400_000))).toBe(false);
  });

  it("the auto-retry is idempotent: a stale copy cannot retry an estate that is no longer in error", async () => {
    const e = await exhaust(failingFly(), new Date(Date.now() - 10 * 3_600_000));
    const { autoRetryFailedEstate } = await import("../src/lib/estates");
    const stale = structuredClone(e);
    expect(await autoRetryFailedEstate(e, new Date())).toBe(true);
    expect(await autoRetryFailedEstate(stale, new Date())).toBe(false);
    expect((await getEstate(user.id))!.provision_retry!.count).toBe(1);
  });

  it("an error that is not a provisioning failure (machine or app gone) is flagged but never auto-retried", async () => {
    const e = (await getEstate(user.id))!;
    Object.assign(e, { status: "error", step: "create_app", error: "estate_app_missing: the Fly app behind this estate is gone" });
    await saveEstate(e);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as any;
    try {
      const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(body.provision_failed).toBe(1);
      expect(body.outcomes.provision_auto_retry ?? 0).toBe(0);
      expect((await getEstate(user.id))!.status).toBe("error");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a dashboard retry clears the pending auto-retry, so a later non-provisioning error is never auto-retried", async () => {
    const e = await exhaust(failingFly(), new Date(Date.now() - 10 * 3_600_000));
    const { retryEstate, autoRetryFailedEstate } = await import("../src/lib/estates");
    const r = await retryEstate(e);
    expect(r.provision_retry!.next_retry_at).toBeNull();
    Object.assign(r, { status: "error", attempts: MAX_ATTEMPTS });
    await saveEstate(r);
    expect(await autoRetryFailedEstate((await getEstate(user.id))!, new Date(Date.now() + 365 * 86_400_000))).toBe(false);
  });

  it("M10: a suspension that became pending in the stored record blocks the auto-retry, even from a copy that predates it", async () => {
    const e = await exhaust(failingFly(), new Date(Date.now() - 10 * 3_600_000));
    const stale = structuredClone(e);
    const stored = (await getEstate(user.id))!;
    stored.suspend_pending = { reason: "subscription canceled", since: new Date().toISOString(), attempts: 1, last_error: "machine stop failed", next_retry_at: null, failed: false };
    await (await portalStore()).setJSON("estates/" + user.id, stored);
    const { autoRetryFailedEstate } = await import("../src/lib/estates");
    expect(await autoRetryFailedEstate(stale, new Date())).toBe(false);
    const after = (await getEstate(user.id))!;
    expect(after.status).toBe("error");
    expect(after.provision_retry!.count).toBe(0);
  });

  it("an errored estate of a user who no longer pays is neither counted nor retried", async () => {
    await exhaust(failingFly(), new Date(Date.now() - 10 * 3_600_000));
    const u = (await getUserById(user.id))!;
    u.tier = "sandbox";
    u.billing = { ...u.billing!, status: "canceled", tier: "sandbox" };
    await saveUser(u);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as any;
    try {
      const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(body.provision_failed).toBe(0);
      expect(body.outcomes.provision_auto_retry ?? 0).toBe(0);
      expect((await health()).provision_failed).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("H3: events that match no portal user are acknowledged, logged and counted", () => {
  async function deliver(event: any) {
    const raw = JSON.stringify(event);
    const sig = signPayload(raw, STRIPE_ENV.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));
    return billingHandler(new Request("http://portal.test/api/billing/webhook", { method: "POST", body: raw, headers: { "stripe-signature": sig } }), ctx);
  }

  it("checkout.session.completed for an unknown user: 200, ALERT with event id, type and subscription id only, persisted, flagged on /api/health", async () => {
    expect((await health()).unmatched_events).toBe(false);
    const res = await deliver({
      id: "evt_unmatched_1",
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", subscription: "sub_9", customer: "cus_9", client_reference_id: "nobody", customer_email: "lost@example.com" } },
    });
    expect(res.status).toBe(200);
    const alerts = errors.filter((l) => l.startsWith("ALERT unmatched_payment"));
    expect(alerts).toHaveLength(1);
    const payload = JSON.parse(alerts[0].slice("ALERT unmatched_payment".length));
    expect(payload).toEqual({ key: "unmatched_payment", event_id: "evt_unmatched_1", event_type: "checkout.session.completed", subscription_id: "sub_9" });
    expect(alerts[0]).not.toContain("lost@example.com");
    expect(alerts[0]).not.toContain("cus_9");
    const rec = await (await portalStore()).get("ops/unmatched_events/evt_unmatched_1", { type: "json" });
    expect(rec).toMatchObject({ event_id: "evt_unmatched_1", event_type: "checkout.session.completed", subscription_id: "sub_9" });
    expect(JSON.stringify(rec)).not.toContain("lost@example.com");
    expect(await (await portalStore()).get("ops/billing_flags", { type: "json" })).toEqual({ unmatched_price_users: [], unmatched_events: ["evt_unmatched_1"] });
    expect((await health()).unmatched_events).toBe(true);
  });

  it("a subscription event with no resolvable user: 200, logged, counted; a redelivery is a duplicate and not counted again", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as any;
    try {
      const ev = { id: "evt_unmatched_2", type: "customer.subscription.updated", created: 1, data: { object: sub({ customer: "cus_stranger" }) } };
      expect((await deliver(ev)).status).toBe(200);
      const dup = await deliver(ev);
      expect(dup.status).toBe(200);
      expect((await dup.json()).duplicate).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
    const alerts = errors.filter((l) => l.startsWith("ALERT unmatched_payment"));
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(alerts[0].slice("ALERT unmatched_payment".length))).toEqual({ key: "unmatched_payment", event_id: "evt_unmatched_2", event_type: "customer.subscription.updated", subscription_id: "sub_1" });
    expect(alerts[0]).not.toContain("cus_stranger");
    expect((await (await portalStore()).list({ prefix: "ops/unmatched_events/" })).blobs).toHaveLength(1);
    expect((await health()).unmatched_events).toBe(true);
  });

  it("a matched event is not alerted or flagged", async () => {
    await payingOperator();
    await handleStripeEvent({ id: "evt_ok", type: "customer.subscription.updated", created: 5, data: { object: sub({}, user.id) } }, { cfg: stripeConfig()!, fly: null });
    expect(errors.filter((l) => l.startsWith("ALERT unmatched_payment"))).toHaveLength(0);
    expect((await health()).unmatched_events).toBe(false);
  });

  it("event types the portal does not handle are acknowledged without an ALERT (not a lost payment)", async () => {
    const r = await handleStripeEvent({ id: "evt_inv", type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_9" } } }, { cfg: stripeConfig()!, fly: null });
    expect(r.handled).toBe(false);
    expect(errors.filter((l) => l.startsWith("ALERT unmatched_payment"))).toHaveLength(0);
    expect((await health()).unmatched_events).toBe(false);
  });

  it("a store failure while persisting the record does not fail the event; the ALERT is still logged", async () => {
    const store = await portalStore();
    const orig = store.setJSONIfNew.bind(store);
    (store as any).setJSONIfNew = async (k: string, v: any) => {
      if (k.startsWith("ops/unmatched_events")) throw new Error("blob down");
      return orig(k, v);
    };
    const r = await handleStripeEvent(
      { id: "evt_unmatched_3", type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_9", client_reference_id: "nobody" } } },
      { cfg: stripeConfig()!, fly: null },
    );
    expect(r.handled).toBe(false);
    expect(errors.filter((l) => l.startsWith("ALERT unmatched_payment"))).toHaveLength(1);
  });
});
