// Deploy step 0 of PR 29 (review #29 r4): estates that were provisioned before the paid marker existed have no
// paid_subscriptions/<sub> record, so mayRunEstate() is false for them and the tick will no longer restart them. This
// module PLANS the backfill (read-only: the store's estates and users, Stripe's subscriptions and paid invoices) and,
// only when asked, APPLIES it: create-only paid_subscriptions/<sub> records and nothing else.
// It never prints or stores an email, a key or a customer's card data; rows name user ids, subscription and invoice ids.
import { portalStore } from "./store";
import { getUserById } from "./users";
import { listEstates } from "./estates";
import { stripeRequest, StripeError, type StripeConfig } from "./stripe";
import { PAID_SUBSCRIPTIONS_PREFIX, flyHeld, isPaidSubscription, isTierPaymentInvoice } from "./billing";

type FetchLike = (url: string, init?: any) => Promise<Response>;

export type BackfillRow = {
  user_id: string;
  estate_status: string;
  /** "current": the user's billing.subscription_id; "remembered": one of billing.other_subs (a hand-over candidate). */
  role: "current" | "remembered";
  subscription_id: string | null;
  subscription_status: string | null;
  /** The OLDEST paid invoice of this subscription that is a tier payment (isTierPaymentInvoice), or null. */
  paid_invoice: string | null;
  /** "write" only when a record is missing AND Stripe shows a qualifying invoice; every other row says why not. */
  action: "write" | "skip";
  reason: string;
  /** The record --apply would create (create-only), when action is "write". */
  would_write?: { key: string; value: { customer: string; first_paid_invoice: string; at: string } };
};

/** What the new rule does to each estate record once the planned records exist (the dry run lists it; nothing acts). */
export type EstateOutlook = {
  user_id: string;
  estate_status: string;
  subscription_id: string | null;
  subscription_status: string | null;
  /** True when the current subscription is active AND paid (already recorded, or written by this backfill). */
  may_run: boolean;
  outlook: "runs" | "resumes (suspended; owner active and paid)" | "held (test-mode grant; starts only after a live-mode grant)" | "parked (no provisioning)" | "suspended on the next subscription event" | "kept running (paid, not active)" | "stays suspended" | "unchanged";
};

export type BackfillPlan = { rows: BackfillRow[]; estates: EstateOutlook[] };

/** Every paid invoice of a subscription, oldest first (all pages). */
export async function paidInvoicesOf(cfg: StripeConfig, subscriptionId: string, fetchImpl: FetchLike = fetch): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await stripeRequest(cfg, "GET", "/v1/invoices", { subscription: subscriptionId, status: "paid", limit: 100, starting_after: after }, fetchImpl);
    const data: any[] = Array.isArray(r?.data) ? r.data : [];
    out.push(...data);
    if (!r?.has_more || data.length === 0) break;
    after = String(data[data.length - 1].id);
  }
  return out.sort((a, b) => Number(a?.created ?? 0) - Number(b?.created ?? 0));
}

/**
 * The selection rule for one subscription (pure; unit-tested with fixtures): the oldest invoice that names THIS
 * subscription and THIS customer and is a tier payment by the same test the invoice.paid handler applies.
 */
/** The subscription an invoice names: the old top-level field or parent.subscription_details, an id or an expanded object. */
export function invoiceSubscription(inv: any): string | null {
  const ref = inv?.subscription ?? inv?.parent?.subscription_details?.subscription ?? null;
  return typeof ref === "string" ? ref : ref?.id ?? null;
}

export function selectFirstTierPayment(invoices: any[], subscriptionId: string, customer: string, cfg: StripeConfig): any | null {
  const subOf = invoiceSubscription;
  const cusOf = (inv: any) => (typeof inv?.customer === "string" ? inv.customer : inv?.customer?.id ?? null);
  const sorted = [...invoices].sort((a, b) => Number(a?.created ?? 0) - Number(b?.created ?? 0));
  return sorted.find((inv) => subOf(inv) === subscriptionId && cusOf(inv) === customer && isTierPaymentInvoice(inv, cfg)) ?? null;
}

