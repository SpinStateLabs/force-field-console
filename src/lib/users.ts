// Force-Field Console — user records.
//
// Users are stored in the portal blob store at "users/<sha256(email)>" with a
// pointer blob "uid/<id>" -> { email_key } for id-based lookup.

import { createHash } from "node:crypto";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { portalStore } from "./store";

export type Tier = "sandbox" | "operator" | "sovereign";

export type KeyRef = {
  hash: string;
  label: string;
  prefix: string;
  created_at: string;
  revoked: boolean;
};

/** Stripe subscription state mirrored from webhooks (never card data). */
export type Billing = {
  customer_id: string;
  subscription_id: string | null;
  status: string;
  price_id: string | null;
  tier: Tier;
  current_period_end: string | null;
  updated_at: string;
  /** Other granting subscriptions of this customer seen while another one was current (adopted when the current one ends). */
  other_subs?: Record<string, { status: string; price_id: string | null }>;
  /** Audit H1: the subscription is in a granting status on a price id that maps to no configured tier. */
  price_unmatched?: true;
  /**
   * The event applied last was not a live-mode Stripe event (livemode false, missing or not a boolean) and the
   * test-mode opt-in was not set: the tier is granted, but nothing starts, resumes or provisions on Fly for it.
   */
  test_mode?: true;
};

export type User = {
  id: string;
  email: string;
  pw_hash: string;
  tier: Tier;
  created_at: string;
  keys: KeyRef[];
  billing?: Billing | null;
};

export class BadEmail extends Error {}
export class WeakPassword extends Error {}
export class EmailTaken extends Error {}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** RFC 5321 path limit. The email becomes the estate grantor, the owner-roster row and the attestation signer statement. */
export const MAX_EMAIL_LENGTH = 254;
/** Control (Cc: C0, DEL, C1) and format (Cf: zero-width, bidi overrides, BOM, ...) characters: never in an email we record. */
const UNSAFE_EMAIL_CHARS = /[\p{Cc}\p{Cf}]/u;
/**
 * A lone (unpaired) surrogate. With the u flag, \p{Cs} matches only unpaired halves, never a valid pair such as an
 * emoji. A lone surrogate is not valid Unicode: it hashes (via UTF-8) to the same replacement character as any other
 * lone surrogate, so distinct strings would share one user key, and it cannot be written to the estate's roster files.
 */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * True when `email`, exactly as given, is acceptable for a new account (whitespace anywhere is refused, as before).
 * The length bound applies to the value as given AND to the stored form (canonicalEmail: trimmed, lower-cased, NFC),
 * because lower-casing and NFC can lengthen a string (for example U+0130 lower-cases to two code units). A domain
 * ending in a dot is refused.
 */
export function isAcceptableEmail(email: unknown): email is string {
  if (typeof email !== "string") return false;
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return false;
  if (LONE_SURROGATE.test(email)) return false;
  if (UNSAFE_EMAIL_CHARS.test(email)) return false;
  if (canonicalEmail(email).length > MAX_EMAIL_LENGTH) return false;
  if (!EMAIL_RE.test(email)) return false;
  // "a@example.com." names the same mailbox as "a@example.com" in DNS: refuse it so one address cannot hold two accounts.
  return !email.endsWith(".");
}

/**
 * The stored form of an email: trimmed, lower-cased, then Unicode NFC. Two spellings of the same address that differ
 * only in normalisation form (a precomposed "\u00e9" or "e" + U+0301) have one stored form and one user key. For ASCII
 * addresses this is exactly the old form (trimmed, lower-cased), so every existing ASCII account keeps its key.
 */
export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase().normalize("NFC");
}

/** The old stored form (trimmed, lower-cased, not normalised): accounts created before NFC keys live under it. */
function legacyForms(email: string): string[] {
  const lowered = email.trim().toLowerCase();
  return [lowered, lowered.normalize("NFD")];
}

function keyOf(normalized: string): string {
  return "users/" + createHash("sha256").update(normalized).digest("hex");
}

/**
 * Every key an account for `email` may live under, the current (NFC) key first. Accounts created before NFC keys were
 * stored under sha256(trimmed, lower-cased email as typed): the as-typed and NFD spellings cover them.
 */
export function candidateEmailKeys(email: string): string[] {
  const keys = [emailKey(email)];
  for (const form of legacyForms(email)) {
    const k = keyOf(form);
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}
const MIN_PASSWORD_LENGTH = 10;

/** Blob key for a new user record: "users/" + sha256hex(canonicalEmail(email)). */
export function emailKey(email: string): string {
  return keyOf(canonicalEmail(email));
}

async function findByEmail(store: Awaited<ReturnType<typeof portalStore>>, email: string): Promise<User | null> {
  for (const key of candidateEmailKeys(email)) {
    const user = (await store.get(key, { type: "json" })) as User | null;
    if (user) return user;
  }
  return null;
}

export async function createUser(email: string, password: string): Promise<User> {
  if (!isAcceptableEmail(email)) throw new BadEmail("Invalid email address.");
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPassword(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const store = await portalStore();
  const key = emailKey(email);
  const existing = await findByEmail(store, email);
  if (existing) throw new EmailTaken("An account with this email already exists.");

  const user: User = {
    id: crypto.randomUUID(),
    email: canonicalEmail(email),
    pw_hash: bcrypt.hashSync(password, 10),
    tier: "sandbox",
    created_at: new Date().toISOString(),
    keys: [],
  };

  await store.setJSON(key, user);
  await store.setJSON("uid/" + user.id, { email_key: key });
  return user;
}

export async function verifyUser(email: string, password: string): Promise<User | null> {
  const store = await portalStore();
  if (typeof email !== "string") return null;
  const user = await findByEmail(store, email);
  if (!user) return null;
  return bcrypt.compareSync(password, user.pw_hash) ? user : null;
}

export async function getUserById(id: string): Promise<User | null> {
  const store = await portalStore();
  const pointer = (await store.get("uid/" + id, { type: "json" })) as { email_key: string } | null;
  if (!pointer?.email_key) return null;
  const user = (await store.get(pointer.email_key, { type: "json" })) as User | null;
  return user ?? null;
}

/**
 * Rewrite the user's blob record AT THE KEY THE uid/<id> POINTER NAMES. An account created before NFC keys may live
 * under its old key; writing to emailKey(u.email) (the NFC key) would fork it: a second record that by-id reads
 * (billing, keys, the gateway) never see. Only a user with no pointer at all (never stored by createUser) falls back
 * to emailKey.
 */
export async function saveUser(u: User): Promise<void> {
  const store = await portalStore();
  const pointer = (await store.get("uid/" + u.id, { type: "json" })) as { email_key?: string } | null;
  const key = typeof pointer?.email_key === "string" && pointer.email_key.startsWith("users/") ? pointer.email_key : emailKey(u.email);
  await store.setJSON(key, u);
}
