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
const MIN_PASSWORD_LENGTH = 10;

/** Blob key for a user record: "users/" + sha256hex(normalized email). */
export function emailKey(email: string): string {
  const normalized = email.trim().toLowerCase();
  return "users/" + createHash("sha256").update(normalized).digest("hex");
}

export async function createUser(email: string, password: string): Promise<User> {
  if (!EMAIL_RE.test(email)) throw new BadEmail("Invalid email address.");
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPassword(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const store = await portalStore();
  const key = emailKey(email);
  const existing = await store.get(key, { type: "json" });
  if (existing) throw new EmailTaken("An account with this email already exists.");

  const user: User = {
    id: crypto.randomUUID(),
    email: email.trim().toLowerCase(),
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
  const user = (await store.get(emailKey(email), { type: "json" })) as User | null;
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

/** Rewrite the user's blob record (keyed by email hash). */
export async function saveUser(u: User): Promise<void> {
  const store = await portalStore();
  await store.setJSON(emailKey(u.email), u);
}
