// upstream.ts: how the gateway derives the estate URL it forwards to.
//
// Rules:
//  1. `rawPathRefusal` checks the RAW request target (the string in req.url, before any parsing) and refuses dot
//     segments in any encoding, backslashes, encoded slashes or backslashes, '@', control characters and NUL;
//  2. `upstreamTarget` requires the parsed pathname to start with the gateway prefix, builds the target with the URL
//     constructor against the estate base, and returns null unless the result keeps the base's origin, carries no
//     userinfo, and stays under the base's path. The host of an outbound request therefore always comes from the
//     estate base, never from the request.
// Pure functions: no I/O, so the gateway and the tests share them.

export const GATEWAY_PREFIX = "/api/v1";

/** The raw path of a request URL string (everything between the authority and '?' or '#'), unparsed. */
export function rawPathOf(rawUrl: string): string {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\\]*([^?#]*)/.exec(rawUrl);
  return m ? m[1] : rawUrl.split(/[?#]/, 1)[0];
}

/**
 * Why the raw request path is refused, or null when it is acceptable. Decided on the raw string, never on a parsed
 * pathname, because URL parsing resolves encoded dot segments and turns `\` into `/`.
 */
export function rawPathRefusal(rawUrl: string): string | null {
  const path = rawPathOf(rawUrl);
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control character";
  if (/%(?:[01][0-9a-f]|7f)/i.test(path)) return "encoded control character";
  if (path.includes("\\")) return "backslash";
  if (/%5c/i.test(path)) return "encoded backslash";
  if (/%2f/i.test(path)) return "encoded slash";
  if (path.includes("@") || /%40/i.test(path)) return "'@'";
  if (/%2e/i.test(path)) return "encoded dot";
  for (const seg of path.split("/")) {
    if (seg === "." || seg === "..") return "dot segment";
  }
  return null;
}

/**
 * The upstream URL for a gateway request, or null when it cannot be derived safely.
 * `pathname` and `search` are the parsed request's; `base` is the estate base URL (stored or configured).
 * The result always has the base's origin and a path under the base's path.
 */
export function upstreamTarget(pathname: string, search: string, base: string): URL | null {
  if (!pathname.startsWith(GATEWAY_PREFIX + "/")) return null;
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return null;
  }
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") return null;
  if (baseUrl.username || baseUrl.password) return null;
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

