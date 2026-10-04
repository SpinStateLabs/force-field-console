// keys.mts — Force-Field Console v0.1.0
// API key management. The plaintext key is returned exactly ONCE at creation;
// only its sha256 hash is stored. Never log plaintext keys.
import type { Context, Config } from "@netlify/functions";
import { readSession } from "../../src/lib/session";
import { getUserById } from "../../src/lib/users";
import type { User } from "../../src/lib/users";
import { issueKey, revokeKey } from "../../src/lib/keys";

const MAX_ACTIVE_KEYS = 5;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function err(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

async function requireUser(req: Request): Promise<User | null> {
  const userId = await readSession(req);
  return userId ? await getUserById(userId) : null;
}

export default async (req: Request, _context: Context): Promise<Response> => {
  const pathname = new URL(req.url).pathname;

  const user = await requireUser(req);
  if (!user) {
    return err(401, "unauthenticated", "Sign in to manage API keys.");
  }

  // GET /api/keys — list key references (hashes and prefixes only, never plaintext).
  if (req.method === "GET" && pathname === "/api/keys") {
    return json(200, {
      keys: user.keys.map((k) => ({
        id: k.hash,
        label: k.label,
        prefix: k.prefix,
        created_at: k.created_at,
        revoked: k.revoked,
      })),
    });
  }

  // POST /api/keys — create a key. Plaintext is shown once, here, and never again.
  if (req.method === "POST" && pathname === "/api/keys") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return err(400, "bad_json", "Request body must be valid JSON.");
    }
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    if (!label) {
      return err(400, "bad_label", "Provide a non-empty string label for the key.");
    }

    const activeCount = user.keys.filter((k) => !k.revoked).length;
    if (activeCount >= MAX_ACTIVE_KEYS) {
      return err(400, "key_limit", `Limit of ${MAX_ACTIVE_KEYS} active keys per user. Revoke a key to create another.`);
    }

    const { plaintext, ref } = await issueKey(user, label);
    return json(201, { key: plaintext, id: ref.hash, prefix: ref.prefix, label: ref.label });
  }

  // DELETE /api/keys/<hash> — revoke (not delete; the record is kept, flagged revoked).
  if (req.method === "DELETE" && pathname.startsWith("/api/keys/")) {
    const hash = pathname.slice("/api/keys/".length);
    if (!hash) {
      return err(404, "not_found", "No such key.");
    }
    const ok = await revokeKey(user, hash);
    if (!ok) {
      return err(404, "not_found", "No such key.");
    }
    return json(200, { revoked: true });
  }

  return err(405, "method_not_allowed", "Unsupported method for this endpoint.");
};

export const config: Config = {
  path: ["/api/keys", "/api/keys/*"],
};
