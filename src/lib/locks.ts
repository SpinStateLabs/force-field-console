// Force-Field Console - the per-subscription lock. Everything that changes an estate's machine on a
// subscription's behalf (the Stripe webhook, the tick's suspend retry, and every machine-config write)
// takes it, so a cancellation and a config write can never interleave.
import { randomUUID } from "node:crypto";
import { portalStore } from "./store";

export const SUB_LOCK_TTL_MS = 60_000;
export const SUB_LOCK_TRIES = 30;
export const SUB_LOCK_WAIT_MS = 100;

export async function withSubscriptionLock<T>(subId: string, fn: () => Promise<T>): Promise<T> {
  const store = await portalStore();
  const key = "stripe_sub_locks/" + subId;
  const token = randomUUID();
  for (let i = 0; i < SUB_LOCK_TRIES; i++) {
    const now = Date.now();
    const lock = { token, expires_at: new Date(now + SUB_LOCK_TTL_MS).toISOString() };
    let got = await store.setJSONIfNew(key, lock);
    if (!got) {
      const read = await store.getWithEtag(key);
      if (read && new Date(read.data?.expires_at ?? 0).getTime() <= now) got = await store.setJSONIfMatch(key, lock, read.etag); // expired: conditional takeover
      else if (!read) got = await store.setJSONIfNew(key, lock);
    }
    if (got) {
      try {
        return await fn();
      } finally {
        const cur = await store.getWithEtag(key).catch(() => null);
        if (cur?.data?.token === token) await store.delete(key).catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, SUB_LOCK_WAIT_MS));
  }
  throw new Error("subscription " + subId + " is busy; the event will be redelivered");
}
