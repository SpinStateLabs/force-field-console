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
import { advanceEstate, checkEstateHealth, listEstates, workerActive } from "../../src/lib/estates";
import { renewalDue } from "../../src/lib/renewal";
import { kickWorker } from "../../src/lib/worker";

const BUDGET_MS = 20000;
const HEALTH_START_BY_MS = 6000;

export default async (_req: Request): Promise<Response> => {
  const started = Date.now();
  const fly = flyClientOrNull();
  if (!fly) {
    return new Response(JSON.stringify({ ok: true, skipped: "provisioning not configured" }), { status: 200 });
  }
  const now = new Date();
  const estates = await listEstates();
  const pending = estates.filter((e) => (e.status === "provisioning" || e.status === "pending_manual") && !workerActive(e, now));
  const due = estates.filter((e) => renewalDue(e, now));
  const outcomes: Record<string, number> = {};
  const bump = (k: string) => { outcomes[k] = (outcomes[k] ?? 0) + 1; };

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
  const ready = estates.filter((e) => e.status === "ready" && !workerActive(e, now));
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

  console.log(`estate-tick: pending ${pending.length}, renewals due ${due.length}, ready ${ready.length}, drifted ${drifted.length}, outcomes ${JSON.stringify(outcomes)}`);
  return new Response(JSON.stringify({ ok: true, pending: pending.length, renewals_due: due.length, ready: ready.length, drifted: drifted.length, outcomes }), { status: 200 });
};

export const config: Config = {
  schedule: "*/2 * * * *",
};
