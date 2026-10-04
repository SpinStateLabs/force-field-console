// auth.mts — Force-Field Console v0.1.0
// Registration, login, logout. Session is an HS256 JWT in the ff_session cookie.
// Never log emails, passwords, or tokens.
import type { Context, Config } from "@netlify/functions";
import { createUser, verifyUser, BadEmail, WeakPassword, EmailTaken } from "../../src/lib/users";
import { issueSession, sessionCookie, clearSessionCookie } from "../../src/lib/session";

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

function err(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

export default async (req: Request, _context: Context): Promise<Response> => {
  const pathname = new URL(req.url).pathname;

  if (req.method !== "POST") {
    return err(405, "method_not_allowed", "Use POST for this endpoint.");
  }

  if (pathname === "/api/auth/logout") {
    return new Response(null, {
      status: 204,
      headers: { "set-cookie": clearSessionCookie() },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err(400, "bad_json", "Request body must be valid JSON.");
  }
  const email = typeof body?.email === "string" ? body.email : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (pathname === "/api/auth/register") {
    try {
      const user = await createUser(email, password);
      const token = await issueSession(user.id);
      return json(201, { email: user.email, tier: user.tier }, { "set-cookie": sessionCookie(token) });
    } catch (e) {
      if (e instanceof BadEmail) {
        return err(400, "bad_email", "That does not look like a valid email address.");
      }
      if (e instanceof WeakPassword) {
        return err(400, "weak_password", "Password must be >= 10 characters.");
      }
      if (e instanceof EmailTaken) {
        return err(409, "email_taken", "An account with that email already exists.");
      }
      throw e;
    }
  }

  if (pathname === "/api/auth/login") {
    const user = await verifyUser(email, password);
    if (!user) {
      return err(401, "invalid_credentials", "Email or password is incorrect.");
    }
    const token = await issueSession(user.id);
    return json(200, { email: user.email, tier: user.tier }, { "set-cookie": sessionCookie(token) });
  }

  return err(404, "not_found", "Unknown auth endpoint.");
};

export const config: Config = {
  path: ["/api/auth/register", "/api/auth/login", "/api/auth/logout"],
};
