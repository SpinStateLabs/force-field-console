// Force-Field Console — browser sessions.
//
// Sessions are HS256 JWTs in an HttpOnly cookie (ff_session), 7-day expiry.
// Known limit (documented in the README): JWTs are stateless, so a session
// cannot be revoked server-side before it expires; logout clears the cookie
// on the client only.

import { SignJWT, jwtVerify } from "jose";
import { env } from "./store";

const COOKIE_NAME = "ff_session";
const MAX_AGE_S = 604800; // 7 days

function secretKey(): Uint8Array {
  const secret = env("SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function issueSession(userId: string): Promise<string> {
  return await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secretKey());
}

/**
 * Read and verify the session cookie from a Request.
 * Returns the user id (JWT sub) or null on ANY failure — missing cookie,
 * bad signature, expired token, malformed header, unset secret.
 */
export async function readSession(req: Request): Promise<string | null> {
  try {
    const header = req.headers.get("cookie") ?? "";
    const pair = header
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(COOKIE_NAME + "="));
    if (!pair) return null;
    const token = pair.slice(COOKIE_NAME.length + 1);
    if (!token) return null;
    const { payload } = await jwtVerify(token, secretKey());
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
