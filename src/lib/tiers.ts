// Force-Field Console — tier definitions.
//
// price_cad_month values are DISPLAY copy for the landing page and dashboard (CAD, Don 2026-11-10).
// What is billed is the Stripe Price referenced by STRIPE_PRICE_OPERATOR /
// STRIPE_PRICE_SOVEREIGN (src/lib/stripe.ts); keep the two in agreement (those Prices must be CAD).
// Only the Stripe webhook (src/lib/billing.ts) writes a paid tier.
//
// rpm/rpd are Declared limits enforced approximately by src/lib/ratelimit.ts
// (see the concurrency note there).

/** Currency of every displayed price; the configured Stripe Prices must use it too. */
export const PRICE_CURRENCY = "CAD";

/**
 * Free days on a customer's FIRST subscription (Checkout subscription_data.trial_period_days). No card is required
 * during the trial and a trial that ends without a payment method cancels, so billing starts on day 61 only if the
 * customer chooses to continue (src/lib/stripe.ts createCheckoutSession).
 */
export const TRIAL_DAYS = 60;

export const TIERS = {
  sandbox:   { label: "Sandbox",   rpm: 10,  rpd: 200,   price_cad_month: 0 },
  operator:  { label: "Operator",  rpm: 60,  rpd: 5000,  price_cad_month: 49 },
  sovereign: { label: "Estate", rpm: 300, rpd: 50000, price_cad_month: 249 },
} as const;
