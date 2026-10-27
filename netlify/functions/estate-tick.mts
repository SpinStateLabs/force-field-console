// estate-tick.mts — Force-Field Console v0.2.0
// Scheduled backstop (every two minutes, 30-second limit): kick the background
// worker for every estate that is still provisioning and has no live worker,
// and for every ready estate whose self-agent tokens are due for renewal. The
// worker does the slow work; this function only enumerates and kicks. When the
// site URL is unknown (no background kick possible) it falls back to one
// synchronous step per estate. Scheduled functions run only on the published
// production deploy (never in previews). Logs counts only.
import type { Config } from "@netlify/functions";
import { flyClientOrNull, flyConfig } from "../../src/lib/fly";
import { advanceEstate, checkEstateHealth, configWriteMarks, listEstates, markResumePending, retryDue, workerActive } from "../../src/lib/estates";
import { userLockAgeMs } from "../../src/lib/locks";
import { getUserById } from "../../src/lib/users";
import { isGrantingUser, retryPendingSuspend } from "../../src/lib/billing";
import { portalStore } from "../../src/lib/store";
import { renewalDue } from "../../src/lib/renewal";
import { kickWorker } from "../../src/lib/worker";

const BUDGET_MS = 20000;
const HEALTH_START_BY_MS = 6000;
const LOCK_STALE_MS = 2 * 60_000; // a user lock held this long is not a normal webhook any more

