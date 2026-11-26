// THE paid rule (review #29 r4 F1 / r5 B1), in its own module so the estate library (advanceEstate, the provisioning
// choke point) and the billing library (webhook, tick reconcile) apply the same definition without an import cycle.
import { portalStore } from "./store";
import { getUserById, type User } from "./users";

/**
 * Paid-subscription record (F2, keyed per SUBSCRIPTION by ruling Q3): a paid tier invoice (isTierPaymentInvoice) was
 * seen for this Stripe subscription. Create-only; it keeps the FIRST paid invoice.
 */
export const PAID_SUBSCRIPTIONS_PREFIX = "paid_subscriptions/";
export async function isPaidSubscription(subscriptionId: string): Promise<boolean> {
  const store = await portalStore();
  return Boolean(await store.get(PAID_SUBSCRIPTIONS_PREFIX + subscriptionId, { type: "json" }));
}

/**
 * THE rule for every driver that creates, provisions, resumes, revives or (from a test hold) releases an estate, and for
 * the tick's keep-it-running checks: the user's CURRENT subscription is ACTIVE, grants a paid tier, and has its own paid
 * invoice (paid_subscriptions/<sub>). trialing, past_due, an active subscription that never paid (a 100% coupon, a zero
 * first invoice) and a payment on an OLD subscription do not qualify.
 */
export async function mayRunEstate(u: User | null): Promise<boolean> {
  if (!u || u.tier === "sandbox" || !u.billing?.subscription_id || u.billing.status !== "active") return false;
  return isPaidSubscription(u.billing.subscription_id);
}

/** The same rule by user id (the estate library's provisioning gate). */
export async function mayRunEstateFor(userId: string): Promise<boolean> {
  return mayRunEstate(await getUserById(userId));
}

/** The fixed reason a parked record carries (no Fly call is made for it). */
export const PARKED_NOTE = "parked: provisioning waits for an active subscription with a paid invoice";
