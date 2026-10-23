// Force-Field Console — billing state transitions driven by Stripe webhooks.
//
// The webhook is the ONLY writer of user.tier for paid tiers. A subscription
// in a granting status (active / trialing / past_due) with a known price sets
// the tier and queues a dedicated estate; anything else drops the tier back to
// sandbox and suspends the estate (stopped, data kept — never destroyed here).
// Every event id is recorded after successful handling so redeliveries are no-ops.

import { randomUUID } from "node:crypto";
import { portalStore } from "./store";
import { getUserById, saveUser, type User, type Tier } from "./users";
import {
  GRANTING_STATUSES,
  getSubscription,
  subscriptionPeriodEnd,
  subscriptionPriceId,
  tierForPrice,
  type FetchLike,
  type StripeConfig,
  type StripeSubscription,
} from "./stripe";
import { clearSuspendPending, getEstate, queueEstate, resumeEstate, suspendEstate } from "./estates";
import type { FlyClient } from "./fly";

export type WebhookDeps = {
  cfg: StripeConfig;
  fly: FlyClient | null;
  fetchImpl?: FetchLike;
  now?: () => Date;
};

export type WebhookOutcome = { handled: boolean; note: string };

export async function alreadyProcessed(eventId: string): Promise<boolean> {
  const store = await portalStore();
  return Boolean(await store.get("stripe_events/" + eventId, { type: "json" }));
}

/**
 * Claim a Stripe event id BEFORE handling it, with a create-only write: false
 * when another delivery of the same event already claimed or processed it, so
 * two concurrent deliveries can never both apply. A claim that fails to handle
 * is released again (releaseEvent) so Stripe's retry can succeed.
 */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

export async function claimEvent(eventId: string, type: string, now: Date = new Date()): Promise<boolean> {
  const store = await portalStore();
  const key = "stripe_events/" + eventId;
  const claim = { type, status: "processing", claimed_at: now.toISOString() };
  if (await store.setJSONIfNew(key, claim)) return true;
  // A claim left "processing" for longer than any webhook invocation can live (the
  // function died, or the release after a failure itself failed) must not strand the
  // event: Stripe's retry takes it over. A "done" record is never taken over.
  // The takeover is a CONDITIONAL write (etag match): of two retries racing to take
  // over the same stale claim exactly one wins; the loser sees the winner's fresh claim.
  const read = await store.getWithEtag(key);
  const existing = read?.data as { status?: string; claimed_at?: string } | undefined;
  if (read && existing?.status === "processing" && existing.claimed_at && now.getTime() - new Date(existing.claimed_at).getTime() > STALE_CLAIM_MS) {
    if (await store.setJSONIfMatch(key, claim, read.etag)) {
      console.warn("billing webhook: took over a stale claim for event", eventId, "claimed at", existing.claimed_at);
      return true;
    }
  }
  return false;
}

/**
 * Per-subscription ordering. Stripe does not guarantee delivery order, and a late
 * 'active' that arrives after 'deleted' must not resume a cancelled estate. The
 * high-water mark is the newest event.created (unix seconds) applied for a
 * subscription; an older event is stale and ignored. In the same second a recorded
 * cancellation wins (a cancelled subscription is final in Stripe). Events without a
 * numeric `created` (never from Stripe) are applied unordered.
 */
export type SubMark = { created: number; status: string; event_id: string };

export async function isStaleSubscriptionEvent(subId: string, created: unknown): Promise<boolean> {
  if (typeof created !== "number") return false;
  const store = await portalStore();
  const mark = (await store.get("stripe_subs/" + subId, { type: "json" })) as SubMark | null;
  if (!mark) return false;
  if (created < mark.created) return true;
  return created === mark.created && mark.status === "canceled";
}

export async function recordSubscriptionEvent(subId: string, created: unknown, status: string, eventId: string): Promise<void> {
  if (typeof created !== "number") return;
  const store = await portalStore();
  const key = "stripe_subs/" + subId;
  for (let i = 0; i < 5; i++) {
    const read = await store.getWithEtag(key);
    const mark = read?.data as SubMark | undefined;
    if (mark && mark.created > created) return; // a newer event already advanced the mark
    const next: SubMark = { created, status, event_id: eventId };
    if (read ? await store.setJSONIfMatch(key, next, read.etag) : await store.setJSONIfNew(key, next)) return;
  }
}

export async function releaseEvent(eventId: string): Promise<void> {
  const store = await portalStore();
  await store.delete("stripe_events/" + eventId);
}

export async function markProcessed(eventId: string, type: string, now: Date = new Date()): Promise<void> {
  const store = await portalStore();
  await store.setJSON("stripe_events/" + eventId, { type, status: "done", processed_at: now.toISOString() });
}

/**
 * Per-user checkout-in-progress claim: a create-only write with a short TTL. Returns
 * the claim's token, or null while another checkout request holds a live claim. An
 * expired claim is taken over with a conditional (etag) write. It is kept after a
 * successful session creation until the TTL ends, so a double click gets the 409.
 */
