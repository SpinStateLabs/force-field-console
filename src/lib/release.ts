// Force-Field Console - release a suspended dedicated estate back to the shared sandbox.
//
// An account whose estate record is `suspended` is refused by the gateway (403 estate_suspended) until
// billing comes back. When it never will, the OWNER may release the record: the account then has no estate
// record and its keys route to the shared sandbox again. Nothing on Fly is touched here, and nothing is
// released unless ALL of these hold, checked under the per-user lock the Stripe webhook and the tick take:
//   1. the stored record is `suspended`, with no suspension and no resume pending, no background worker's
//      lease still running, and no write in the last RELEASE_QUIET_MS;
//   2. the account's billing does not grant (sandbox tier, no granting subscription, none remembered);
//   3. Fly was asked and has NO app for this estate (a failed or impossible ask is a refusal, never a guess).
// The dedicated estate's data is not carried over to the sandbox. A later granting subscription queues a
// new record (queueEstate), which provisions a fresh estate.
//
// Races, and how each is closed:
//   - Stripe webhook (applyOrdered) and the tick's reconcile (retryPendingSuspend) take the same user lock
//     and re-read inside it: they run wholly before the release (it then sees their result and refuses when
//     billing grants or a resume is pending) or wholly after it (no record: a granting event queues a fresh one).
//   - A checkout in flight changes nothing until its webhook is applied: the case above.
//   - Writers that hold a copy read earlier and do not take the lock (a worker, the tick's own list, a
//     dashboard request): the record is deleted only if it is byte-for-byte the one that was checked (etag
//     re-read right before the delete; Blobs has no conditional delete, so the window is read-to-delete), and
//     saveEstate refuses to re-create a released record from such a copy (the audit copy is its tombstone)
//     and refuses to overwrite a record queued later with a copy of an earlier one (created_at differs).
//   - A driver still inside a Fly call that creates something (it read the record before the suspension):
//     refused while a worker lease runs or the record was written within RELEASE_QUIET_MS; once its call has
//     landed, Fly has the app and the release is refused for that.

import { EstateError, clearConfigWrite, estateKey, newAppName, releasedEstateKey, type Estate } from "./estates";
import { FlyError, type FlyClient } from "./fly";
import { withUserLock } from "./locks";
import { portalStore } from "./store";
import { GRANTING_STATUSES } from "./stripe";
import { getUserById, type User } from "./users";

/** How long one "does this app exist" question to Fly may take (the release holds the user lock meanwhile). */
export const RELEASE_FLY_TIMEOUT_MS = 8000;
/**
 * A record must have been untouched for this long before it can be released. An assumption, sized above
 * several Fly calls of 20 s each (the client's timeout); how late Fly can apply an abandoned call is not known.
 */
export const RELEASE_QUIET_MS = 2 * 60_000;

/** Why this account's billing forbids a release, or null when it does not grant anything. */
export function billingBlocksRelease(u: User): string | null {
  if (u.tier !== "sandbox") return "the account is on a paid tier";
  if (u.billing && GRANTING_STATUSES.has(u.billing.status)) return `the subscription is ${u.billing.status}`;
  if (u.billing?.other_subs && Object.keys(u.billing.other_subs).length) return "another subscription of this customer may still grant a tier";
  return null;
}

export type ReleaseResult = { released: true; app: string; audit_key: string; released_at: string };

/**
 * Release `userId`'s OWN suspended estate (the caller passes the signed-in user's id; there is no other
 * target). Refuses with an EstateError and changes nothing unless every condition in the header holds.
 */
