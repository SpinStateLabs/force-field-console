// Force-Field Console — Stripe billing client.
//
// Plain REST over fetch (form-encoded requests, JSON responses); no SDK, so
// every call is mockable with a stubbed fetch and nothing is bundled that the
// functions do not use. Webhook signatures are verified by hand per Stripe's
// documented scheme (t=<ts>,v1=<hmac-sha256 hex of "<ts>.<raw body>">).
//
// Billing is CONFIGURED only when all four variables are set:
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_OPERATOR,
//   STRIPE_PRICE_SOVEREIGN
// Otherwise stripeConfig() is null and the billing endpoints answer
// 501 billing_not_configured — the honest state, never a half-wired one.

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./store";
import type { Tier } from "./users";

export const STRIPE_API = "https://api.stripe.com";
export const SIGNATURE_TOLERANCE_S = 300;

export type PaidTier = Exclude<Tier, "sandbox">;

export type StripeConfig = {
  secret_key: string;
  webhook_secret: string;
  prices: Record<PaidTier, string>;
};

/** The billing configuration, or null when any variable is missing. */
export function stripeConfig(): StripeConfig | null {
  const secret_key = env("STRIPE_SECRET_KEY");
  const webhook_secret = env("STRIPE_WEBHOOK_SECRET");
  const operator = env("STRIPE_PRICE_OPERATOR");
  const sovereign = env("STRIPE_PRICE_SOVEREIGN");
  if (!secret_key || !webhook_secret || !operator || !sovereign) return null;
  return { secret_key, webhook_secret, prices: { operator, sovereign } };
}

/** Map a Stripe price id to a paid tier; null for an unknown price. */
export function tierForPrice(cfg: StripeConfig, priceId: string | null | undefined): PaidTier | null {
  if (!priceId) return null;
  if (priceId === cfg.prices.operator) return "operator";
  if (priceId === cfg.prices.sovereign) return "sovereign";
  return null;
}

export class StripeError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** application/x-www-form-urlencoded, Stripe style (bracketed nested keys are literal). */
export function encodeForm(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
  }
  return parts.join("&");
}

export async function stripeRequest(
  cfg: StripeConfig,
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  fetchImpl: FetchLike = fetch,
  idempotencyKey?: string,
): Promise<any> {
  const headers: Record<string, string> = { authorization: `Bearer ${cfg.secret_key}` };
  if (idempotencyKey && method === "POST") headers["idempotency-key"] = idempotencyKey;
  let body: string | undefined;
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = encodeForm(params ?? {});
  }
  const url = STRIPE_API + path + (method === "GET" && params ? "?" + encodeForm(params) : "");
  let res: Response;
  try {
    res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
  } catch (e: any) {
    throw new StripeError(0, "stripe_unreachable", `Stripe could not be reached (${e?.name ?? "error"}).`);
  }
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    throw new StripeError(
      res.status,
      parsed?.error?.code ?? "stripe_error",
      parsed?.error?.message ?? `Stripe answered HTTP ${res.status}.`,
    );
  }
  return parsed;
}

export type CheckoutArgs = {
  user_id: string;
  email: string;
  customer_id?: string | null;
  tier: PaidTier;
  success_url: string;
  cancel_url: string;
  /** Stripe Idempotency-Key for the session creation (derived from the checkout claim token). */
  idempotency_key?: string;
};

/** Create a subscription Checkout Session; returns its hosted URL. */
export async function createCheckoutSession(
  cfg: StripeConfig,
  args: CheckoutArgs,
  fetchImpl: FetchLike = fetch,
): Promise<{ id: string; url: string }> {
  const params: Record<string, string | number> = {
    mode: "subscription",
    "line_items[0][price]": cfg.prices[args.tier],
    "line_items[0][quantity]": 1,
    success_url: args.success_url,
    cancel_url: args.cancel_url,
    client_reference_id: args.user_id,
    "metadata[user_id]": args.user_id,
    "metadata[tier]": args.tier,
    "subscription_data[metadata][user_id]": args.user_id,
    "subscription_data[metadata][tier]": args.tier,
  };
  if (args.customer_id) params.customer = args.customer_id;
  else params.customer_email = args.email;
  const session = await stripeRequest(cfg, "POST", "/v1/checkout/sessions", params, fetchImpl, args.idempotency_key);
  if (!session?.url || !session?.id) {
    throw new StripeError(502, "stripe_bad_response", "Stripe returned a Checkout Session without a URL.");
  }
  return { id: session.id, url: session.url };
}

/** Create a Customer Portal session (plan changes, payment method, cancel). */
export async function createPortalSession(
  cfg: StripeConfig,
  customer_id: string,
  return_url: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ url: string }> {
  const s = await stripeRequest(cfg, "POST", "/v1/billing_portal/sessions", { customer: customer_id, return_url }, fetchImpl);
  if (!s?.url) throw new StripeError(502, "stripe_bad_response", "Stripe returned a portal session without a URL.");
  return { url: s.url };
}

export type StripeSubscription = {
  id: string;
  status: string;
  customer: string;
  items?: { data?: { price?: { id?: string }; current_period_end?: number }[] };
  current_period_end?: number;
  metadata?: Record<string, string>;
};

export async function getSubscription(cfg: StripeConfig, id: string, fetchImpl: FetchLike = fetch): Promise<StripeSubscription> {
  return (await stripeRequest(cfg, "GET", `/v1/subscriptions/${encodeURIComponent(id)}`, undefined, fetchImpl)) as StripeSubscription;
}

/** All of a customer's subscriptions (any status, first 100: one customer never has more here). */
export async function listCustomerSubscriptions(cfg: StripeConfig, customer: string, fetchImpl: FetchLike = fetch): Promise<StripeSubscription[]> {
  const r = await stripeRequest(cfg, "GET", "/v1/subscriptions", { customer, status: "all", limit: 100 }, fetchImpl);
  return Array.isArray(r?.data) ? (r.data as StripeSubscription[]) : [];
}

export function subscriptionPriceId(sub: StripeSubscription): string | null {
  return sub.items?.data?.[0]?.price?.id ?? null;
}

/** Period end as unix seconds; newer API versions carry it on the item. */
export function subscriptionPeriodEnd(sub: StripeSubscription): number | null {
  const top = sub.current_period_end;
  if (typeof top === "number") return top;
  const item = sub.items?.data?.[0]?.current_period_end;
  return typeof item === "number" ? item : null;
}

/** Statuses under which the paid tier is granted (past_due rides Stripe's retry window). */
export const GRANTING_STATUSES = new Set(["active", "trialing", "past_due"]);

export function parseSignatureHeader(header: string | null): { t: number; v1: string[] } | null {
  if (!header) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") v1.push(v);
  }
  if (t === null || !Number.isFinite(t) || v1.length === 0) return null;
  return { t, v1 };
}

/**
 * Verify a Stripe-Signature header against the RAW request body.
 * Constant-time comparison; rejects timestamps outside the tolerance.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowS: number = Math.floor(Date.now() / 1000),
  toleranceS: number = SIGNATURE_TOLERANCE_S,
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (Math.abs(nowS - parsed.t) > toleranceS) return false;
  const expected = createHmac("sha256", secret).update(`${parsed.t}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  for (const sig of parsed.v1) {
    const sigBuf = Buffer.from(sig, "utf8");
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) return true;
  }
  return false;
}

/** Build a Stripe-Signature header (tests and local rehearsal only). */
export function signPayload(rawBody: string, secret: string, tS: number): string {
  const v1 = createHmac("sha256", secret).update(`${tS}.${rawBody}`).digest("hex");
  return `t=${tS},v1=${v1}`;
}
