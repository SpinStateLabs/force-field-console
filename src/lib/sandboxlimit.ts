// Force-Field Console — per-account limit for sentinel checks on the shared sandbox, and an optional ceiling across all
// accounts.
//
// The per-key limiter (src/lib/ratelimit.ts) counts per API key. The shared sandbox is one estate for every account
// without a dedicated estate, so `POST /sentinel/check` there is also counted per ACCOUNT (the user id, which does not
// change when keys are created or revoked), in ONE record per account:
//   "rate/acct/<userId>" = { day: "<UTC yyyymmdd>", d: <checks that day>, minute: "<UTC yyyymmddHHMM>", m: <checks that minute> }
// Both windows are read and decided first; only an allowed check is counted, in the day and the minute window together,
// with one conditional write (create-only, or compare-and-set on the etag), retried a few times. A refused check uses up
// nothing. A write that keeps losing to concurrent writers is refused (429, retry-after 1) rather than let through
// uncounted.
//
// Optional ceiling across all accounts (off unless SANDBOX_GLOBAL_RPM is a positive integer), also ONE record:
//   "rate/sandbox" = { minute: "<UTC yyyymmddHHMM>", count }
// It is read before the account check (a refusal there counts nothing) and incremented only for checks the account
// limit allowed. It is a load guard, counted approximately (read, then write), like ratelimit.ts.
//
// Settings (environment, read per call): SANDBOX_ACCOUNT_RPM and SANDBOX_ACCOUNT_RPD (positive integers; default: the
// sandbox tier's per-key numbers in src/lib/tiers.ts), SANDBOX_GLOBAL_RPM (positive integer; unset, 0 or anything else
// means off).

import { env, portalStore } from "./store";
import { TIERS } from "./tiers";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const MAX_TRIES = 3;
export const GLOBAL_KEY = "rate/sandbox";
export const accountKey = (userId: string) => `rate/acct/${userId}`;

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

const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export type SandboxDecision = { allowed: true } | { allowed: false; reason: "minute" | "day" | "busy"; retry_after_s: number };

/**
 * Decide one sandbox sentinel check for `userId` on both windows, and count it (day and minute together) only if it is
 * allowed. A malformed stored count reads as full (refused), never as zero.
 */
export async function takeSandboxCheck(userId: string, now: Date = new Date()): Promise<SandboxDecision> {
  const { rpm, rpd } = sandboxLimits();
  const s = stamps(now);
  const store = await portalStore();
  const key = accountKey(userId);
  for (let i = 0; i < MAX_TRIES; i++) {
    const cur = await store.getWithEtag(key);
    const rec = (cur?.data ?? {}) as { day?: unknown; d?: unknown; minute?: unknown; m?: unknown };
    const d = rec.day === s.day ? count(rec.d) ?? rpd : 0;
    const m = rec.minute === s.minute ? count(rec.m) ?? rpm : 0;
    if (d >= rpd) return { allowed: false, reason: "day", retry_after_s: secondsToNextDay(now) };
    if (m >= rpm) return { allowed: false, reason: "minute", retry_after_s: secondsToNextMinute(now) };
    const next = { day: s.day, d: d + 1, minute: s.minute, m: m + 1 };
    const ok = cur ? await store.setJSONIfMatch(key, next, cur.etag) : await store.setJSONIfNew(key, next);
    if (ok) return { allowed: true };
  }
  return { allowed: false, reason: "busy", retry_after_s: 1 };
}

/** Read-only check of the optional ceiling across all accounts. Always allowed when SANDBOX_GLOBAL_RPM is not set. */
export async function peekSandboxGlobal(now: Date = new Date()): Promise<{ allowed: true } | { allowed: false; retry_after_s: number }> {
  const { globalRpm } = sandboxLimits();
  if (globalRpm === null) return { allowed: true };
  const rec = (await (await portalStore()).get(GLOBAL_KEY, { type: "json" })) as { minute?: unknown; count?: unknown } | null;
  const c = rec?.minute === stamps(now).minute ? count(rec?.count) ?? globalRpm : 0;
  return c >= globalRpm ? { allowed: false, retry_after_s: secondsToNextMinute(now) } : { allowed: true };
}

/** Count one allowed check in the ceiling's minute window (approximate). Does nothing when the ceiling is off. */
export async function countSandboxGlobal(now: Date = new Date()): Promise<void> {
  if (sandboxLimits().globalRpm === null) return;
  const store = await portalStore();
  const minute = stamps(now).minute;
  const rec = (await store.get(GLOBAL_KEY, { type: "json" })) as { minute?: unknown; count?: unknown } | null;
  const c = rec?.minute === minute ? count(rec?.count) ?? 0 : 0;
  await store.setJSON(GLOBAL_KEY, { minute, count: c + 1 });
}