/** One subscription's row: is a record missing, and does Stripe show a qualifying paid invoice for it? */
async function planSubscription(
  cfg: StripeConfig,
  base: { user_id: string; estate_status: string; role: "current" | "remembered" },
  subId: string,
  expectCustomer: string | null,
  now: Date,
  fetchImpl: FetchLike,
): Promise<BackfillRow> {
  const row = { ...base, subscription_id: subId, subscription_status: null as string | null, paid_invoice: null, action: "skip" as const };
  if (await isPaidSubscription(subId)) return { ...row, reason: "paid record already exists" };
  let sub: any;
  try {
    sub = await stripeRequest(cfg, "GET", `/v1/subscriptions/${encodeURIComponent(subId)}`, undefined, fetchImpl);
  } catch (err) {
    if (err instanceof StripeError && err.status === 404) return { ...row, reason: "Stripe does not know the subscription" };
    throw err; // anything else stops the plan: a partial plan is never applied
  }
  const customer = typeof sub?.customer === "string" ? sub.customer : sub?.customer?.id ?? null;
  const withStatus = { ...row, subscription_status: String(sub?.status ?? "") };
  if (!customer || customer !== expectCustomer) return { ...withStatus, reason: "the subscription's customer does not match the user's billing" };
  const invoices = await paidInvoicesOf(cfg, subId, fetchImpl);
  const inv = selectFirstTierPayment(invoices, subId, customer, cfg);
  if (!inv) {
    const truncated = invoices.some((i) => invoiceSubscription(i) === subId && i?.lines?.has_more === true);
    return { ...withStatus, reason: truncated ? "no qualifying invoice on the first page of lines (lines truncated): check by hand" : "no paid invoice with a positive NET tier line in the price book currency" };
  }
  return {
    ...withStatus,
    paid_invoice: String(inv.id),
    action: "write",
    reason: "record missing; a qualifying paid invoice exists",
    would_write: { key: PAID_SUBSCRIPTIONS_PREFIX + subId, value: { customer, first_paid_invoice: String(inv.id), at: now.toISOString() } },
  };
}

/**
 * Read-only plan. For every estate record: one row for the user's CURRENT subscription and one for each REMEMBERED
 * subscription (billing.other_subs), each confirmed in Stripe (never derived from "an estate exists"); then what the
 * new rule does to that estate once the planned records exist.
 */
export async function planBackfill(cfg: StripeConfig, now: Date = new Date(), fetchImpl: FetchLike = fetch): Promise<BackfillPlan> {
  const rows: BackfillRow[] = [];
  const estates: EstateOutlook[] = [];
  for (const e of await listEstates()) {
    const u = await getUserById(e.user_id);
    const b = u?.billing ?? null;
    const subId = b?.subscription_id ?? null;
    const base = { user_id: e.user_id, estate_status: e.status };
    if (!u || !subId) {
      rows.push({ ...base, role: "current", subscription_id: null, subscription_status: null, paid_invoice: null, action: "skip", reason: u ? "the user has no subscription" : "no user record for the estate" });
    } else {
      rows.push(await planSubscription(cfg, { ...base, role: "current" }, subId, b!.customer_id ?? null, now, fetchImpl));
      for (const other of Object.keys(b!.other_subs ?? {})) {
        rows.push(await planSubscription(cfg, { ...base, role: "remembered" }, other, b!.customer_id ?? null, now, fetchImpl));
      }
    }
    const cur = rows.find((r) => r.user_id === e.user_id && r.role === "current")!;
    const paidAfter = !!subId && (cur.reason === "paid record already exists" || cur.action === "write");
    const granting = !!u && u.tier !== "sandbox" && !!b && ["active", "trialing", "past_due"].includes(b.status);
    const mayRun = granting && b!.status === "active" && paidAfter;
    const outlook: EstateOutlook["outlook"] = e.test_hold || flyHeld(u ?? null)
      ? "held (test-mode grant; starts only after a live-mode grant)"
      : mayRun && e.status === "suspended"
        ? "resumes (suspended; owner active and paid)"
        : mayRun
      ? "runs"
      : e.status === "provisioning" || e.status === "pending_manual" || e.status === "error"
        ? granting && paidAfter && e.status === "error"
          ? "unchanged"
          : "parked (no provisioning)"
        : e.status === "ready"
          ? granting && paidAfter ? "kept running (paid, not active)" : granting ? "suspended on the next subscription event" : "unchanged"
          : e.status === "suspended" ? "stays suspended" : "unchanged";
    estates.push({ user_id: e.user_id, estate_status: e.status, subscription_id: subId, subscription_status: b?.status ?? null, may_run: mayRun, outlook });
  }
  return { rows, estates };
}

/** --apply: create-only writes of the planned paid_subscriptions records; nothing else is written. */
export async function applyBackfill(plan: BackfillPlan | BackfillRow[]): Promise<{ written: number; already: number }> {
  const rows = Array.isArray(plan) ? plan : plan.rows;
  const store = await portalStore();
  let written = 0;
  let already = 0;
  for (const r of rows) {
    if (r.action !== "write" || !r.would_write) continue;
    if (!r.would_write.key.startsWith(PAID_SUBSCRIPTIONS_PREFIX)) throw new Error("backfill may only write paid_subscriptions/ records");
    if (await store.setJSONIfNew(r.would_write.key, r.would_write.value)) written += 1;
    else already += 1;
  }
  return { written, already };
}
