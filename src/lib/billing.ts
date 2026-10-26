// Force-Field Console — billing state transitions driven by Stripe webhooks.
//
// The webhook is the ONLY writer of user.tier for paid tiers. A subscription
// in a granting status (active / trialing / past_due) with a known price sets
// the tier and queues a dedicated estate; anything else drops the tier back to
// sandbox and suspends the estate (stopped, data kept — never destroyed here).
// Every event id is recorded after successful handling so redeliveries are no-ops.

import { createHash, randomUUID } from "node:crypto";
import { portalStore } from "./store";
import { saveEstate } from "./estates";
import { withUserLock } from "./locks";
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
import { getEstate, markResumePending, queueEstate, recordResumeFailure, resumeEstate, reviveEstate, suspendEstate, type Estate } from "./estates";
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
 * 'active' that arrives after 'deleted' must not resume a cancelled estate.
 *
 * Two parts, both required:
 *  1. a HIGH-WATER MARK (newest event.created applied for the subscription) advanced
 *     by an etag-conditional compare-and-set BEFORE anything is applied; an event
 *     older than the mark is stale and ignored, and in the same second a recorded
 *     cancellation wins (a cancelled subscription is final in Stripe). A redelivery of
 *     the very event that set the mark (its apply failed) is not stale.
 *  2. a short per-subscription lock held across mark + apply, so two events for one
 *     subscription can never apply concurrently in arbitrary order. A delivery that
 *     cannot get the lock waits briefly, then fails (5xx) and Stripe redelivers it.
 *
 * Two OTHER events in the same second cannot be ordered by `created` (G2). When the caller passes
 * resolveTie, such a tie is resolved from Stripe's live subscription instead of the payload that
 * happened to arrive last: resolveTie fetches it (the caller then applies that object) and returns
 * its status, which the mark records (with tie: true). A failing fetch throws, so the event is redelivered.
 * A redelivery of the event that set a live-resolved mark (its apply failed after the mark CAS) is resolved
 * from the live subscription again, never from its payload: the mark's tie flag (or a recorded status that
 * differs from the payload) says the payload was not what was applied.
 * Cost: ties are routine at checkout (checkout.session.completed and customer.subscription.created/updated
 * often share a second), so expect one or two extra subscription GETs per new subscription, each bounded
 * by the Stripe client's request timeout, inside the user lock and before anything is persisted.
 *
 * Events without a numeric `created` (never from Stripe) are applied unordered.
 */
export type SubMark = { created: number; status: string; event_id: string; tie?: true };

export async function advanceSubscriptionMark(
  subId: string,
  created: unknown,
  status: string,
  eventId: string,
  resolveTie?: () => Promise<string>,
): Promise<boolean> {
  if (typeof created !== "number") return true;
  const store = await portalStore();
  const key = "stripe_subs/" + subId;
  let liveStatus: string | null = null;
  for (let i = 0; i < 8; i++) {
    const read = await store.getWithEtag(key);
    const mark = read?.data as SubMark | undefined;
    if (mark && mark.event_id !== eventId) {
      if (created < mark.created) return false;
      if (created === mark.created && mark.status === "canceled") return false;
    }
    // A tie with another event, or a redelivery of the event that set a live-resolved mark.
    const tied = !!mark && created === mark.created && (mark.event_id !== eventId || mark.tie === true || mark.status !== status);
    if (tied && resolveTie && liveStatus === null) liveStatus = await resolveTie();
    const next: SubMark = liveStatus === null ? { created, status, event_id: eventId } : { created, status: liveStatus, event_id: eventId, tie: true };
    if (read ? await store.setJSONIfMatch(key, next, read.etag) : await store.setJSONIfNew(key, next)) return true;
  }
  throw new Error("subscription mark kept changing; the event will be redelivered");
}

