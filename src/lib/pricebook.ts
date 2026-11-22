// Force-Field Console — the price book. EVERY price, minimum, trial length and pack size lives here, so a change is
// one line (rev 2, controller 2026-11-21 from Don's decisions; [Don] = his, [rec] = accepted recommendation).
// What is billed is the Stripe Price the STRIPE_PRICE_* variables name (src/lib/stripe.ts): each is a PER-SEAT Price
// (per-agent-pack for STRIPE_PRICE_PACK*), sold with quantity = seats. Keep those Prices in agreement with this file.
// The pages show these numbers as copy; tests/pricing-per-seat.test.ts fails when a page drifts from this object.

export const PRICE_BOOK = {
  /** [rec, flagged] Force-Field's currency of record. */
  currency: "CAD",
  /** [Don] free days on a customer's FIRST subscription; no card up front, cancels at the end without one. */
  trial_days: 30,
  /** [Don] paying a year at once: 10% off. */
  annual_discount: 0.1,
  /** [Don] the free tier is the open-source product: the pricing page links to its install instructions. */
  free: { install_url: "https://github.com/SpinStateLabs/Force-Field#install-the-marketplace" },
  /** Self-serve tiers, keyed by the internal tier id. Prices are per seat per month. */
  tiers: {
    /** [Don 2026-11-21, rev 4] 1 to 2 seats; a pool of 5 governed agents PER SEAT. */
    operator: { seat_month: 24, min_seats: 1, max_seats: 2 as number | null, agents_base: 0, agents_per_seat: 5 },
    /** [Don] minimum 3 seats; [record 2026-11-10] a pool of 20 agents per seat. Display label "Estate". */
    sovereign: { seat_month: 24, min_seats: 3, max_seats: null as number | null, agents_base: 0, agents_per_seat: 20 },
  },
  /** [Don 2026-11-21] contact sales (no self-serve checkout): 32 per seat, minimum 25 seats; pool sized by contract. */
  enterprise: { seat_month: 32, min_seats: 25 },
  /** [Don structure, rec numbers] top-up pack: +20 agents to the pool for the billing period, a second subscription item;
   *  max_packs [rec] caps one account's self-serve packs (more goes through sales); max_per_seat [Don 2026-11-21, rev 4]
   *  caps packs at one per seat, so a pool can at most double for Estate. */
  pack: { agents: 20, month: 12, max_packs: 50, max_per_seat: 1 },
} as const;

export type SelfServeTier = keyof typeof PRICE_BOOK.tiers;

const cents = (x: number) => Math.round(x * 100) / 100;

/** Per-seat monthly equivalent when paid annually (10% off). */
export function annualSeatMonth(monthly: number): number {
  return cents(monthly * (1 - PRICE_BOOK.annual_discount));
}

/** Per-seat price for a year paid at once (12 months, 10% off). */
export function annualSeatYear(monthly: number): number {
  return cents(monthly * 12 * (1 - PRICE_BOOK.annual_discount));
}

/** Seats a checkout may buy for a tier (max null = no upper bound). */
export function seatBounds(tier: SelfServeTier): { min: number; max: number | null } {
  const t = PRICE_BOOK.tiers[tier];
  return { min: t.min_seats, max: t.max_seats };
}

/** Most packs an account with `seats` seats may hold: one per seat (rev 4), and never more than max_packs. */
export function maxPacksFor(seats: number): number {
  return Math.min(Math.max(0, seats) * PRICE_BOOK.pack.max_per_seat, PRICE_BOOK.pack.max_packs);
}

/**
 * Governed agents the account may run: the tier's base plus per-seat pool, plus packs. Packs beyond maxPacksFor(seats)
 * (seats lowered in the Stripe portal after packs were bought) do not count; the webhook flags that state.
 */
export function agentPool(tier: SelfServeTier, seats: number, packs: number): number {
  const t = PRICE_BOOK.tiers[tier];
  const counted = Math.min(Math.max(0, packs), maxPacksFor(seats));
  return t.agents_base + t.agents_per_seat * Math.max(0, seats) + PRICE_BOOK.pack.agents * counted;
}
