// CX5 unknown-user-before-pointer (lifecycle model counterexample, minimal repro).
// users=[new]. Stripe creates sub_1 (incomplete, metadata.user_id) and then sub_3 (trialing, NO metadata,
// e.g. created outside Checkout). sub_3's created event is delivered before any sub_1 event was applied, so
// no stripe_customers/<cus> pointer exists yet. Before the fix the event was answered 200 "no portal user"
// and Stripe never retried: the paying customer stayed on sandbox with no estate.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshStore } from "./helpers";
import { createUser, getUserById, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent } from "../src/lib/billing";
import { getEstate } from "../src/lib/estates";

const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const mkSub = (id: string, status: string, userId: string | null, customer = "cus_1") => ({
  id,
  status,
  customer,
  items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] },
  metadata: userId ? { user_id: userId } : {},
});

/** Stripe stand-in: the customer's subscriptions as Stripe knows them now. */
function stripeWith(subs: any[], calls: string[] = [], filterByCustomer = true) {
  return async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/v1/subscriptions") {
      const cus = u.searchParams.get("customer");
      return json(200, { object: "list", data: filterByCustomer ? subs.filter((s) => s.customer === cus) : subs, has_more: false });
    }
    const m = /^\/v1\/subscriptions\/([^/]+)$/.exec(u.pathname);
    const s = m && subs.find((x) => x.id === m[1]);
    return s ? json(200, s) : json(404, { error: { message: "no such subscription" } });
  };
}

const ev = (id: string, type: string, created: number, object: any) => ({ id, type, created, data: { object } });

describe("CX5 unknown-user-before-pointer", () => {
  let user: User;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, STRIPE_ENV);
    user = await createUser("cx5@example.com", "sufficiently-long-pass");
  });

  afterEach(() => {
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  });

  it("a granting no-metadata subscription delivered before the customer's first applied event still grants", async () => {
    const sub1 = mkSub("sub_1", "incomplete", user.id);
    const sub3 = mkSub("sub_3", "trialing", null);
    const deps = { cfg: stripeConfig()!, fly: null, fetchImpl: stripeWith([sub1, sub3]) as any };
    // delivery order reversed: sub_3 first, then sub_1 (minimal repro from the model explorer)
    const r3 = await handleStripeEvent(ev("evt_3", "customer.subscription.created", 1_700_000_002, sub3), deps);
    expect(r3.handled).toBe(true);
    const r1 = await handleStripeEvent(ev("evt_1", "customer.subscription.created", 1_700_000_000, sub1), deps);
    expect(r1.handled).toBe(false); // tracked only: not the user's current subscription, does not grant
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("operator");
    expect(u.billing).toMatchObject({ customer_id: "cus_1", subscription_id: "sub_3", status: "trialing" });
    expect(await getEstate(user.id)).not.toBeNull();
  });

  it("a customer whose subscriptions name no portal user is still acknowledged without a change", async () => {
    const sub3 = mkSub("sub_3", "active", null);
    const deps = { cfg: stripeConfig()!, fly: null, fetchImpl: stripeWith([sub3, mkSub("sub_9", "active", null)]) as any };
    const r = await handleStripeEvent(ev("evt_3", "customer.subscription.created", 1_700_000_002, sub3), deps);
    expect(r).toEqual({ handled: false, note: "no portal user for the subscription" });
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
    expect(await getEstate(user.id)).toBeNull();
  });

  it("a customer naming two different portal users is ambiguous and grants nobody", async () => {
    const other = await createUser("cx5-other@example.com", "sufficiently-long-pass");
    const sub3 = mkSub("sub_3", "active", null);
    const deps = { cfg: stripeConfig()!, fly: null, fetchImpl: stripeWith([mkSub("sub_1", "incomplete", user.id), mkSub("sub_2", "canceled", other.id), sub3]) as any };
    const r = await handleStripeEvent(ev("evt_3", "customer.subscription.created", 1_700_000_002, sub3), deps);
    expect(r.handled).toBe(false);
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
    expect((await getUserById(other.id))!.tier).toBe("sandbox");
  });

  it("another customer's subscription naming the user is never used (even if the list answer contains it)", async () => {
    const sub3 = mkSub("sub_3", "active", null, "cus_1");
    const deps = { cfg: stripeConfig()!, fly: null, fetchImpl: stripeWith([mkSub("sub_1", "active", user.id, "cus_OTHER"), sub3], [], false) as any };
    const r = await handleStripeEvent(ev("evt_3", "customer.subscription.created", 1_700_000_002, sub3), deps);
    expect(r.handled).toBe(false);
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
  });

  it("a Stripe failure during the lookup throws (the webhook answers 5xx and Stripe redelivers)", async () => {
    const sub3 = mkSub("sub_3", "trialing", null);
    const deps = { cfg: stripeConfig()!, fly: null, fetchImpl: (async () => json(500, { error: { message: "stripe down" } })) as any };
    await expect(handleStripeEvent(ev("evt_3", "customer.subscription.created", 1_700_000_002, sub3), deps)).rejects.toThrow();
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
  });

  it("the lookup is not made when the pointer already resolves the customer", async () => {
    const calls: string[] = [];
    const sub1 = mkSub("sub_1", "active", user.id);
    const deps = { cfg: stripeConfig()!, fly: null, fetchImpl: stripeWith([sub1], calls) as any };
    await handleStripeEvent(ev("evt_1", "customer.subscription.created", 1_700_000_000, sub1), deps); // sets the pointer
    const sub3 = mkSub("sub_3", "active", null);
    await handleStripeEvent(ev("evt_3", "customer.subscription.updated", 1_700_000_005, sub3), deps);
    expect(calls.filter((c) => new URL(c).pathname === "/v1/subscriptions")).toEqual([]);
  });
});