export default async (_req: Request): Promise<Response> => {
  const started = Date.now();
  const fly = flyClientOrNull();
  if (!fly) {
    return new Response(JSON.stringify({ ok: true, skipped: "provisioning not configured" }), { status: 200 });
  }
  const now = new Date();
  const estates = await listEstates();
  const stuckSuspends = estates.filter((e) => e.suspend_pending);
  const pending = estates.filter((e) => (e.status === "provisioning" || e.status === "pending_manual") && !e.suspend_pending && !workerActive(e, now));
  const due = estates.filter((e) => renewalDue(e, now) && !e.suspend_pending);
  const outcomes: Record<string, number> = {};
  const bump = (k: string) => { outcomes[k] = (outcomes[k] ?? 0) + 1; };

  // A paying customer's READY estate whose machine is stopped (autostart stays off after a resume, so the
  // proxy will not wake a machine the platform stopped): queue its start. One short Fly read per estate, in
  // parallel and only while enough of the function limit is left; the start itself goes through the
  // resume_pending machinery below (backoff, cap, health flag). Counted for /api/health as machine_stopped.
  let machineStopped = 0;
  const checkable = estates.filter((e) => e.status === "ready" && e.machine_id && !e.suspend_pending && !e.resume_pending && !workerActive(e, now));
  if (checkable.length && Date.now() - started <= HEALTH_START_BY_MS) {
    await Promise.all(
      checkable.map(async (e) => {
        try {
          if (!isGrantingUser(await getUserById(e.user_id))) return;
          const m = await fly.getMachine(e.app, e.machine_id!, 8000);
          if (m && m.state === "stopped") {
            machineStopped += 1;
            await markResumePending(e, now, "the machine was found stopped");
          }
        } catch {
          /* a failed look is simply repeated on the next tick */
        }
      }),
    );
  }

  // A SUSPENDED estate (no flags) that had a machine-config write recently is not trusted: a write whose Fly
  // update outlived its caller can be applied after the suspension (autostart on, machine launched). Those
  // estates are re-verified under the lock below until the write has settled (configWriteMarks).
  let reverify = new Set<string>();
  try {
    const marks = await configWriteMarks();
    reverify = new Set(estates.filter((e) => e.status === "suspended" && e.machine_id && !e.suspend_pending && !e.resume_pending && marks.has(e.user_id)).map((e) => e.user_id));
  } catch (err: any) {
    console.error("estate-tick: could not list the config-write marks:", String(err?.message ?? err).slice(0, 200));
  }

  // Reconcile suspended estates and pending suspensions against the user's billing, first: a machine may
  // still be billing (suspend not completed) or a paying customer may have a dead estate (resume not
  // completed). A paying user's estate is resumed/revived, otherwise the stop is retried; both with
  // backoff, a cap, and a slow bounded retry after it (retryDue).
  let failedSuspends = 0;
  let failedResumes = 0;
  const work: typeof estates = [];
  for (const e of estates) {
    if (!e.suspend_pending && !e.resume_pending && e.status !== "suspended") continue;
    const u = await getUserById(e.user_id);
    if (isGrantingUser(u)) {
      if (e.resume_pending?.failed) failedResumes += 1;
      if (retryDue(e.resume_pending, now)) work.push(e);
    } else if (e.suspend_pending || e.resume_pending) {
      if (e.suspend_pending?.failed) failedSuspends += 1;
      if (retryDue(e.suspend_pending, now)) work.push(e);
    } else if (reverify.has(e.user_id)) {
      work.push(e);
    }
  }
  for (const e of work) {
    if (Date.now() - started > BUDGET_MS) break;
    try {
      const r = await retryPendingSuspend(e.user_id, fly, now, { reverify: reverify.has(e.user_id) });
      bump(
        r.outcome === "suspended" ? "suspend_retry_ok"
        : r.outcome === "resumed" ? "resume_retry_ok"
        : r.outcome === "resume_failed" ? "resume_retry_failed"
        : r.outcome === "cleared" ? "suspend_retry_cleared"
        : r.outcome === "backoff" ? "reverify_backoff"
        : "suspend_retry_failed",
      );
      if (r.estate?.suspend_pending?.failed && !e.suspend_pending?.failed) failedSuspends += 1;
      if (r.estate?.resume_pending?.failed && !e.resume_pending?.failed) failedResumes += 1;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (/is busy/.test(msg)) {
        bump("lock_busy");
        const age = await userLockAgeMs(e.user_id).catch(() => null);
        if (age !== null && age > LOCK_STALE_MS) {
          bump("lock_stale");
          console.warn("estate-tick: a user lock has been held for", Math.round(age / 1000), "s (a killed webhook leaves it until its TTL)");
        }
      } else {
        bump("suspend_retry_threw");
        console.error("estate-tick: reconcile threw for an estate:", msg.slice(0, 200));
      }
    }
  }

  // One tiny counter record for the public health endpoint, so it never scans the estates itself.
  try {
    await (await portalStore()).setJSON("ops/suspend_failed", { count: failedSuspends, resume_failed: failedResumes, machine_stopped: machineStopped, at: now.toISOString() });
  } catch (err: any) {
    console.error("estate-tick: could not write the suspend-failed counter:", String(err?.message ?? err).slice(0, 200));
  }

  for (const e of pending) {
    if (Date.now() - started > BUDGET_MS) break;
    if (await kickWorker(e.user_id, "advance")) {
      bump("kicked");
      continue;
    }
    try {
      const r = await advanceEstate(e, fly);
      bump("direct_" + r.outcome);
    } catch (err: any) {
      bump("threw");
      console.error("estate-tick: advance threw for an estate:", String(err?.message ?? err).slice(0, 200));
    }
  }
  for (const e of due) {
    if (Date.now() - started > BUDGET_MS) break;
    bump((await kickWorker(e.user_id, "renew")) ? "renew_kicked" : "renew_kick_failed");
  }

  // Health: every ready estate without a live worker, in parallel (flags only; nothing is
  // destroyed). One look is bounded by the short Fly timeouts (8 s app, 8 s machine, 6 s health),
  // so it starts only while enough of the 30 s function limit is left; a skipped look is counted.
  const ready = estates.filter((e) => e.status === "ready" && !e.suspend_pending && !e.resume_pending && !workerActive(e, now));
  if (ready.length && Date.now() - started <= HEALTH_START_BY_MS) {
    const health = await Promise.all(ready.map((e) => checkEstateHealth(e, fly, { now }).catch(() => "threw" as const)));
    for (const h of health) bump("health_" + h);
  } else if (ready.length) {
    bump("health_skipped_budget");
  }

  // Image rollout: when FLY_ESTATE_IMAGE moves on (a label smoked on the sandbox first),
  // ready estates follow ONE per tick, and none while any estate failed on that image.
  // An estate whose self-agent renewal is due this tick waits (the worker lease serialises
  // the two anyway; this just avoids a pointless kick).
  const target = flyConfig()?.image;
  const halted = Boolean(target) && estates.some((e) => e.upgrade_failed_image === target);
  const drifted = ready.filter((e) => e.status === "ready" && e.image && target && e.image !== target && e.upgrade_failed_image !== target && !renewalDue(e, now));
  if (halted) bump("upgrade_halted");
  else if (drifted.length && Date.now() - started <= BUDGET_MS) {
    bump((await kickWorker(drifted[0].user_id, "upgrade")) ? "upgrade_kicked" : "upgrade_kick_failed");
  }

  console.log(`estate-tick: suspend-pending ${stuckSuspends.length}, pending ${pending.length}, renewals due ${due.length}, ready ${ready.length}, drifted ${drifted.length}, outcomes ${JSON.stringify(outcomes)}`);
  return new Response(JSON.stringify({ ok: true, suspend_pending: stuckSuspends.length, suspend_failed: failedSuspends, resume_failed: failedResumes, machine_stopped: machineStopped, pending: pending.length, renewals_due: due.length, ready: ready.length, drifted: drifted.length, outcomes }), { status: 200 });
};

export const config: Config = {
  schedule: "*/2 * * * *",
};