export const CHECKOUT_CLAIM_TTL_MS = 60_000;

export async function claimCheckout(userId: string, now: Date = new Date()): Promise<string | null> {
  const store = await portalStore();
  const key = "checkout_claims/" + userId;
  const token = randomUUID();
  const claim = { token, expires_at: new Date(now.getTime() + CHECKOUT_CLAIM_TTL_MS).toISOString() };
  if (await store.setJSONIfNew(key, claim)) return token;
  const read = await store.getWithEtag(key);
  if (!read) return (await store.setJSONIfNew(key, claim)) ? token : null; // released between the two calls
  if (new Date(read.data?.expires_at ?? 0).getTime() > now.getTime()) return null;
  return (await store.setJSONIfMatch(key, claim, read.etag)) ? token : null;
}

export async function releaseCheckout(userId: string, token: string): Promise<void> {
  const store = await portalStore();
  const key = "checkout_claims/" + userId;
  const read = await store.getWithEtag(key);
  if (read?.data?.token === token) await store.delete(key); // only our own claim
}

/** Resolve the portal user for a subscription: metadata.user_id first, then the customer pointer. */
export async function userForSubscription(sub: StripeSubscription): Promise<User | null> {
  const metaUser = sub.metadata?.user_id;
  if (metaUser) {
    const u = await getUserById(metaUser);
    if (u) return u;
  }
  const store = await portalStore();
  const ptr = (await store.get("stripe_customers/" + sub.customer, { type: "json" })) as { user_id: string } | null;
  return ptr?.user_id ? await getUserById(ptr.user_id) : null;
}

/**
 * Apply a subscription's state to the user: tier, billing mirror, estate
 * queue/suspend. Returns the tier now in force.
 */
export async function applySubscription(user: User, sub: StripeSubscription, deps: WebhookDeps): Promise<Tier> {
  const now = deps.now ? deps.now() : new Date();
  const priceId = subscriptionPriceId(sub);
  const paidTier = tierForPrice(deps.cfg, priceId);
  const granting = paidTier !== null && GRANTING_STATUSES.has(sub.status);
  const tier: Tier = granting ? paidTier! : "sandbox";
  const periodEnd = subscriptionPeriodEnd(sub);

  user.tier = tier;
  user.billing = {
    customer_id: String(sub.customer),
    subscription_id: sub.id,
    status: sub.status,
    price_id: priceId,
    tier,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    updated_at: now.toISOString(),
  };
  await saveUser(user);
  const store = await portalStore();
  await store.setJSON("stripe_customers/" + sub.customer, { user_id: user.id });

  if (granting) {
    const estate = await queueEstate(user, now);
    if (estate.status === "suspended") await resumeEstate(estate, deps.fly, now);
    else if (estate.suspend_pending) await clearSuspendPending(estate, "subscription active again", now);
  } else {
    const estate = await getEstate(user.id);
    if (estate && (estate.status === "ready" || estate.status === "provisioning" || estate.status === "error")) {
      await suspendEstate(estate, deps.fly, now, `subscription ${sub.status}`);
    }
  }
  return tier;
}

/** Dispatch one verified Stripe event. Unknown types and unknown users are acknowledged, not retried. */
export async function handleStripeEvent(event: any, deps: WebhookDeps): Promise<WebhookOutcome> {
  const type = String(event?.type ?? "");
  const obj = event?.data?.object ?? {};

  if (type === "checkout.session.completed") {
    if (obj.mode !== "subscription" || !obj.subscription) {
      return { handled: false, note: "checkout session is not a subscription" };
    }
    const userId = obj.client_reference_id ?? obj.metadata?.user_id;
    const user = userId ? await getUserById(String(userId)) : null;
    if (!user) return { handled: false, note: "no portal user on the session" };
    const sub = await getSubscription(deps.cfg, String(obj.subscription), deps.fetchImpl);
    if (!sub.metadata?.user_id) sub.metadata = { ...(sub.metadata ?? {}), user_id: user.id };
    const tier = await applySubscription(user, sub, deps);
    return { handled: true, note: `checkout completed; tier ${tier}` };
  }

  if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const sub = obj as StripeSubscription;
    if (!sub?.id || !sub?.customer) return { handled: false, note: "subscription event without id/customer" };
    const user = await userForSubscription(sub);
    if (await isStaleSubscriptionEvent(sub.id, event?.created)) {
      return { handled: false, note: `stale ${type} for ${sub.id} ignored (out of order)` };
    }
    if (!user) return { handled: false, note: "no portal user for the subscription" };
    const tier = await applySubscription(user, sub, deps);
    await recordSubscriptionEvent(sub.id, event?.created, sub.status, String(event?.id ?? ""));
    return { handled: true, note: `${type}; status ${sub.status}; tier ${tier}` };
  }

  return { handled: false, note: `ignored event type ${type || "(none)"}` };
}