export { SUB_LOCK_TRIES, SUB_LOCK_TTL_MS, SUB_LOCK_WAIT_MS, withSubscriptionLock, withUserLock } from "./locks";

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
  // Blobs has no conditional delete: the token check narrows the window to read-to-delete.
  // Losing it only drops a claim early; the subscribed-check and the Stripe idempotency key bound the harm.
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

  const carried = { ...(user.billing?.other_subs ?? {}) };
  delete carried[sub.id];
  user.tier = tier;
  user.billing = {
    customer_id: String(sub.customer),
    subscription_id: sub.id,
    status: sub.status,
    price_id: priceId,
    tier,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    updated_at: now.toISOString(),
    ...(Object.keys(carried).length ? { other_subs: carried } : {}),
  };
  await saveUser(user);
  const store = await portalStore();
  await store.setJSON("stripe_customers/" + sub.customer, { user_id: user.id });

  // Fly calls that stay INLINE in the webhook (Netlify's function limit is unverified; one Fly call was
  // observed at ~20 s, so nothing slow may sit between the event and a persisted decision):
  //  - GRANTING: none. A paying customer's estate is only MARKED resume_pending (store writes); the
  //    scheduled tick (every 2 minutes) starts the machine. Worst case inline: a few blob writes.
  //  - CANCEL: suspendEstate. The pending flag is persisted BEFORE the first Fly call, then at most
  //    getMachine + [config update] + stop + wait (<= WAIT_S) + up to 4 read-backs, under a 20 s time
  //    budget (quiesceBudget) checked between calls; a call in flight can add up to its own 20 s Fly
  //    timeout. If the function limit cuts it off, the state is a retryable suspend_pending, never lost.
  if (granting) {
    const estate = await queueEstate(user, now);
    if (estate.status === "suspended" || estate.suspend_pending) {
      if (deps.fly && estate.machine_id) await markResumePending(estate, now, "the subscription is active again");
      else if (estate.status === "suspended") await resumeEstate(estate, deps.fly, now); // nothing on Fly to start
    }
  } else {
    const estate = await getEstate(user.id);
    // "suspended" is included: suspendEstate verifies the machine really is stopped instead of trusting the record
    if (estate && (estate.status === "ready" || estate.status === "provisioning" || estate.status === "error" || estate.status === "suspended")) {
      await suspendEstate(estate, deps.fly, now, `subscription ${sub.status}`);
    }
  }
  return tier;
}

/** True when the user's subscription currently grants a paid tier. */
export function isGrantingUser(u: User | null): boolean {
  return Boolean(u && u.tier !== "sandbox" && u.billing && GRANTING_STATUSES.has(u.billing.status));
}

/**
 * The tick's reconciliation of one estate, under the same per-USER lock as the webhook, with the
 * estate and the user's billing re-read INSIDE it:
 *  - billing grants: the estate must be RUNNING. Suspended -> resume (autostart on, then start); a
 *    leftover suspension flag -> revive (read the real machine, fix autostart / start it). A flag is
 *    never just cleared. Failures are recorded (resume_pending: backoff, cap, then flagged).
 *  - billing does not grant and a suspension is pending: retry the stop (conditional on it still
 *    being pending in the stored record, see suspendEstate requirePending).
 * NOTE: the lock outlives a killed webhook by up to SUB_LOCK_TTL_MS (5 minutes); until then events
 * for that user are answered 5xx (Stripe redelivers) and the tick reports it as lock_busy/lock_stale.
 */
export async function retryPendingSuspend(
  userId: string,
  fly: FlyClient,
  now: Date = new Date(),
): Promise<{ outcome: "suspended" | "pending" | "cleared" | "resumed" | "resume_failed"; estate: Estate | null }> {
  const run = async () => {
    const fresh = await getEstate(userId);
    if (!fresh || (!fresh.suspend_pending && !fresh.resume_pending && fresh.status !== "suspended")) return { outcome: "cleared" as const, estate: fresh };
    const u = await getUserById(userId);
    if (isGrantingUser(u)) {
      try {
        if (fresh.status === "suspended") await resumeEstate(fresh, fly, now);
        else await reviveEstate(fresh, fly, now);
      } catch (err) {
        const again = (await getEstate(userId)) ?? fresh;
        await recordResumeFailure(again, now, err);
        return { outcome: "resume_failed" as const, estate: await getEstate(userId) };
      }
      const stored = await getEstate(userId);
      return { outcome: stored?.status === "ready" ? ("resumed" as const) : ("resume_failed" as const), estate: stored };
    }
    if (fresh.resume_pending && !fresh.suspend_pending) {
      // the customer stopped paying while a resume was still queued: the resume intent is stale
      fresh.resume_pending = null;
      if (fresh.health && /^resume (pending|failed)/.test(fresh.health.note)) fresh.health = null;
      await saveEstate(fresh, now, { owns: ["resume_pending", "health"] as any });
    }
    if (!fresh.suspend_pending) return { outcome: "cleared" as const, estate: fresh };
    const r = await suspendEstate(fresh, fly, now, fresh.suspend_pending.reason, { requirePending: true });
    const stored = (await getEstate(userId)) ?? r;
    return { outcome: stored.status === "suspended" && !stored.suspend_pending ? ("suspended" as const) : stored.suspend_pending ? ("pending" as const) : ("cleared" as const), estate: stored };
  };
  return withUserLock(userId, run);
}

/**
 * Stripe Idempotency-Key for a checkout intent: stable across retries of the same
 * (user, tier, customer) within one claim-TTL bucket, so a retried request replays the same
 * Checkout Session instead of opening another; a new bucket is a new intent.
 */
export function checkoutIdempotencyKey(userId: string, tier: string, customerId: string | null, now: Date = new Date()): string {
  const bucket = Math.floor(now.getTime() / CHECKOUT_CLAIM_TTL_MS);
  return "checkout-" + createHash("sha256").update(`${userId}|${tier}|${customerId ?? ""}|${bucket}`).digest("hex").slice(0, 32);
}

const grantsTier = (deps: WebhookDeps, s: StripeSubscription) => tierForPrice(deps.cfg, subscriptionPriceId(s)) !== null && GRANTING_STATUSES.has(s.status);

