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

export const config: Config = {
  path: "/api/v1/*",
};
