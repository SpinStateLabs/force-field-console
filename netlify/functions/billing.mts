// billing.mts — Force-Field Console v0.2.0
// Stripe billing: Checkout Session creation, Customer Portal sessions, and the
// signed webhook that is the only writer of paid tiers. Every endpoint answers
// 501 billing_not_configured until the four STRIPE_* variables are set — never
// a half-wired path. Never log request bodies, signatures or keys.
import type { Context, Config } from "@netlify/functions";
import { readSession } from "../../src/lib/session";
import { getUserById } from "../../src/lib/users";
import type { User } from "../../src/lib/users";
import { env } from "../../src/lib/store";
import {
  GRANTING_STATUSES,
  StripeError,
  createCheckoutSession,
  createPortalSession,
  getSubscription,
  packPriceIds,
  salePrice,
  stripeConfig,
  stripeRequest,
  tierForPrice,
  verifyStripeSignature,
} from "../../src/lib/stripe";
import { checkoutIdempotencyKey, claimPacks, newPacksIdempotencyKey, releasePacks, claimCheckout, claimEvent, eventDone, handleStripeEvent, markProcessed, releaseCheckout, releaseEvent } from "../../src/lib/billing";
import { flyClientOrNull } from "../../src/lib/fly";
import { PRICE_BOOK, maxPacksFor, seatBounds } from "../../src/lib/pricebook";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function err(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

const NOT_CONFIGURED = "Payments are not configured on this deployment yet; paid tiers are not for sale here.";

async function requireUser(req: Request): Promise<User | null> {
  const userId = await readSession(req);
  return userId ? await getUserById(userId) : null;
}

/** The site's own origin for Stripe redirects: Netlify's URL variable, else the request origin. */
export function siteOrigin(req: Request): string {
  const configured = env("URL");
  if (configured && /^https?:\/\//.test(configured)) return configured.replace(/\/+$/, "");
  return new URL(req.url).origin;
}

export default async (req: Request, _context: Context): Promise<Response> => {
  const pathname = new URL(req.url).pathname;
  if (req.method !== "POST") {
    return err(405, "method_not_allowed", "Use POST for this endpoint.");
  }
  const cfg = stripeConfig();

  // --- Stripe -> portal: signed webhook (no session; signature is the auth) ---
  if (pathname === "/api/billing/webhook") {
    if (!cfg) return err(501, "billing_not_configured", NOT_CONFIGURED);
    const raw = await req.text();
    if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), cfg.webhook_secret)) {
      return err(400, "bad_signature", "Stripe-Signature verification failed.");
    }
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return err(400, "bad_json", "Webhook body must be JSON.");
    }
    if (typeof event?.id !== "string" || typeof event?.type !== "string") {
      return err(400, "bad_event", "Webhook body is not a Stripe event.");
    }
    // Create-only claim: a redelivery (or a concurrent delivery) of the same event id is a no-op.
    if (!(await claimEvent(event.id, event.type))) {
      // Only a "done" record is a duplicate. A claim still "processing" may belong to a delivery
      // that was killed (no finally runs); a 2xx here would make Stripe stop retrying and lose the
      // event. Answer non-2xx so Stripe retries; once the claim is stale its retry takes it over.
      if (await eventDone(event.id)) return json(200, { received: true, duplicate: true });
      return err(409, "event_in_progress", "This event is still being applied; Stripe will retry.");
    }
    try {
      const outcome = await handleStripeEvent(event, { cfg, fly: flyClientOrNull() });
      await markProcessed(event.id, event.type);
      return json(200, { received: true, ...outcome });
    } catch (e: any) {
      // A 5xx makes Stripe retry; release the claim so that retry can apply the event.
      await releaseEvent(event.id).catch((re: any) =>
        console.error("billing webhook: RELEASE of the claim failed for", event.id, "- the retry takes it over after 10 min:", re?.message ?? re),
      );
      console.error("billing webhook: handling failed for", event.type, "-", e?.message ?? e);
      return err(500, "webhook_failed", "The event could not be applied; Stripe will retry.");
    }
  }

  // --- portal user -> Stripe: session-authenticated ---
  const user = await requireUser(req);
  if (!user) return err(401, "unauthenticated", "Sign in to manage billing.");
  if (!cfg) return err(501, "billing_not_configured", NOT_CONFIGURED);
  const origin = siteOrigin(req);

  try {
    if (pathname === "/api/billing/checkout") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return err(400, "bad_json", "Request body must be valid JSON.");
      }
      const tier = body?.tier;
      if (tier !== "operator" && tier !== "sovereign") {
        return err(400, "bad_tier", "tier must be \"operator\" or \"sovereign\".");
      }
      // Billing interval: "month" (default, also when absent) or "year" (annual, 10% off). Anything else is refused.
      const interval = body?.interval === undefined ? "month" : body.interval;
      if (interval !== "month" && interval !== "year") {
        return err(400, "bad_interval", "interval must be \"month\" or \"year\".");
      }
      // Seats: an integer within the tier's bounds (src/lib/pricebook.ts); absent = the tier's minimum. Enforced here,
      // server side, whatever the page sent.
      const bounds = seatBounds(tier);
      const seats = body?.seats === undefined ? bounds.min : body.seats;
      if (!Number.isInteger(seats) || seats < bounds.min || (bounds.max !== null && seats > bounds.max)) {
        const range = bounds.max === null ? `at least ${bounds.min}` : `${bounds.min} to ${bounds.max}`;
        return err(400, "bad_seats", `seats must be a whole number, ${range} for this plan.`);
      }
      const price = salePrice(cfg, tier, interval);
      if (!price) {
        return err(501, "annual_not_configured", "Annual billing is not configured on this deployment yet; choose monthly.");
      }
      // A sale price that is also configured for another purpose maps to no tier: selling it would take money and
      // grant nothing. Refuse that tier until STRIPE_PRICE_* is fixed (ALERT price_config_shared is in the log).
      if (tierForPrice(cfg, price) !== tier) {
        return err(501, "billing_not_configured", NOT_CONFIGURED);
      }
      if (user.billing?.subscription_id && GRANTING_STATUSES.has(user.billing.status)) {
        return err(409, "already_subscribed", "You already have a subscription; use Manage billing to change plans.");
      }
      // Create-only, short-TTL claim per user: two concurrent requests (a double click, two tabs)
      // must not each open a Stripe Checkout Session and risk two subscriptions.
      const claim = await claimCheckout(user.id);
      if (!claim) {
        return err(409, "checkout_in_progress", "A checkout for this account was just started; finish it, or try again in a minute.");
      }
      try {
        const session = await createCheckoutSession(cfg, {
          user_id: user.id,
          email: user.email,
          customer_id: user.billing?.customer_id ?? null,
          tier,
          success_url: origin + "/app.html?checkout=success",
          cancel_url: origin + "/app.html?checkout=cancelled",
          seats,
          interval,
          idempotency_key: checkoutIdempotencyKey(user.id, tier, user.billing?.customer_id ?? null, new Date(), interval, seats),
          // The free trial is for a FIRST subscription only: an account that already has a Stripe customer
          // (an earlier subscription, cancelled or not) gets none.
          trial_days: user.billing?.customer_id ? 0 : PRICE_BOOK.trial_days,
        });
        return json(200, { url: session.url });
      } catch (e) {
        // No session was created: free the claim so the user can retry at once.
        await releaseCheckout(user.id, claim).catch(() => {});
        throw e;
      }
    }

    if (pathname === "/api/billing/packs") {
      // Top-up packs (price book rev 2): set the number of +20-agent packs on the CURRENT subscription; 0 removes them.
      let body: any;
      try {
        body = await req.json();
      } catch {
        return err(400, "bad_json", "Request body must be valid JSON.");
      }
      const packs = body?.packs;
      if (!Number.isInteger(packs) || packs < 0 || packs > PRICE_BOOK.pack.max_packs) {
        return err(400, "bad_packs", `packs must be a whole number from 0 to ${PRICE_BOOK.pack.max_packs}.`);
      }
      const subId = user.billing?.subscription_id;
      if (!subId) return err(409, "no_subscription", "Subscribe to a plan before adding top-up packs.");
      // One pack change per user at a time (review r1 C3): the claim covers the live read AND the write, so two
      // concurrent first purchases cannot both see "no pack item" and both create one. Released right after.
      const packClaim = await claimPacks(user.id);
      if (!packClaim) {
        return err(409, "packs_in_progress", "A pack change for this account is in progress; try again in a moment.");
      }
      try {
        // The LIVE subscription decides (the mirror can lag): only an active, paid subscription buys packs. A trial
        // gets no free agents; past_due and later states buy nothing.
        const sub = await getSubscription(cfg, subId);
        if (sub.status !== "active") {
          return err(409, "subscription_not_active", "Top-up packs can be added to an active, paid subscription only (not during the free trial).");
        }
        const items = sub.items?.data ?? [];
        const tierItem = items.find((i) => tierForPrice(cfg, i.price?.id) !== null);
        const tier = tierItem ? tierForPrice(cfg, tierItem.price?.id)! : null;
        const annual = tier !== null && cfg.annual?.[tier] !== undefined && tierItem?.price?.id === cfg.annual[tier];
        const packPrice = annual ? cfg.pack?.year : cfg.pack?.month;
        if (!tier || !packPrice) {
          return err(501, "packs_not_configured", "Top-up packs are not configured for this subscription's billing interval yet.");
        }
        // Exactly zero or one pack item, on THIS interval's pack Price (review r1 a, b): anything else is a state
        // the portal never creates; refuse rather than guess which item to change.
        const packIds = new Set(packPriceIds(cfg));
        const packItems = items.filter((i: any) => i.price?.id && packIds.has(i.price.id)) as any[];
        if (packItems.length > 1 || (packItems.length === 1 && packItems[0].price.id !== packPrice)) {
          return err(409, "pack_items_ambiguous", "This subscription's pack items need attention from support; nothing was changed.");
        }
        const existing = packItems[0];
        const current = existing ? (Number.isInteger(existing.quantity) ? existing.quantity : 1) : 0;
        if (packs === current) return json(200, { packs, changed: false });
        // Rev 4: at most one pack per seat (and max_packs). Raising past it is refused; lowering is always allowed, so an
        // account over the cap (seats lowered in the portal) can get back under it.
        const seats = Number.isInteger((tierItem as any)?.quantity) ? (tierItem as any).quantity : 1;
        const cap = maxPacksFor(seats);
        if (packs > current && packs > cap) {
          return new Response(
            JSON.stringify({ error: { code: "packs_over_seats", message: `At most one pack per seat: with ${seats} seats you can hold ${cap} packs.`, max_packs: cap } }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
        const key = newPacksIdempotencyKey();
        if (existing && packs > 0) {
          await stripeRequest(cfg, "POST", "/v1/subscription_items/" + encodeURIComponent(existing.id), { quantity: packs, proration_behavior: "create_prorations" }, fetch, key);
        } else if (existing) {
          await stripeRequest(cfg, "DELETE", "/v1/subscription_items/" + encodeURIComponent(existing.id), { proration_behavior: "create_prorations" }, fetch, key);
        } else {
          await stripeRequest(cfg, "POST", "/v1/subscription_items", { subscription: sub.id, price: packPrice, quantity: packs, proration_behavior: "create_prorations" }, fetch, key);
        }
        // The webhook (customer.subscription.updated) records the new pack count and agent pool on the account.
        return json(200, { packs, changed: true });
      } finally {
        await releasePacks(user.id, packClaim).catch(() => {});
      }
    }

    if (pathname === "/api/billing/portal") {
      if (!user.billing?.customer_id) {
        return err(404, "no_billing_account", "No billing account yet; start a subscription first.");
      }
      const portal = await createPortalSession(cfg, user.billing.customer_id, origin + "/app.html");
      return json(200, { url: portal.url });
    }
  } catch (e: any) {
    if (e instanceof StripeError) {
      return err(502, "stripe_error", `Stripe refused the request: ${e.message}`);
    }
    throw e;
  }

  return err(404, "not_found", "Unknown billing endpoint.");
};

export const config: Config = {
  path: ["/api/billing/checkout", "/api/billing/portal", "/api/billing/packs", "/api/billing/webhook"],
};