/**
 * Win the subscription's ordering mark, then apply, all under the user's lock (one lock per user,
 * so events for different subscriptions of one customer exclude each other). Rules:
 *  - only the user's CURRENT subscription suspends or resumes the estate;
 *  - an event for another subscription is tracked (granting ones are remembered in billing.other_subs,
 *    others forgotten) and changes nothing else; a granting one is ADOPTED when the current one no
 *    longer grants;
 *  - when the current subscription stops granting, another remembered granting subscription (verified
 *    with Stripe) takes over instead of the estate being suspended.
 * Returns applied=false (reason) for stale or tracked-only events.
 */
async function applyOrdered(
  user: User,
  sub: StripeSubscription,
  event: any,
  deps: WebhookDeps,
  isLive = false,
): Promise<{ applied: boolean; tier?: Tier; status?: string; reason?: "stale" | "other_subscription" }> {
  return withUserLock(user.id, async () => {
    // G2: a same-second tie with another event is resolved from the live subscription (sub is already
    // live for checkout.session.completed, so no second read there).
    const tie: { live?: StripeSubscription } = {};
    const resolveTie = isLive
      ? undefined
      : async () => {
          const live = await getSubscription(deps.cfg, sub.id, deps.fetchImpl);
          if (live?.id !== sub.id || String(live.customer) !== String(sub.customer)) throw new Error("live subscription does not match the event; the event will be redelivered");
          if (!live.metadata?.user_id && sub.metadata?.user_id) live.metadata = { ...(live.metadata ?? {}), user_id: sub.metadata.user_id };
          tie.live = live;
          return live.status;
        };
    if (!(await advanceSubscriptionMark(sub.id, event?.created, sub.status, String(event?.id ?? ""), resolveTie))) return { applied: false, reason: "stale" as const };
    if (tie.live) sub = tie.live;
    const fresh = (await getUserById(user.id)) ?? user; // the user may have changed while we waited for the lock
    const cur = fresh.billing;
    if (cur?.subscription_id && cur.subscription_id !== sub.id && !(grantsTier(deps, sub) && !GRANTING_STATUSES.has(cur.status))) {
      const others = { ...(cur.other_subs ?? {}) };
      if (grantsTier(deps, sub)) others[sub.id] = { status: sub.status, price_id: subscriptionPriceId(sub) };
      else delete others[sub.id];
      fresh.billing = { ...cur, other_subs: Object.keys(others).length ? others : undefined };
      await saveUser(fresh);
      return { applied: false, reason: "other_subscription" as const };
    }
    if (!grantsTier(deps, sub) && cur?.other_subs) {
      const rest = { ...cur.other_subs };
      delete rest[sub.id];
      for (const id of Object.keys(rest)) {
        const cand = await getSubscription(deps.cfg, id, deps.fetchImpl);
        delete rest[id];
        // The candidate must belong to this customer and this user (never adopt a stranger's subscription).
        const sameCustomer = String(cand.customer) === String(cur.customer_id);
        const sameUser = !cand.metadata?.user_id || cand.metadata.user_id === fresh.id;
        if (!(sameCustomer && sameUser)) {
          console.warn("billing: hand-over candidate", id, "does not belong to this customer/user; skipped");
          continue;
        }
        if (grantsTier(deps, cand)) {
          if (!cand.metadata?.user_id) cand.metadata = { ...(cand.metadata ?? {}), user_id: fresh.id };
          fresh.billing = { ...cur, other_subs: Object.keys(rest).length ? rest : undefined };
          return { applied: true, tier: await applySubscription(fresh, cand, deps), status: sub.status };
        }
      }
      fresh.billing = { ...cur, other_subs: undefined };
    }
    return { applied: true, tier: await applySubscription(fresh, sub, deps), status: sub.status };
  });
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
    const r = await applyOrdered(user, sub, event, deps, true);
    if (!r.applied) return { handled: false, note: r.reason === "other_subscription" ? `checkout.session.completed for ${sub.id} ignored (not the user's current subscription)` : `stale checkout.session.completed for ${sub.id} ignored (out of order)` };
    return { handled: true, note: `checkout completed; tier ${r.tier}` };
  }

  if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const sub = obj as StripeSubscription;
    if (!sub?.id || !sub?.customer) return { handled: false, note: "subscription event without id/customer" };
    const user = await userForSubscription(sub);
    if (!user) return { handled: false, note: "no portal user for the subscription" };
    const r = await applyOrdered(user, sub, event, deps);
    if (!r.applied) return { handled: false, note: r.reason === "other_subscription" ? `${type} for ${sub.id} ignored (not the user's current subscription)` : `stale ${type} for ${sub.id} ignored (out of order)` };
    return { handled: true, note: `${type}; status ${r.status ?? sub.status}; tier ${r.tier}` };
  }

  return { handled: false, note: `ignored event type ${type || "(none)"}` };
}
