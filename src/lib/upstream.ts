// upstream.ts: how the gateway derives the estate URL it forwards to.
//
// Rules enforced here (pure functions, shared with the tests):
//  1. `rawPathRefusal` checks the RAW request target (the string in req.url, before any parsing) and refuses dot
//     segments in any encoding, backslashes, encoded slashes or backslashes, '@', control characters and NUL.
//  2. `estateBase` accepts an estate base only when it is an https URL without userinfo; http is accepted only for a
//     loopback host (localhost, *.localhost, 127.0.0.0/8, [::1]).
//  3. `upstreamTarget` requires the parsed pathname to start with the gateway prefix, builds the target with the URL
//     constructor against the estate base, and returns null unless the target has the base's origin, carries no
//     userinfo, and its path is the base path followed by "/" (so a sibling such as /engine-x never matches /engine).
// What this module does NOT do: follow or refuse redirects. The gateway sends with `redirect: "manual"` and maps any
// upstream 3xx to 502 (netlify/functions/gateway.mts), so the request is only ever sent to the target built here.

export const GATEWAY_PREFIX = "/api/v1";

/** The raw path of a request URL string (everything between the authority and '?' or '#'), unparsed. */
export function rawPathOf(rawUrl: string): string {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\\]*([^?#]*)/.exec(rawUrl);
  return m ? m[1] : rawUrl.split(/[?#]/, 1)[0];
}

/** Reason codes a refusal is logged under (no path, no header value is ever logged). */
export type RefusalCode =
  | "control_character"
  | "encoded_control_character"
  | "backslash"
  | "encoded_backslash"
  | "encoded_slash"
  | "at_sign"
  | "encoded_dot"
  | "dot_segment"
  | "outside_prefix"
  | "bad_estate_base"
  | "estate_url_mismatch"
  | "target_outside_base"
  | "upstream_redirect"
  | "path_not_allowed"
  | "method_not_allowed"
  | "not_on_sandbox";

/** Which estate a request is routed to: the customer's own dedicated estate, or the shared sandbox. */
export type RouteKind = "estate" | "sandbox";

/** A route the console forwards: method, a fully anchored pattern for the path after /api/v1, where it is promised. */
export type AllowedRoute = {
  method: "GET" | "POST";
  pattern: RegExp;
  /** Allowed on the shared sandbox too. False for a route that reads or writes across tenants on a shared estate. */
  sandbox: boolean;
  docs: string;
};

/** A delegation token id as the platform mints it: str(uuid.uuid4()) (field-platform field_core/delegation.py:33). */
const TOKEN_ID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
/** A FORCE preset name (force_gateway/presets.py:23: analysis, brainstorm, draft, audit). */
const PRESET_NAME = "[a-z][a-z0-9_-]{0,31}";

/**
 * The only routes the gateway forwards, each from the console's own customer documentation. Anything else answers
 * 404 before the perimeter secret is attached: the ops console's root API, kill-switch, governor, federation, replay,
 * crosswalk, the ledger's write and admin routes, the registry's PATCH/attest/discover, every /health but the
 * ledger's, and every operator route.
 */
export const ALLOWED_ROUTES: readonly AllowedRoute[] = [
  { method: "POST", pattern: /^\/registry\/agents$/, sandbox: false, docs: "docs/estate-quickstart.md:37; public/setup-steps.js:148" },
  { method: "GET", pattern: /^\/registry\/agents$/, sandbox: false, docs: "docs/estate-quickstart.md:108; public/setup-steps.js:300" },
  { method: "POST", pattern: /^\/delegation\/tokens$/, sandbox: false, docs: "docs/estate-quickstart.md:51; public/setup-steps.js:176" },
  { method: "POST", pattern: new RegExp("^/delegation/tokens/" + TOKEN_ID + "/revoke$"), sandbox: false, docs: "docs/estate-quickstart.md:59; public/setup-steps.js:171,181,184" },
  { method: "POST", pattern: /^\/sentinel\/check$/, sandbox: true, docs: "docs/estate-quickstart.md:64; public/setup-steps.js:207; public/app.js:743; public/index.html:80" },
  { method: "POST", pattern: /^\/gateway\/v1\/messages$/, sandbox: true, docs: "docs/estate-quickstart.md:78; public/setup-steps.js:236" },
  { method: "GET", pattern: /^\/gateway\/presets$/, sandbox: true, docs: "docs/estate-quickstart.md:84 (x-force-preset selects a FORCE preset)" },
  { method: "GET", pattern: new RegExp("^/gateway/presets/" + PRESET_NAME + "$"), sandbox: true, docs: "docs/estate-quickstart.md:84" },
  { method: "GET", pattern: /^\/attest\/pack$/, sandbox: false, docs: "docs/estate-quickstart.md:90; public/setup-steps.js:264-265" },
  { method: "GET", pattern: /^\/attest\/pack\.html$/, sandbox: false, docs: "docs/estate-quickstart.md:91; public/setup-steps.js:264-265" },
  { method: "GET", pattern: /^\/ledger\/health$/, sandbox: true, docs: "docs/estate-quickstart.md:107; public/setup-steps.js:300" },
  { method: "GET", pattern: /^\/lifecycle\/findings$/, sandbox: false, docs: "docs/estate-quickstart.md:109; public/setup-steps.js:300" },
];

export type RouteDecision = { ok: true } | { ok: false; reason: RefusalCode; status: number; code: string; message: string };

/**
 * Whether the gateway forwards `method` + `subPath` (the parsed path after /api/v1, query excluded) for a request
 * routed to `kind`. A path no route matches is 404; a matched path with another method is 405; a route that is
 * dedicated-only, asked on the shared sandbox, is 403.
 */
export function routeDecision(method: string, subPath: string, kind: RouteKind): RouteDecision {
  const m = method.toUpperCase();
  const matches = ALLOWED_ROUTES.filter((r) => r.pattern.test(subPath));
  if (matches.length === 0) {
    return { ok: false, reason: "path_not_allowed", status: 404, code: "not_found", message: "No such route on the console gateway." };
  }
  const route = matches.find((r) => r.method === m);
  if (!route) {
    return { ok: false, reason: "method_not_allowed", status: 405, code: "method_not_allowed", message: "That method is not accepted on this route." };
  }
  if (kind === "sandbox" && !route.sandbox) {
    return { ok: false, reason: "not_on_sandbox", status: 403, code: "not_on_sandbox", message: "This route needs a dedicated estate; it is not available on the shared sandbox." };
  }
  return { ok: true };
}

/**
 * The reason the raw request path is refused, or null when it is acceptable. Decided on the raw string, never on a
 * parsed pathname, because URL parsing resolves encoded dot segments and turns `\` into `/`. Hex digits in percent
 * escapes are matched in either case.
 */
export function rawPathRefusal(rawUrl: string): RefusalCode | null {
  const path = rawPathOf(rawUrl);
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control_character";
  if (/%(?:[01][0-9a-f]|7f)/i.test(path)) return "encoded_control_character";
  if (path.includes("\\")) return "backslash";
  if (/%5c/i.test(path)) return "encoded_backslash";
  if (/%2f/i.test(path)) return "encoded_slash";
  if (path.includes("@") || /%40/i.test(path)) return "at_sign";
  if (/%2e/i.test(path)) return "encoded_dot";
  for (const seg of path.split("/")) {
    if (seg === "." || seg === "..") return "dot_segment";
  }
  return null;
}

/** True for a loopback host name as the URL parser reports it (`hostname`; IPv6 keeps its brackets). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** The parsed estate base, or null when it is not an acceptable base (see rule 2). */
export function estateBase(base: string): URL | null {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && isLoopbackHost(u.hostname)) return u;
  return null;
}

/**
 * The upstream URL for a gateway request, or null when it cannot be derived safely.
 * `pathname` and `search` are the parsed request's; `base` is the estate base URL (stored or configured).
 * The result always has the base's origin, no userinfo, and a path equal to the base path plus "/...".
 */
export function upstreamTarget(pathname: string, search: string, base: string): URL | null {
  if (!pathname.startsWith(GATEWAY_PREFIX + "/")) return null;
  const baseUrl = estateBase(base);
  if (!baseUrl) return null;
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const rest = pathname.slice(GATEWAY_PREFIX.length); // begins with "/"
  let target: URL;
  try {
    target = new URL(basePath + rest + search, baseUrl.origin);
  } catch {
    return null;
  }
  if (target.origin !== baseUrl.origin) return null;
  if (target.username || target.password) return null;
  if (!target.pathname.startsWith(basePath + "/")) return null;
  return target;
}

/** True for an HTTP status the gateway must never relay as a redirect. */
export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/** One log line per refusal: the reason code only, never the path, a header or a key. */
export function logRefusal(code: RefusalCode): void {
  console.warn(JSON.stringify({ gateway_refusal: code }));
}

/**
 * Caller headers the gateway forwards to the estate; every other x-field-* / x-force-* header is dropped.
 * Reviewed against every estate service the gateway can reach at field-platform 6c1f9aa6 (request headers read in
 * services and packages/field-core sources): the only customer-facing reads of caller headers are force-gateway's
 * (services/force-gateway/src/force_gateway/api.py):
 *  - x-force-preset:   :1116 (Header, default "analysis"): the FORCE prompt-hygiene preset;
 *  - x-field-agent-id: :1117, checked :1127, required under enforce :1136;
 *  - x-field-token:    :1121, checked :1127, required under enforce :1136;
 *  - x-field-action:   :1122, checked :1130-1131, used :1143.
 * Read elsewhere but deliberately not forwarded from a customer: x-field-operator / x-field-operator-key
 * (field_core/operator_auth.py:1400; an operator identity, which customers do not hold), x-field-operator-on-behalf-of
 * (agent_registry/api.py:60; honoured only for an operator with bypass_operator_list), x-field-internal
 * (field_core/operator_health.py:821,832; internal routes), x-field-kill-origin (kill_switch/api.py:91,866,874,1207;
 * an audit label a caller must not set), x-force-passthrough and x-field-auth (force_gateway/api.py:1119-1120; the
 * console sets x-field-auth itself). force-gateway also reads anthropic-version (:1118, default "2023-06-01"); the
 * console never forwarded it and the default is the current version, so it is left out of this change.
 */
export const FORWARDED_CALLER_HEADERS: readonly string[] = ["x-field-agent-id", "x-field-token", "x-field-action", "x-force-preset"];
