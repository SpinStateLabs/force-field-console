// Force-Field Console — per-account limit for sentinel checks on the shared sandbox, and an optional ceiling across all
// accounts.
//
// The per-key limiter (src/lib/ratelimit.ts) counts per API key. The shared sandbox is one estate for every account
// without a dedicated estate, so `POST /sentinel/check` there is also counted per ACCOUNT (the user id, which does not
// change when keys are created or revoked):
//   "rate/acct/<userId>/m<UTC yyyymmddHHMM>"  minute window, value { count }
//   "rate/acct/<userId>/d<UTC yyyymmdd>"      day window,    value { count }
// Counting uses the store's conditional writes (create-only, then compare-and-set on the etag), retried a few times;
// a write that keeps losing to concurrent writers is refused rather than let through uncounted.
//
// Optional ceiling across all accounts (off unless SANDBOX_GLOBAL_RPM is a positive integer):
//   "rate/sandbox/m<UTC yyyymmddHHMM>"        minute window, value { count }
// It is a load guard, counted approximately (read, then write), like ratelimit.ts.
//
// Settings (environment, read per call): SANDBOX_ACCOUNT_RPM and SANDBOX_ACCOUNT_RPD (positive integers; default: the
// sandbox tier's per-key numbers in src/lib/tiers.ts), SANDBOX_GLOBAL_RPM (positive integer; unset, 0 or anything else
// means off).

import { env, portalStore } from "./store";
import { TIERS } from "./tiers";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const MAX_TRIES = 3;

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (!/^[0-9]{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

export function sandboxLimits(): { rpm: number; rpd: number; globalRpm: number | null } {
  return {
    rpm: positiveInt(env("SANDBOX_ACCOUNT_RPM")) ?? TIERS.sandbox.rpm,
    rpd: positiveInt(env("SANDBOX_ACCOUNT_RPD")) ?? TIERS.sandbox.rpd,
    globalRpm: positiveInt(env("SANDBOX_GLOBAL_RPM")),
  };
}

function stamps(t: Date): { minute: string; day: string } {
  const day = `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`;
  return { day, minute: `${day}${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}` };
}

const secondsToNextMinute = (t: Date) => Math.max(1, 60 - t.getUTCSeconds());
const secondsToNextDay = (t: Date) =>
  Math.max(1, Math.ceil((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1) - t.getTime()) / 1000));

/** Add one to the counter at `key` unless it has reached `limit`. "busy": the conditional write kept losing. */
async function take(key: string, limit: number): Promise<"ok" | "full" | "busy"> {
  const store = await portalStore();
  for (let i = 0; i < MAX_TRIES; i++) {
    const cur = await store.getWithEtag(key);
    if (!cur) {
      if (limit < 1) return "full";
      if (await store.setJSONIfNew(key, { count: 1 })) return "ok";
      continue;
    }
    const count = typeof cur.data?.count === "number" && cur.data.count >= 0 ? cur.data.count : limit;
    if (count >= limit) return "full";
    if (await store.setJSONIfMatch(key, { count: count + 1 }, cur.etag)) return "ok";
  }
  return "busy";
}

export type SandboxDecision = { allowed: true } | { allowed: false; reason: "minute" | "day" | "busy"; retry_after_s: number };

/** Count one sandbox sentinel check for `userId`. The day window is checked first, then the minute window. */
export async function takeSandboxCheck(userId: string, now: Date = new Date()): Promise<SandboxDecision> {
  const { rpm, rpd } = sandboxLimits();
  const s = stamps(now);
  const day = await take(`rate/acct/${userId}/d${s.day}`, rpd);
  if (day === "full") return { allowed: false, reason: "day", retry_after_s: secondsToNextDay(now) };
  if (day === "busy") return { allowed: false, reason: "busy", retry_after_s: 1 };
  const minute = await take(`rate/acct/${userId}/m${s.minute}`, rpm);
  if (minute === "full") return { allowed: false, reason: "minute", retry_after_s: secondsToNextMinute(now) };
  if (minute === "busy") return { allowed: false, reason: "busy", retry_after_s: 1 };
  return { allowed: true };
}

/** The optional ceiling across all accounts. Always allowed when SANDBOX_GLOBAL_RPM is not set. */
export async function takeSandboxGlobal(now: Date = new Date()): Promise<{ allowed: true } | { allowed: false; retry_after_s: number }> {
  const { globalRpm } = sandboxLimits();
  if (globalRpm === null) return { allowed: true };
  const store = await portalStore();
  const key = `rate/sandbox/m${stamps(now).minute}`;
  const rec = (await store.get(key, { type: "json" })) as { count?: number } | null;
  const count = typeof rec?.count === "number" ? rec.count : 0;
  if (count >= globalRpm) return { allowed: false, retry_after_s: secondsToNextMinute(now) };
  await store.setJSON(key, { count: count + 1 });
  return { allowed: true };
}
