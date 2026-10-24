// Force-Field Console - locks. Everything that moves a user's billing or estate (the Stripe webhook,
// the tick's suspend retry, suspend / resume, and every machine-config write) takes ONE lock per USER,
// so a cancellation of subscription A, the creation of subscription B and a stale config write can
// never interleave. (A lock keyed by the changing subscription id did not exclude A against B.)
import { randomUUID } from "node:crypto";
import { portalStore } from "./store";

// Sized above the worst case of one suspend (get + update + stop + wait + four read-backs, each with
// its own Fly timeout) plus margin: an expired lock lets a second writer in mid-transition.
export const SUB_LOCK_TTL_MS = 5 * 60_000;
export const SUB_LOCK_TRIES = 30;
export const SUB_LOCK_WAIT_MS = 100;

async function withLock<T>(key: string, label: string, fn: () => Promise<T>): Promise<T> {
  const store = await portalStore();
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
  throw new Error(label + " is busy; the event will be redelivered");
}

export function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return withLock("user_locks/" + userId, "user " + userId, fn);
}

export function withSubscriptionLock<T>(subId: string, fn: () => Promise<T>): Promise<T> {
  return withLock("stripe_sub_locks/" + subId, "subscription " + subId, fn);
}
