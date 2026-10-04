// Force-Field Console — per-key rate limiting.
//
// Fixed windows stored in the portal blob store:
//   "rate/<keyHash>/m<UTC yyyymmddHHMM>"  minute window, value { count }
//   "rate/<keyHash>/d<UTC yyyymmdd>"      day window,    value { count }
//
// HONESTY NOTE (Enforced vs Declared): the counter is read -> incremented ->
// written with last-write-wins blob semantics, so concurrent requests can
// under-count. This is an APPROXIMATE limiter — a Declared limit, not an
// Enforced hard cap. Do not describe it as a hard guarantee anywhere.

import { portalStore } from "./store";
import { TIERS } from "./tiers";
import type { Tier } from "./users";

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function windowKeys(keyHashHex: string, t: Date): { minuteKey: string; dayKey: string } {
  const y = t.getUTCFullYear();
  const mo = pad(t.getUTCMonth() + 1);
  const d = pad(t.getUTCDate());
  const h = pad(t.getUTCHours());
  const mi = pad(t.getUTCMinutes());
  return {
    minuteKey: `rate/${keyHashHex}/m${y}${mo}${d}${h}${mi}`,
    dayKey: `rate/${keyHashHex}/d${y}${mo}${d}`,
  };
}

export async function checkRateLimit(
  keyHashHex: string,
  tier: Tier,
  now?: Date,
): Promise<{ allowed: boolean; remaining_minute: number; remaining_day: number; retry_after_s?: number }> {
  const t = now ?? new Date();
  const limits = TIERS[tier];
  const { minuteKey, dayKey } = windowKeys(keyHashHex, t);

  const store = await portalStore();
  const minuteRec = (await store.get(minuteKey, { type: "json" })) as { count: number } | null;
  const dayRec = (await store.get(dayKey, { type: "json" })) as { count: number } | null;
  const minuteCount = minuteRec?.count ?? 0;
  const dayCount = dayRec?.count ?? 0;

  if (minuteCount >= limits.rpm) {
    // Seconds until the next UTC minute window opens.
    const retry_after_s = Math.max(1, 60 - t.getUTCSeconds());
    return {
      allowed: false,
      remaining_minute: 0,
      remaining_day: Math.max(0, limits.rpd - dayCount),
      retry_after_s,
    };
  }

  if (dayCount >= limits.rpd) {
    // Seconds until the next UTC day window opens.
    const nextUtcDay = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1);
    const retry_after_s = Math.max(1, Math.ceil((nextUtcDay - t.getTime()) / 1000));
    return {
      allowed: false,
      remaining_minute: Math.max(0, limits.rpm - minuteCount),
      remaining_day: 0,
      retry_after_s,
    };
  }

  await store.setJSON(minuteKey, { count: minuteCount + 1 });
  await store.setJSON(dayKey, { count: dayCount + 1 });

  return {
    allowed: true,
    remaining_minute: limits.rpm - (minuteCount + 1),
    remaining_day: limits.rpd - (dayCount + 1),
  };
}
