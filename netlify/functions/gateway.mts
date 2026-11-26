// gateway.mts — Force-Field Console v0.2.0
// Authenticated proxy from /api/v1/* to the engine estate (ONE reverse-proxy
// origin fronting the field-platform services). Auth is ONLY the x-api-key
// header. Responses are buffered — no streaming in v0.
// Never log or forward API keys, cookies, or Authorization headers upstream.
import type { Context, Config } from "@netlify/functions";
import { env } from "../../src/lib/store";
import { lookupKey } from "../../src/lib/keys";
import { checkRateLimit } from "../../src/lib/ratelimit";
import { getEstate, newAppName, resolveRoute } from "../../src/lib/estates";
import { estateOrigin } from "../../src/lib/fly";
import { agentsInUse, canonicalPath, classify, poolFor } from "../../src/lib/agentpool";
import { LockBusyError, withAgentPoolLock } from "../../src/lib/locks";

import {
  FORWARDED_CALLER_HEADERS,
  GATEWAY_PREFIX,
  isRedirectStatus,
  logRefusal,
  rawPathRefusal,
  routeDecision,
  upstreamTarget,
  type RefusalCode,
} from "../../src/lib/upstream";

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

/** A refused request: one log line with the reason code only (no path, no header), then a fixed error body. */
function refuse(reason: RefusalCode, status: number, code: string, message: string): Response {
  logRefusal(reason);
  return err(status, code, message);
}

export default async (req: Request, _context: Context): Promise<Response> => {
  // --- Refuse an unsafe raw path before anything else (src/lib/upstream.ts). Decided on the raw req.url string,
  // never on the parsed pathname, because parsing resolves encoded dot segments and turns "\" into "/". ---
  const refusal = rawPathRefusal(req.url);
  if (refusal) {
    return refuse(refusal, 400, "bad_path", "The request path is not accepted (" + refusal + ").");
  }
  const url = new URL(req.url);
  if (!url.pathname.startsWith(GATEWAY_PREFIX + "/")) {
    return refuse("outside_prefix", 400, "bad_path", "The request path is not accepted (outside " + GATEWAY_PREFIX + "/).");
  }

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
  const estate = await getEstate(user.id);
  const route = resolveRoute(user, estate);
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
    // A dedicated estate is reached only when its app name is the one derived from this user's id (the function
    // provisioning uses) and its stored url is the origin derived from that app name; a record with either altered
    // (corrupted or tampered) sends nothing.
    if (!estate || estate.app !== newAppName(user.id) || route.url !== estateOrigin(estate.app)) {
      return refuse("estate_url_mismatch", 502, "estate_misconfigured", "Your dedicated estate's address could not be verified; nothing was sent. Contact Spin State Labs.");
    }
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

  // --- Route allowlist (src/lib/upstream.ts ALLOWED_ROUTES): only the routes the console documents to customers are
  // forwarded, and the cross-tenant ones only to a dedicated estate. Checked before the target is built and before the
  // perimeter secret is attached; a refusal sends nothing upstream. ---
  const decision = routeDecision(req.method, url.pathname.slice(GATEWAY_PREFIX.length), route.kind);
  if (!decision.ok) {
    return refuse(decision.reason, decision.status, decision.code, decision.message);
  }

  // --- Proxy. Strip the /api/v1 prefix; keep the query string. The target is built with the URL constructor against
  // the estate base and must keep the base's origin and stay under its path; otherwise nothing is sent. The
  // perimeter secret and the tenant header are attached only below, after this check has passed. ---
  const targetUrl = upstreamTarget(url.pathname, url.search, estateUrl);
  if (!targetUrl) {
    return refuse("target_outside_base", 400, "bad_path", "The request path is not accepted (it does not resolve inside the estate).");
  }
  const target = targetUrl.toString();

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  // Only the caller headers the estate gateway needs pass through (FORWARDED_CALLER_HEADERS, src/lib/upstream.ts:
  // agent id, token, action, preset; an enforcing estate gateway refuses /v1/messages without the first two). Every
  // other x-field-* / x-force-* header from the caller (operator, on-behalf-of, internal, kill-origin, passthrough, ...)
  // is dropped: the request below carries the console's own perimeter secret, and an estate rule of the form "honoured
  // when the secret is presented" must not be satisfied on a caller's behalf. The perimeter secret (x-field-auth) and
  // the tenant header are always the portal's own values, never the caller's.
  for (const n of FORWARDED_CALLER_HEADERS) {
    const value = req.headers.get(n);
    if (value !== null) headers.set(n, value);
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
      // redirect: "manual": a redirect from the estate is never followed (a followed cross-origin redirect would carry
      // the perimeter secret, the tenant header, the caller's token and, on 307/308, the body to another host).
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        return err(504, "upstream_timeout", "The engine estate did not respond within 30 seconds.");
      }
      return err(502, "upstream_unreachable", "Could not reach the engine estate.");
    }
    // Any 3xx from the estate (or an opaque redirect, status 0) becomes a fixed 502: no Location, no upstream body.
    if (isRedirectStatus(upstream.status) || upstream.type === "opaqueredirect") {
      await upstream.body?.cancel().catch(() => undefined);
      return refuse("upstream_redirect", 502, "upstream_redirect", "The engine estate answered with a redirect; it was not followed.");
    }

    // Buffer and return the upstream status, body, and content-type verbatim.
    // No streaming in v0.
    const upstreamBody = await upstream.arrayBuffer();
    const responseHeaders: Record<string, string> = {};
    const upstreamContentType = upstream.headers.get("content-type");
    if (upstreamContentType) responseHeaders["content-type"] = upstreamContentType;
    return new Response(upstreamBody, { status: upstream.status, headers: responseHeaders });
  };

  // --- Agent pool (price book): gate what can add an agent on a dedicated estate. It runs only after the route
  // allowlist has accepted the request and the target has been derived above, so it only ever sees an allowed method
  // and path. A path that cannot be decoded is refused rather than guessed at. ---
  const canon = canonicalPath(url.pathname.slice(GATEWAY_PREFIX.length));
  if (canon === null) {
    return err(400, "bad_path", "The request path could not be decoded.");
  }
  const pool = route.kind === "estate" ? poolFor(user) : null;
  const gate = pool === null ? null : classify(method, canon, body);
  if (pool === null || gate === null) return forward();

  // The gate's own reads go to the same estate, built the same way as the forwarded target (URL constructor against
  // the estate base, origin and path checked), never by string concatenation, and never follow a redirect.
  const readUpstream = async (path: string): Promise<unknown> => {
    const readUrl = upstreamTarget(GATEWAY_PREFIX + path, "", estateUrl!);
    if (!readUrl) throw new UpstreamReadError(0);
    const h = new Headers();
    h.set("accept", "application/json");
    if (sharedSecret) h.set("x-field-auth", sharedSecret);
    h.set("x-ff-tenant", user.id);
    const r = await fetch(readUrl.toString(), { method: "GET", headers: h, redirect: "manual", signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new UpstreamReadError(r.status);
    return r.json();
  };

  try {
    return await withAgentPoolLock(user.id, async () => {
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
              message: `Your plan allows ${pool} governed agents and ${inUse} are in use. Add seats or a top-up pack, or contact Spin State Labs to retire an agent.`,
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