export async function releaseSuspendedEstate(userId: string, fly: FlyClient | null, now: Date = new Date()): Promise<ReleaseResult> {
  const run = async (): Promise<ReleaseResult> => {
    const store = await portalStore();
    const key = estateKey(userId);
    const read = await store.getWithEtag(key);
    if (!read) throw new EstateError(404, "no_estate", "No dedicated estate on this account.");
    const e = read.data as Estate;

    if (e.status !== "suspended") {
      throw new EstateError(409, "estate_not_suspended", `Only a suspended estate can be released; this one is ${e.status}.`);
    }
    if (e.suspend_pending) {
      throw new EstateError(409, "suspend_pending", "The estate's suspension is still being completed; try again once it has finished.");
    }
    if (e.resume_pending) {
      throw new EstateError(409, "resume_pending", "The estate is being resumed for an active subscription; it cannot be released.");
    }
    // A driver that read the record before it was suspended may still be inside a Fly call (create app,
    // create machine): its call could land AFTER Fly answered "no app" below and leave an app without a
    // record. Two independent refusals: a background worker's lease that has not ended (it clears the lease
    // when it exits; a killed worker's lease ends within about 16 minutes), and a record written moments ago
    // (the suspension itself, or any driver finishing its step; covers the drivers that hold no worker lease).
    if (e.worker_until && !(new Date(e.worker_until).getTime() <= now.getTime())) {
      throw new EstateError(409, "worker_active", "A background worker may still be working on this estate; nothing was released. Try again in a few minutes.");
    }
    if (!(now.getTime() - new Date(e.updated_at).getTime() >= RELEASE_QUIET_MS)) {
      throw new EstateError(409, "estate_settling", "The estate record changed moments ago; nothing was released. Try again in a few minutes.");
    }

    const user = await getUserById(userId);
    if (!user) throw new EstateError(404, "no_user", "The account could not be read.");
    const blocked = billingBlocksRelease(user);
    if (blocked) {
      throw new EstateError(409, "billing_active", `Billing is still active on this account (${blocked}); the estate cannot be released. Cancel the subscription first, or reactivate it to resume the estate.`);
    }

    // Confirmed against Fly, never assumed: the record's app name and the name derived from the user id
    // (the same by construction; both are asked in case a record ever differs).
    if (!fly) {
      throw new EstateError(501, "provisioning_not_configured", "Fly cannot be asked whether the estate's app still exists on this deployment; nothing was released.");
    }
    const apps = [...new Set([e.app, newAppName(userId)].filter(Boolean))];
    for (const app of apps) {
      let found: unknown;
      try {
        found = await fly.getApp(app, RELEASE_FLY_TIMEOUT_MS);
      } catch (err: any) {
        console.error("estate release: Fly could not be asked about", app, "-", err instanceof FlyError ? `HTTP ${err.status}` : String(err?.message ?? err).slice(0, 200));
        throw new EstateError(502, "fly_check_failed", "Fly could not confirm that the estate's app is gone; nothing was released. Try again shortly.");
      }
      if (found) {
        throw new EstateError(409, "fly_app_exists", "The Fly app behind this estate still exists (its data is kept there); it cannot be released. Reactivate billing to resume it, or ask Spin State Labs to remove it.");
      }
    }

    // The record must still be exactly the one checked above (a writer outside the lock may have saved meanwhile).
    const again = await store.getWithEtag(key);
    if (!again || again.etag !== read.etag) {
      throw new EstateError(409, "estate_changed", "The estate record changed while it was being checked; nothing was released. Try again.");
    }

    const releasedAt = now.toISOString();
    const auditKey = releasedEstateKey(userId, e.created_at);
    // The audit copy first (it is also the tombstone): a failure between the two writes leaves a suspended
    // record that can simply be released again. The record holds no secrets (see publicEstate / the header of estates.ts).
    await store.setJSON(auditKey, {
      released_at: releasedAt,
      released_by: userId,
      reason: "owner release of a suspended estate: billing not active, no Fly app",
      fly_apps_checked: apps,
      billing: { tier: user.tier, status: user.billing?.status ?? null, subscription_id: user.billing?.subscription_id ?? null },
      estate: e,
    });
    await store.delete(key);
    // Hygiene after the fact: a config-write mark without a record would never settle.
    await clearConfigWrite(userId).catch((err: any) => console.error("estate release: could not drop the config-write mark:", String(err?.message ?? err).slice(0, 200)));
    console.log("estate released", JSON.stringify({ key: "estate_released", user_id: userId, app: e.app, audit_key: auditKey, released_at: releasedAt }));
    return { released: true, app: e.app, audit_key: auditKey, released_at: releasedAt };
  };

  try {
    return await withUserLock(userId, run);
  } catch (err: any) {
    if (err instanceof EstateError) throw err;
    if (/is busy/.test(String(err?.message ?? ""))) {
      throw new EstateError(409, "busy", "Another billing or estate operation is running for this account; nothing was released. Try again in a minute.");
    }
    throw err;
  }
}
