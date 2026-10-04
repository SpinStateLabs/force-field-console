// Force-Field Console — tier definitions.
//
// price_usd_month values are DISPLAY copy for the landing page and dashboard.
// What is billed is the Stripe Price referenced by STRIPE_PRICE_OPERATOR /
// STRIPE_PRICE_SOVEREIGN (src/lib/stripe.ts); keep the two in agreement.
// Only the Stripe webhook (src/lib/billing.ts) writes a paid tier.
//
// rpm/rpd are Declared limits enforced approximately by src/lib/ratelimit.ts
// (see the concurrency note there).

export const TIERS = {
  sandbox:   { label: "Sandbox",   rpm: 10,  rpd: 200,   price_usd_month: 0 },
  operator:  { label: "Operator",  rpm: 60,  rpd: 5000,  price_usd_month: 49 },
  sovereign: { label: "Sovereign", rpm: 300, rpd: 50000, price_usd_month: 249 },
} as const;
