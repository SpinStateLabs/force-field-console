// Force-Field Console — billing state transitions driven by Stripe webhooks.
//
// The webhook is the ONLY writer of user.tier for paid tiers. A subscription
// in a granting status (active / trialing / past_due) with a known price sets
// the tier and queues a dedicated estate; anything else drops the tier back to
// sandbox and suspends the estate (stopped, data kept — never destroyed here).
// Every event id is recorded after successful handling so redeliveries are no-ops.

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
import { getEstate, queueEstate, resumeEstate, suspendEstate } from "./estates";
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
  const existing = (await store.get(key, { type: "json" })) as { status?: string; claimed_at?: string } | null;
  if (existing?.status === "processing" && existing.claimed_at && now.getTime() - new Date(existing.claimed_at).getTime() > STALE_CLAIM_MS) {
    console.warn("billing webhook: taking over a stale claim for event", eventId, "claimed at", existing.claimed_at);
    await store.setJSON(key, claim);
    return true;
  }
  return false;
}

export async function releaseEvent(eventId: string): Promise<void> {
  const store = await portalStore();
  await store.delete("stripe_events/" + eventId);
}

export async function markProcessed(eventId: string, type: string, now: Date = new Date()): Promise<void> {
  const store = await portalStore();
  await store.setJSON("stripe_events/" + eventId, { type, status: "done", processed_at: now.toISOString() });
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
    if (!user) return { handled: false, note: "no portal user for the subscription" };
    const tier = await applySubscription(user, sub, deps);
    return { handled: true, note: `${type}; status ${sub.status}; tier ${tier}` };
  }

  return { handled: false, note: `ignored event type ${type || "(none)"}` };
}
