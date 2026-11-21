// Force-Field Console — tier definitions.
//
// Prices are NOT here: every price, minimum, trial and pack size is in src/lib/pricebook.ts.
// Only the Stripe webhook (src/lib/billing.ts) writes a paid tier.
//
// rpm/rpd are Declared limits enforced approximately by src/lib/ratelimit.ts
// (see the concurrency note there).

export const TIERS = {
  sandbox:   { label: "Sandbox",   rpm: 10,  rpd: 200 },
  operator:  { label: "Operator",  rpm: 60,  rpd: 5000 },
  sovereign: { label: "Estate", rpm: 300, rpd: 50000 },
} as const;
