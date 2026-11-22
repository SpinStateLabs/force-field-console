// gateway.mts — Force-Field Console v0.2.0
// Authenticated proxy from /api/v1/* to the engine estate (ONE reverse-proxy
// origin fronting the field-platform services). Auth is ONLY the x-api-key
// header. Responses are buffered — no streaming in v0.
// Never log or forward API keys, cookies, or Authorization headers upstream.
import type { Context, Config } from "@netlify/functions";
import { env } from "../../src/lib/store";
import { lookupKey } from "../../src/lib/keys";
import { checkRateLimit } from "../../src/lib/ratelimit";
import { getEstate, resolveRoute } from "../../src/lib/estates";
import { agentsInUse, canonicalPath, classify, poolFor } from "../../src/lib/agentpool";
import { LockBusyError, withAgentPoolLock } from "../../src/lib/locks";

class UpstreamReadError extends Error {
  constructor(public status: number) {
    super("upstream " + status);
  }
}

function err(status: number, code: string, message: string, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

export default async (req: Request, _context: Context): Promise<Response> => {
  const url = new URL(req.url);

  // --- Authenticate: x-api-key only. Sessions do not grant engine access. ---
  const apiKey = req.headers.get("x-api-key");
  if (!apiKey) {
    return err(401, "missing_key", "Provide an API key in the x-api-key header.");
  }
  const found = await lookupKey(apiKey);
  if (!found) {
    return err(401, "unknown_key", "That API key is not recognized.");
  }
  if (found.ref.revoked) {
    return err(403, "revoked_key", "That API key has been revoked.");
  }
  const { user, ref } = found;

  // --- Rate limit (Declared, approximate fixed windows — not an Enforced hard cap). ---
  const rl = await checkRateLimit(ref.hash, user.tier);
  if (!rl.allowed) {
    const retryAfter = String(rl.retry_after_s ?? 60);
    return err(
      429,
      "rate_limited",
      "Rate limit reached for your tier. Retry after the window resets.",
      { "retry-after": retryAfter },
    );
  }

  // --- Tenant routing: a ready dedicated estate, else the shared sandbox. ---
  // Provisioning / suspended / failed estates are refused honestly rather than
  // silently falling back to the sandbox (which would mix the tenant's data).
  const route = resolveRoute(user, await getEstate(user.id));
  if (route.kind === "refuse") {
    if (route.extra) {
      return new Response(JSON.stringify({ error: { code: route.code, message: route.message, ...route.extra } }), {
        status: route.status,
        headers: { "content-type": "application/json" },
      });
    }
    return err(route.status, route.code, route.message);
  }
  let estateUrl: string | undefined;
  let sharedSecret: string | undefined;
  if (route.kind === "estate") {
    estateUrl = route.url;
    sharedSecret = route.secret;
  } else {
    // --- Estate attachment: be honest when the engine is not publicly hosted yet. ---
    estateUrl = env("ESTATE_URL");
    sharedSecret = env("ESTATE_SHARED_SECRET");
    if (!estateUrl) {
      return err(
        503,
        "estate_not_attached",
        "The sandbox estate is not attached yet. The console is live; the governance engine endpoint will be attached shortly.",
      );
    }
  }

  // --- Proxy. Strip the /api/v1 prefix; keep the query string. ---
  const base = estateUrl.replace(/\/+$/, "");
  const target = base + url.pathname.slice("/api/v1".length) + url.search;

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  // The caller's agent identity and preset headers (x-field-agent-id, x-field-token,
  // x-field-action, x-force-preset, ...) pass through: an enforcing estate gateway
  // refuses /v1/messages without them. The perimeter secret (x-field-auth) and the
  // tenant header are always the portal's own values, never the caller's.
  for (const [name, value] of req.headers) {
    const n = name.toLowerCase();
    if ((n.startsWith("x-field-") || n.startsWith("x-force-")) && n !== "x-field-auth") headers.set(n, value);
  }
  if (sharedSecret) headers.set("x-field-auth", sharedSecret);
  headers.set("x-ff-tenant", user.id);
  // Deliberately NOT forwarded: cookie, authorization, x-api-key, a caller's x-field-auth or x-ff-tenant.

  const method = req.method.toUpperCase();
  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await req.arrayBuffer();
  }

  const forward = async (): Promise<Response> => {
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        return err(504, "upstream_timeout", "The engine estate did not respond within 30 seconds.");
      }
      return err(502, "upstream_unreachable", "Could not reach the engine estate.");
    }

    // Buffer and return the upstream status, body, and content-type verbatim.
    // No streaming in v0.
    const upstreamBody = await upstream.arrayBuffer();
    const responseHeaders: Record<string, string> = {};
    const upstreamContentType = upstream.headers.get("content-type");
    if (upstreamContentType) responseHeaders["content-type"] = upstreamContentType;
    return new Response(upstreamBody, { status: upstream.status, headers: responseHeaders });
  };

  // --- Agent pool (price book rev 2): gate what can add an agent on a dedicated estate. ---
  // The decision uses the path as the upstream will route it (decoded, slashes collapsed); a path that cannot be
  // decoded is refused for every route rather than guessed at.
  const canon = canonicalPath(url.pathname.slice("/api/v1".length));
  if (canon === null) {
    return err(400, "bad_path", "The request path could not be decoded.");
  }
  const pool = route.kind === "estate" ? poolFor(user) : null;
  const gate = pool === null ? null : classify(method, canon, body);
  if (pool === null || gate === null) return forward();

  const readUpstream = async (path: string): Promise<unknown> => {
    const h = new Headers();
    h.set("accept", "application/json");
    if (sharedSecret) h.set("x-field-auth", sharedSecret);
    h.set("x-ff-tenant", user.id);
    const r = await fetch(base + path, { method: "GET", headers: h, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new UpstreamReadError(r.status);
    return r.json();
  };

  try {
    return await withAgentPoolLock(user.id, async () => {
      if (gate.kind === "maybe_revive") {
        let current: any;
        try {
          current = await readUpstream("/registry/agents/" + encodeURIComponent(gate.agent_id));
        } catch (e) {
          // 404: no such agent, the upstream answers the PATCH itself and nothing can be revived. Any other failure is
          // fail closed: the PATCH might revive a retired agent past the pool.
          if (e instanceof UpstreamReadError && e.status === 404) return forward();
          return err(503, "agent_count_unavailable", "The agent's current status could not be read; nothing was changed. Retry shortly.");
        }
        if (String(current?.status ?? "").toLowerCase() !== "retired") return forward(); // not a revival
      }
      let inUse: number | null = null;
      try {
        inUse = agentsInUse(await readUpstream("/registry/agents"));
      } catch {
        inUse = null;
      }
      if (inUse === null) {
        return err(503, "agent_count_unavailable", "The estate's agent count could not be read; nothing was registered. Retry shortly.");
      }
      if (inUse >= pool) {
        return new Response(
          JSON.stringify({
            error: {
              code: "agent_pool_full",
              message: `Your plan allows ${pool} governed agents and ${inUse} are in use. Retire an agent, add seats, or add a top-up pack.`,
              agent_pool: pool,
              in_use: inUse,
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      return forward();
    });
  } catch (e) {
    if (e instanceof LockBusyError) {
      return err(409, "agent_pool_busy", "Another agent change for this account is in progress; retry in a moment.", { "retry-after": "2" });
    }
    throw e;
  }
};

export const config: Config = {
  path: "/api/v1/*",
};
