// Billing audit follow-up (review of PR 15): a Stripe price id configured for BOTH tiers is a config error that is
// alerted, not a billing outage. The shared id maps to no tier; every other price, the webhook and cancellations keep
// working; Checkout refuses a tier whose own sale price is shared; /api/health reports price_config_shared.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import billingHandler from "../netlify/functions/billing.mts";
import healthHandler from "../netlify/functions/health.mts";
import { freshStore } from "./helpers";
import { createUser, getUserById } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { sharedPriceIds, signPayload, stripeConfig, tierForPrice } from "../src/lib/stripe";

const ctx = {} as any;
const ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const EXTRA = ["STRIPE_PRICE_OPERATOR_ACCEPTED", "STRIPE_PRICE_SOVEREIGN_ACCEPTED"];
beforeEach(() => {
  freshStore();
  Object.assign(process.env, ENV);
});
afterEach(() => {
  for (const k of [...Object.keys(ENV), ...EXTRA]) delete process.env[k];
  vi.restoreAllMocks();
});

async function health(): Promise<any> {
  return (await healthHandler(new Request("http://portal.test/api/health"), ctx)).json();
}

async function webhook(event: unknown): Promise<Response> {
  const raw = JSON.stringify(event);
  const sig = signPayload(raw, "whsec_test", Math.floor(Date.now() / 1000));
  return billingHandler(new Request("http://portal.test/api/billing/webhook", { method: "POST", headers: { "stripe-signature": sig }, body: raw }), ctx);
}

function sub(priceId: string, userId: string, status = "active") {
  return { id: "sub_1", status, customer: "cus_1", items: { data: [{ price: { id: priceId }, current_period_end: 1_800_000_000 }] }, metadata: { user_id: userId } };
}

