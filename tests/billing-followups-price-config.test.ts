// Billing audit follow-up (review of PR 15): a Stripe price id configured for BOTH tiers is a config error.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import billingHandler from "../netlify/functions/billing.mts";
import healthHandler from "../netlify/functions/health.mts";
import { freshStore } from "./helpers";
import { stripeConfig } from "../src/lib/stripe";

const ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const EXTRA = ["STRIPE_PRICE_OPERATOR_ACCEPTED", "STRIPE_PRICE_SOVEREIGN_ACCEPTED"];
beforeEach(() => {
  freshStore();
  Object.assign(process.env, ENV);
});
afterEach(() => {
  for (const k of [...Object.keys(ENV), ...EXTRA]) delete process.env[k];
});

describe("a price id shared by both tiers fails closed like a missing billing config", () => {
  it("the same primary price for both tiers: not configured", () => {
    process.env.STRIPE_PRICE_SOVEREIGN = "price_op";
    expect(stripeConfig()).toBeNull();
  });
  it("an accepted id that is the other tier's primary or accepted id: not configured", () => {
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_op";
    expect(stripeConfig()).toBeNull();
    delete process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED;
    process.env.STRIPE_PRICE_OPERATOR_ACCEPTED = "price_dup";
    process.env.STRIPE_PRICE_SOVEREIGN_ACCEPTED = "price_dup";
    expect(stripeConfig()).toBeNull();
  });
  it("distinct ids (and a repeat within one tier) still configure", () => {
    process.env.STRIPE_PRICE_OPERATOR_ACCEPTED = "price_a,price_a,price_op";
    expect(stripeConfig()).not.toBeNull();
  });
  it("the endpoints answer billing_not_configured and health reports billing_configured false", async () => {
    process.env.STRIPE_PRICE_SOVEREIGN = "price_op";
    const res = await billingHandler(new Request("http://portal.test/api/billing/webhook", { method: "POST", body: "{}" }), {} as any);
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe("billing_not_configured");
    expect((await (await healthHandler(new Request("http://portal.test/api/health"), {} as any)).json()).billing_configured).toBe(false);
  });
});
