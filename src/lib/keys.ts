// Force-Field Console — API keys.
//
// Only the sha256 hash of a key is stored; the plaintext is shown once at
// creation and never again. Key records live at "keys/<hash>" and a KeyRef
// copy lives on the owning user record.

import { createHash, randomBytes } from "node:crypto";
import { portalStore } from "./store";
import { getUserById, saveUser } from "./users";
import type { KeyRef, User } from "./users";

type KeyRecord = {
  user_id: string;
  label: string;
  prefix: string;
  created_at: string;
  revoked: boolean;
};

/** sha256 hex of the plaintext key. */
export function keyHash(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Issue a new API key for a user. Returns the plaintext (caller shows it
 * exactly once) and the stored KeyRef.
 */
export async function issueKey(user: User, label: string): Promise<{ plaintext: string; ref: KeyRef }> {
  const plaintext = "ff_live_" + randomBytes(20).toString("hex"); // 40 lowercase hex chars
  const prefix = plaintext.slice(0, 12);
  const hash = keyHash(plaintext);
  const created_at = new Date().toISOString();

  const store = await portalStore();
  await store.setJSON("keys/" + hash, {
    user_id: user.id,
    label,
    prefix,
    created_at,
    revoked: false,
  } satisfies KeyRecord);

  const ref: KeyRef = { hash, label, prefix, created_at, revoked: false };
  user.keys.push(ref);
  await saveUser(user);

  return { plaintext, ref };
}

/**
 * Resolve a plaintext key to its owner and KeyRef.
 * Returns null when the key is unknown or the owning user is missing.
 * DOES return revoked keys — the caller decides how to treat revocation
 * (the gateway answers 403 revoked_key rather than 401 unknown_key).
 */
export async function lookupKey(plaintext: string): Promise<{ user: User; ref: KeyRef } | null> {
  const hash = keyHash(plaintext);
  const store = await portalStore();
  const record = (await store.get("keys/" + hash, { type: "json" })) as KeyRecord | null;
  if (!record) return null;
  const user = await getUserById(record.user_id);
  if (!user) return null;
  const ref: KeyRef = {
    hash,
    label: record.label,
    prefix: record.prefix,
    created_at: record.created_at,
    revoked: record.revoked,
  };
  return { user, ref };
}

/**
 * Revoke a key by hash. Flips revoked in BOTH the "keys/<hash>" blob and the
 * matching user.keys entry, then saves the user. Returns false if the key is
 * absent from either place.
 */
export async function revokeKey(user: User, hash: string): Promise<boolean> {
  const entry = user.keys.find((k) => k.hash === hash);
  if (!entry) return false;

  const store = await portalStore();
  const record = (await store.get("keys/" + hash, { type: "json" })) as KeyRecord | null;
  if (!record) return false;

  record.revoked = true;
  await store.setJSON("keys/" + hash, record);

  entry.revoked = true;
  await saveUser(user);
  return true;
}