describe("a price id shared by both tiers: alerted, billing stays on", () => {
  it("the same sale price for both tiers: configured, and that id maps to no tier", () => {
    process.env.STRIPE_PRICE_SOVEREIGN = "price_op";
    const cfg = stripeConfig()!;
    expect(cfg).not.toBeNull();
    expect(sharedPriceIds(cfg)).toEqual(["price_op"]);
    expect(tierForPrice(cfg, "price_op")).toBeNull();
  });

  it("an id in both accepted lists maps to no tier; the other prices keep their tier", () => {
    process.env.STRIPE_PRICE_OPERATOR_ACCEPTED = "price_dup,price_old_op";
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_dup";
    const cfg = stripeConfig()!;
    expect(sharedPriceIds(cfg)).toEqual(["price_dup"]);
    expect(tierForPrice(cfg, "price_dup")).toBeNull();
    expect(tierForPrice(cfg, "price_op")).toBe("operator");
    expect(tierForPrice(cfg, "price_old_op")).toBe("operator");
    expect(tierForPrice(cfg, "price_sov")).toBe("sovereign");
  });

  it("distinct ids (and a repeat within one tier) are not shared", () => {
    process.env.STRIPE_PRICE_OPERATOR_ACCEPTED = "price_a,price_a,price_op";
    expect(sharedPriceIds(stripeConfig()!)).toEqual([]);
  });

  it("one ALERT price_config_shared per process for a shared set, without the ids", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.STRIPE_PRICE_OPERATOR_ACCEPTED = "price_alert_once";
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_alert_once";
    stripeConfig();
    stripeConfig();
    const alerts = spy.mock.calls.filter((c) => c[0] === "ALERT price_config_shared");
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(String(alerts[0][1]))).toEqual({ key: "price_config_shared", shared_ids: 1, sale_price_shared: false });
    expect(String(alerts[0][1])).not.toContain("price_alert_once");
  });

  it("a sound configuration logs no ALERT", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    stripeConfig();
    expect(spy.mock.calls.filter((c) => c[0] === "ALERT price_config_shared")).toHaveLength(0);
  });

  it("health: price_config_shared is true when shared, false when sound, null when billing is not configured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await health()).toMatchObject({ billing_configured: true, price_config_shared: false });
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_op";
    expect(await health()).toMatchObject({ billing_configured: true, price_config_shared: true });
    delete process.env.STRIPE_PRICE_SOVEREIGN;
    expect(await health()).toMatchObject({ billing_configured: false, price_config_shared: null });
  });

  it("the webhook stays on: a subscription on an unshared price is granted and its cancellation is applied", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.STRIPE_PRICE_OPERATOR_ACCEPTED = "price_dup";
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_dup";
    const user = await createUser("shared@example.com", "sufficiently-long-pass");

    const granted = await webhook({ id: "evt_s1", type: "customer.subscription.updated", created: 100, data: { object: sub("price_op", user.id) } });
    expect(granted.status).toBe(200);
    expect((await getUserById(user.id))!.tier).toBe("operator");

    const cancelled = await webhook({ id: "evt_s2", type: "customer.subscription.deleted", created: 200, data: { object: sub("price_op", user.id, "canceled") } });
    expect(cancelled.status).toBe(200);
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
  });

  it("Checkout refuses a tier whose own sale price is shared, before any Stripe call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("no Stripe call is expected");
    });
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_op"; // the operator sale price is also a sovereign price
    const user = await createUser("buy@example.com", "sufficiently-long-pass");
    const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
    const res = await billingHandler(new Request("http://portal.test/api/billing/checkout", { method: "POST", headers: { cookie }, body: JSON.stringify({ tier: "operator" }) }), ctx);
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe("billing_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Checkout for the other tier, whose sale price is not shared, still reaches Stripe with its own price", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let sent = "";
    vi.spyOn(globalThis, "fetch").mockImplementation((async (_url: any, init?: any) => {
      sent = String(init?.body ?? "");
      return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any);
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_op"; // only the operator sale price is shared
    const user = await createUser("buy2@example.com", "sufficiently-long-pass");
    const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
    const res = await billingHandler(new Request("http://portal.test/api/billing/checkout", { method: "POST", headers: { cookie }, body: JSON.stringify({ tier: "sovereign" }) }), ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe("https://checkout.stripe.com/c/cs_1");
    expect(new URLSearchParams(sent).get("line_items[0][price]")).toBe("price_sov");
  });

  it("the ALERT says sale_price_shared:true when a tier's own sale price is the shared id", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.STRIPE_PRICE_OPERATOR = "price_sale_shared";
    process.env.STRIPE_PRICE_SOVEREIGN = "price_sale_shared";
    stripeConfig();
    const alerts = spy.mock.calls.filter((c) => c[0] === "ALERT price_config_shared");
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(String(alerts[0][1]))).toEqual({ key: "price_config_shared", shared_ids: 1, sale_price_shared: true });
  });

  it("a subscription ON the shared id never grants a tier: a new user stays sandbox, flagged and alerted", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.STRIPE_PRICE_OPERATOR_ACCEPTED = "price_dup";
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_dup";
    const user = await createUser("onshared@example.com", "sufficiently-long-pass");

    const res = await webhook({ id: "evt_d1", type: "customer.subscription.updated", created: 100, data: { object: sub("price_dup", user.id) } });
    expect(res.status).toBe(200);
    const after = (await getUserById(user.id))!;
    expect(after.tier).toBe("sandbox");
    expect(after.billing?.price_unmatched).toBe(true);
    expect(spy.mock.calls.filter((c) => c[0] === "ALERT unmatched_price")).toHaveLength(1);
    expect(await health()).toMatchObject({ unmatched_price: true });
  });

  it("a paying customer whose active subscription moves onto the shared id keeps the tier (H1 keep rule)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.STRIPE_PRICE_OPERATOR_ACCEPTED = "price_dup";
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_dup";
    const user = await createUser("keep@example.com", "sufficiently-long-pass");

    expect((await webhook({ id: "evt_k1", type: "customer.subscription.updated", created: 100, data: { object: sub("price_op", user.id) } })).status).toBe(200);
    expect((await getUserById(user.id))!.tier).toBe("operator");

    expect((await webhook({ id: "evt_k2", type: "customer.subscription.updated", created: 200, data: { object: sub("price_dup", user.id) } })).status).toBe(200);
    const after = (await getUserById(user.id))!;
    expect(after.tier).toBe("operator");
    expect(after.billing?.price_unmatched).toBe(true);
  });
});
