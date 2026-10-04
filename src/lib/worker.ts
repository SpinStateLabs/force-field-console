// Force-Field Console — the provisioning worker loop.
//
// Synchronous Netlify functions have a short execution limit (seconds), too
// short for an estate step that waits on a Fly exec or a machine boot. So the
// dashboard and the scheduled tick only KICK a background function
// (/.netlify/functions/estate-worker-background, up to 15 minutes; Netlify
// answers 202 at once) and this loop drives the estate's
// state machine step by step until it is ready, failed, or the budget is
// spent. A worker lease on the record keeps two workers off one estate; the
// per-step lease inside advanceEstate() covers the rest.
//
// Internal kicks (from the tick or the retry endpoint) are authenticated with
// an HMAC of the target user id under SESSION_SECRET — no session, no
// bearer token in the URL.

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./store";
import { advanceEstate, getEstate, saveEstate, upgradeEstateImage, workerActive, type AdvanceOutcome } from "./estates";
import { renewSelfAgents, renewalDue } from "./renewal";
import type { FlyClient } from "./fly";
import type { FetchLike } from "./fly";

export const WORKER_BUDGET_MS = 12 * 60 * 1000;
export const WORKER_PATH = "/.netlify/functions/estate-worker-background";
export type WorkerAction = "advance" | "renew" | "upgrade";

export function internalToken(userId: string, secret: string | undefined = env("SESSION_SECRET")): string {
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update("estate-worker:" + userId).digest("hex");
}

export function verifyInternalToken(token: string | null, userId: string, secret: string | undefined = env("SESSION_SECRET")): boolean {
  if (!token || !userId || !secret) return false;
  const expected = Buffer.from(internalToken(userId, secret), "utf8");
  const given = Buffer.from(token, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Fire-and-forget: invoke the background worker for a user. Returns whether the platform accepted it. */
export async function kickWorker(userId: string, action: WorkerAction = "advance", fetchImpl: FetchLike = fetch): Promise<boolean> {
  const base = env("URL");
  if (!base || !/^https?:\/\//.test(base)) return false;
  try {
    const res = await fetchImpl(base.replace(/\/+$/, "") + WORKER_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ff-internal": internalToken(userId) },
      body: JSON.stringify({ user_id: userId, action }),
      signal: AbortSignal.timeout(8000),
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

export type WorkerResult = {
  iterations: number;
  last: AdvanceOutcome | "no_estate" | "worker_active" | "renewed" | "not_due" | "renew_failed" | "upgraded" | "unchanged" | "upgrade_failed";
  status: string | null;
};

export async function runWorker(
  userId: string,
  action: WorkerAction,
  fly: FlyClient,
  opts: { budgetMs?: number; sleepMs?: number; fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
): Promise<WorkerResult> {
  const budgetMs = opts.budgetMs ?? WORKER_BUDGET_MS;
  const sleepMs = opts.sleepMs ?? 5000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const e = await getEstate(userId);
  if (!e) return { iterations: 0, last: "no_estate", status: null };

  if (action === "renew" && !renewalDue(e)) return { iterations: 0, last: "not_due", status: e.status };

  // Every action holds the worker lease: renew and upgrade both update the
  // machine of a READY estate and must never interleave (a renew's restart
  // could otherwise re-apply the pre-upgrade config).
  if (workerActive(e)) return { iterations: 0, last: "worker_active", status: e.status };
  const started = Date.now();
  e.worker_until = new Date(started + budgetMs + 60_000).toISOString();
  await saveEstate(e);

  if (action === "renew") {
    try {
      await renewSelfAgents(e, fly);
      return { iterations: 1, last: "renewed", status: e.status };
    } catch {
      return { iterations: 1, last: "renew_failed", status: e.status };
    } finally {
      const cur = await getEstate(userId);
      if (cur) {
        cur.worker_until = null;
        await saveEstate(cur);
      }
    }
  }

  if (action === "upgrade") {
    try {
      const r = await upgradeEstateImage(e, fly, { fetchImpl: opts.fetchImpl, sleep: opts.sleep, sleepMs });
      return { iterations: 1, last: r.outcome === "failed" ? "upgrade_failed" : r.outcome, status: r.estate.status };
    } catch {
      return { iterations: 1, last: "upgrade_failed", status: e.status };
    } finally {
      const cur = await getEstate(userId);
      if (cur) {
        cur.worker_until = null;
        await saveEstate(cur);
      }
    }
  }

  let iterations = 0;
  let last: AdvanceOutcome = "idle";
  let status: string = e.status;
  try {
    while (Date.now() - started < budgetMs) {
      const cur = await getEstate(userId);
      if (!cur) break;
      const r = await advanceEstate(cur, fly, { fetchImpl: opts.fetchImpl });
      iterations += 1;
      last = r.outcome;
      status = r.estate.status;
      if (r.outcome === "done" || r.outcome === "idle" || r.estate.status !== "provisioning") break;
      await sleep(r.outcome === "waiting" ? sleepMs : r.outcome === "error" ? Math.min(sleepMs, 3000) : 250);
    }
  } finally {
    const cur = await getEstate(userId);
    if (cur) {
      cur.worker_until = null;
      await saveEstate(cur);
    }
  }
  return { iterations, last, status };
}
