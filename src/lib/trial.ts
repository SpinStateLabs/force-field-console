// Force-Field Console — the free trial as the console shows it (owner decision 2026-11-22: the trial runs on the
// open-source install; the hosted dedicated estate starts with the FIRST PAYMENT).
import type { User } from "./users";
import { PRICE_BOOK } from "./pricebook";

export type TrialInfo = { ends_at: string | null; days_left: number | null; install_url: string };

const DAY_MS = 86_400_000;

/** The account's trial, or null when its subscription is not trialing. ends_at = the trialing period's end (Stripe). */
export function trialInfo(user: User, now: Date = new Date()): TrialInfo | null {
  if (user.billing?.status !== "trialing") return null;
  const ends = user.billing.current_period_end;
  const t = ends ? new Date(ends).getTime() : NaN;
  return {
    ends_at: Number.isFinite(t) ? new Date(t).toISOString() : null,
    days_left: Number.isFinite(t) ? Math.max(0, Math.floor((t - now.getTime()) / DAY_MS)) : null,
    install_url: PRICE_BOOK.free.install_url,
  };
}
