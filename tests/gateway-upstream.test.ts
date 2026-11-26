// Rule: the gateway's outbound host and path always come from the estate base; refused requests send nothing.
// Raw request targets are fed as plain objects because `new Request()` would parse and normalise the URL first,
// which would change the forms the gateway must refuse.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import handler from "../netlify/functions/gateway.mts";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { issueKey } from "../src/lib/keys";
import { estateSecret, queueEstate, saveEstate } from "../src/lib/estates";
import { rawPathOf, rawPathRefusal, upstreamTarget } from "../src/lib/upstream";

const ctx = {} as any;
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

/** A request whose url is the raw string given (not parsed or normalised by the Request constructor). */
function rawReq(rawUrl: string, headers: Record<string, string>, method = "GET"): Request {
  return { url: rawUrl, method, headers: new Headers(headers), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Request;
}

const REFUSED_PATHS = [
  "/api/v1/%2e%2e/xx@other.example/p",
  "/api/v1/%2E%2E/xx.other.example/p",
  "/api/v1/.%2e/xx.other.example/p",
  "/api/v1/%2e./xx.other.example/p",
  "/api/v1/x/%2e%2e/%2e%2e/yy:9/p",
  "/api/v1/../xx@other.example/p",
  "/api/v1/registry/./agents",
  "/api/v1/registry/agents/..",
  "/api/v1/%2e/registry/agents",
  "/api/v1\\..\\other.example/p",
  "/api/v1/registry\\agents",
  "/api/v1/registry%5cagents",
  "/api/v1/registry%5Cagents",
  "/api/v1/registry%2fagents",
  "/api/v1/registry%2Fagents",
  "/api/v1/x@other.example",
  "/api/v1/x%40other.example",
  "/api/v1/registry/agents%00",
  "/api/v1/registry/agents%0d%0aX-Injected: 1",
  "/api/v1/registry/agents%1f",
  "/api/v1/registry/agents%7f",
  "/api/v1/registry/agents\u0000",
  "/api/v1/registry/agents\u0007",
];

describe("rawPathRefusal (decided on the raw request target)", () => {
  it.each(REFUSED_PATHS)("refuses %s", (p) => {
    expect(rawPathRefusal("https://portal.test" + p)).not.toBeNull();
  });

  it.each([
    "/api/v1/sentinel/check",
    "/api/v1/registry/agents",
    "/api/v1/registry/agents/invoice-bot.v2_a-1",
    "/api/v1/attest/pack.html",
    "/api/v1/delegation/tokens/123e4567-e89b-12d3-a456-426614174000/revoke",
  ])("accepts %s", (p) => {
    expect(rawPathRefusal("https://portal.test" + p)).toBeNull();
  });

  it("looks only at the path: '@', '%2e' and '..' in the query string are allowed", () => {
    expect(rawPathRefusal("https://portal.test/api/v1/registry/agents?owner=a@b.example&x=%2e%2e&y=..")).toBeNull();
    expect(rawPathOf("https://portal.test/api/v1/a?b=@#c")).toBe("/api/v1/a");
  });
});

describe("upstreamTarget (host and path always the estate's)", () => {
  const base = "https://ff-est-abc123.fly.dev";

  it("keeps normal paths and query strings unchanged", () => {
    expect(upstreamTarget("/api/v1/sentinel/check", "?x=1&y=two", base)!.toString()).toBe("https://ff-est-abc123.fly.dev/sentinel/check?x=1&y=two");
    expect(upstreamTarget("/api/v1/registry/agents", "", base + "/")!.toString()).toBe("https://ff-est-abc123.fly.dev/registry/agents");
    expect(upstreamTarget("/api/v1/attest/pack", "?period=2026-Q3", base)!.toString()).toBe("https://ff-est-abc123.fly.dev/attest/pack?period=2026-Q3");
  });

  it("keeps a base path as the prefix", () => {
    expect(upstreamTarget("/api/v1/registry/health", "", "https://sandbox.example/engine")!.toString()).toBe("https://sandbox.example/engine/registry/health");
    expect(upstreamTarget("/api/v1/registry/health", "", "https://sandbox.example/engine/")!.toString()).toBe("https://sandbox.example/engine/registry/health");
  });

  it("refuses a path outside the gateway prefix", () => {
    expect(upstreamTarget("/api/xx@other.example/p", "", base)).toBeNull();
    expect(upstreamTarget("/api/v1", "", base)).toBeNull();
    expect(upstreamTarget("/api/v1x/registry", "", base)).toBeNull();
  });

  it("keeps the result on the base origin and under the base path, for normalised inputs too", () => {
    expect(upstreamTarget("/api/v1//other.example/x", "", base)).toBeNull(); // protocol-relative
    const underPath = upstreamTarget("/api/v1//other.example/x", "", "https://sandbox.example/engine");
    expect(underPath === null || underPath.origin === "https://sandbox.example").toBe(true);
    expect(upstreamTarget("/api/v1/../../x", "", "https://sandbox.example/engine/deep")).toBeNull();
    for (const p of ["/api/v1/x", "/api/v1/a/b/c", "/api/v1/x:9/p", "/api/v1/x@y/p"]) {
      const t = upstreamTarget(p, "", base);
      expect(t === null || t.origin === base).toBe(true);
    }
  });

  it("refuses an unusable base", () => {
    expect(upstreamTarget("/api/v1/x", "", "not a url")).toBeNull();
    expect(upstreamTarget("/api/v1/x", "", "ftp://sandbox.example")).toBeNull();
    expect(upstreamTarget("/api/v1/x", "", "https://user:pw@sandbox.example")).toBeNull();
  });
});

describe("gateway handler: a refused request never reaches fetch", () => {
  let user: User;
  let key: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    process.env.ESTATE_URL = "https://sandbox.example";
    process.env.ESTATE_SHARED_SECRET = "sandbox-secret";
    user = await createUser("tenant@example.com", "sufficiently-long-pass");
    key = (await issueKey(user, "t")).plaintext;
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
    delete process.env.ESTATE_URL;
    delete process.env.ESTATE_SHARED_SECRET;
  });

  it.each(REFUSED_PATHS)("400 bad_path for raw %s, with a valid key, and no outbound request", async (p) => {
    const res = await handler(rawReq("https://force-field-console.netlify.app" + p, { "x-api-key": key }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_path");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses the normalised form too (as a parsing runtime would pass it on) without calling fetch", async () => {
    // new Request() resolves encoded dot segments before the handler sees the path
    const res = await handler(new Request("https://force-field-console.netlify.app/api/v1/%2e%2e/xx@other.example/p", { headers: { "x-api-key": key } }), ctx);
    expect(res.status).toBe(400);
    const res2 = await handler(new Request("https://force-field-console.netlify.app/api/v1/%2e%2e/xx.other.example/p", { headers: { "x-api-key": key } }), ctx);
    expect(res2.status).toBe(400);
    const res3 = await handler(rawReq("https://force-field-console.netlify.app/api/v1//other.example/x", { "x-api-key": key }), ctx);
    expect(res3.status).toBe(404); // "//other.example/x" is no documented route: refused by the allowlist
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses before authentication: no key lookup is needed to refuse, and nothing is sent", async () => {
    const res = await handler(rawReq("https://force-field-console.netlify.app/api/v1/%2e%2e/xx@other.example/p", {}), ctx);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still forwards a normal sandbox request, path and query unchanged, with the secret", async () => {
    const res = await handler(new Request("https://force-field-console.netlify.app/api/v1/ledger/health?status=active&owner=a@b.example", { headers: { "x-api-key": key } }), ctx);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sandbox.example/ledger/health?status=active&owner=a@b.example");
    expect(new Headers(init.headers).get("x-field-auth")).toBe("sandbox-secret");
  });

  it("still forwards to a ready dedicated estate's own origin", async () => {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.url = `https://${e.app}.fly.dev`;
    await saveEstate(e);
    const res = await handler(new Request("https://force-field-console.netlify.app/api/v1/sentinel/check?x=1", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: "{}" }), ctx);
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${e.app}.fly.dev/sentinel/check?x=1`);
    expect(new Headers(init.headers).get("x-field-auth")).toBe(estateSecret(e.app));
  });

  it("sends nothing when a stored estate url carries userinfo", async () => {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.url = "https://user:pw@other.example";
    await saveEstate(e);
    const res = await handler(new Request("https://force-field-console.netlify.app/api/v1/sentinel/check", { headers: { "x-api-key": key } }), ctx);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("estate_misconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("gateway handler: only the allowlisted caller headers are forwarded", () => {
  let key: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    freshStore();
    process.env.ESTATE_URL = "https://sandbox.example";
    process.env.ESTATE_SHARED_SECRET = "sandbox-secret";
    const user = await createUser("headers@example.com", "sufficiently-long-pass");
    key = (await issueKey(user, "t")).plaintext;
    fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ESTATE_URL;
    delete process.env.ESTATE_SHARED_SECRET;
  });

  const DROPPED = [
    "x-field-operator",
    "x-field-operator-key",
    "x-field-operator-on-behalf-of",
    "x-field-internal",
    "x-field-kill-origin",
    "x-field-kill-reason",
    "x-force-passthrough",
    "x-field-auth-extra",
    "x-field-anything-new",
    "x-force-anything-new",
  ];

  it("forwards the agent id, token, action and preset, and drops every other x-field-* / x-force-* header", async () => {
    const h: Record<string, string> = {
      "x-api-key": key,
      "content-type": "application/json",
      "x-field-agent-id": "invoice-bot",
      "x-field-token": "tok-123",
      "x-field-action": "draft invoice",
      "x-force-preset": "audit",
      "x-field-auth": "spoofed-secret",
      "x-ff-tenant": "spoofed-tenant",
    };
    for (const n of DROPPED) h[n] = n === "x-force-passthrough" ? "judge" : "v";
    const res = await handler(new Request("https://force-field-console.netlify.app/api/v1/sentinel/check", { method: "POST", headers: h, body: "{}" }), ctx);
    expect(res.status).toBe(200);
    const sent = new Headers((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers);
    expect(sent.get("x-field-agent-id")).toBe("invoice-bot");
    expect(sent.get("x-field-token")).toBe("tok-123");
    expect(sent.get("x-field-action")).toBe("draft invoice");
    expect(sent.get("x-force-preset")).toBe("audit");
    expect(sent.get("x-field-auth")).toBe("sandbox-secret");
    expect(sent.get("x-ff-tenant")).not.toBe("spoofed-tenant");
    for (const n of DROPPED) expect(sent.get(n), n).toBeNull();
    const names = [...sent.keys()].filter((n) => n.startsWith("x-field-") || n.startsWith("x-force-")).sort();
    expect(names).toEqual(["x-field-action", "x-field-agent-id", "x-field-auth", "x-field-token", "x-force-preset"]);
  });
});
