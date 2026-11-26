// Rules: redirects from the estate are never followed or relayed; an estate base must be https (http only for a
// loopback host); a dedicated estate is reached only at the origin derived from its app name; each refusal logs its
// reason code and nothing else.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import handler from "../netlify/functions/gateway.mts";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { issueKey } from "../src/lib/keys";
import { queueEstate, saveEstate } from "../src/lib/estates";
import { estateOrigin } from "../src/lib/fly";
import { estateBase, isLoopbackHost, isRedirectStatus, rawPathRefusal, upstreamTarget } from "../src/lib/upstream";

const ctx = {} as any;
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };
const SITE = "https://force-field-console.netlify.app";

function rawReq(rawUrl: string, headers: Record<string, string>, method = "GET"): Request {
  return { url: rawUrl, method, headers: new Headers(headers), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Request;
}

describe("estate base: https, or http on a loopback host only", () => {
  it.each(["http://sandbox.example", "http://estate.test", "http://10.0.0.5:8080", "http://169.254.169.254", "ftp://sandbox.example", "https://user:pw@sandbox.example", "https://user@sandbox.example", "not a url"])(
    "refuses %s",
    (b) => {
      expect(estateBase(b)).toBeNull();
      expect(upstreamTarget("/api/v1/registry/health", "", b)).toBeNull();
    },
  );

  it.each(["https://sandbox.example", "https://sandbox.example/engine", "http://localhost:8080", "http://estate.localhost", "http://127.0.0.1:9000", "http://127.10.20.30", "http://[::1]:8443"])(
    "accepts %s",
    (b) => {
      expect(estateBase(b)).not.toBeNull();
      expect(upstreamTarget("/api/v1/registry/health", "", b)).not.toBeNull();
    },
  );

  it("knows its loopback hosts", () => {
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("localhost.example")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.example")).toBe(false);
    expect(isLoopbackHost("[::2]")).toBe(false);
  });
});

describe("upstreamTarget: the named edge cases", () => {
  it("refuses userinfo that keeps the same origin (origin comparison alone would pass it)", () => {
    // "//user:pw@sandbox.example/x" resolves to the same origin as the base, with userinfo set.
    const t = new URL("//user:pw@sandbox.example/x", "https://sandbox.example");
    expect(t.origin).toBe("https://sandbox.example");
    expect(t.username).toBe("user");
    expect(upstreamTarget("/api/v1//user:pw@sandbox.example/x", "", "https://sandbox.example")).toBeNull();
    expect(upstreamTarget("/api/v1//user@sandbox.example/x", "", "https://sandbox.example")).toBeNull();
  });

  it("refuses a sibling of the base path (the base path must be followed by '/')", () => {
    expect(upstreamTarget("/api/v1/../engine-other/x", "", "https://sandbox.example/engine")).toBeNull();
    expect(upstreamTarget("/api/v1/../engine/x", "", "https://sandbox.example/engine")!.toString()).toBe("https://sandbox.example/engine/x");
    expect(upstreamTarget("/api/v1/x", "", "https://sandbox.example/engine")!.pathname).toBe("/engine/x");
  });
});

describe("rawPathRefusal: upper-case hex is refused like lower-case", () => {
  it.each([
    ["/api/v1/a%0Ab", "encoded_control_character"],
    ["/api/v1/a%0D%0Ab", "encoded_control_character"],
    ["/api/v1/a%1Fb", "encoded_control_character"],
    ["/api/v1/a%7Fb", "encoded_control_character"],
    ["/api/v1/a%2Fb", "encoded_slash"],
    ["/api/v1/a%5Cb", "encoded_backslash"],
    ["/api/v1/a%2Eb", "encoded_dot"],
    ["/api/v1/a%2eb", "encoded_dot"],
  ])("%s -> %s", (p, code) => {
    expect(rawPathRefusal(SITE + p)).toBe(code);
  });
});

describe("gateway handler: hardening", () => {
  let user: User;
  let key: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    process.env.ESTATE_URL = "https://sandbox.example";
    process.env.ESTATE_SHARED_SECRET = "sandbox-secret";
    user = await createUser("hardening@example.com", "sufficiently-long-pass");
    key = (await issueKey(user, "t")).plaintext;
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warn.mockRestore();
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
    delete process.env.ESTATE_URL;
    delete process.env.ESTATE_SHARED_SECRET;
  });

  it("sends with redirect: manual", async () => {
    const res = await handler(new Request(SITE + "/api/v1/registry/agents", { headers: { "x-api-key": key } }), ctx);
    expect(res.status).toBe(200);
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.redirect).toBe("manual");
  });

  it.each([301, 302, 303, 307, 308, 300, 399])("maps an upstream %i to a fixed 502 with no Location and no upstream body", async (status) => {
    fetchMock.mockImplementation(async () => new Response("upstream body", { status, headers: { location: "https://other.example/x", "content-type": "text/plain" } }));
    const res = await handler(new Request(SITE + "/api/v1/registry/agents", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: "{}" }), ctx);
    expect(res.status).toBe(502);
    expect(res.headers.get("location")).toBeNull();
    const body = await res.json();
    expect(body).toEqual({ error: { code: "upstream_redirect", message: "The engine estate answered with a redirect; it was not followed." } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ gateway_refusal: "upstream_redirect" }));
  });

  it("maps an opaque redirect response to the same 502", async () => {
    const opaque = { status: 0, type: "opaqueredirect", headers: new Headers(), body: null, arrayBuffer: async () => new ArrayBuffer(0) };
    fetchMock.mockImplementation(async () => opaque as unknown as Response);
    const res = await handler(new Request(SITE + "/api/v1/registry/agents", { headers: { "x-api-key": key } }), ctx);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("upstream_redirect");
  });

  it("refuses an http sandbox base that is not loopback, before sending", async () => {
    process.env.ESTATE_URL = "http://sandbox.example";
    const res = await handler(new Request(SITE + "/api/v1/registry/agents", { headers: { "x-api-key": key } }), ctx);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ gateway_refusal: "target_outside_base" }));
  });

  it("dedicated route: a stored url that is not estateOrigin(app) sends nothing", async () => {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    for (const bad of ["https://other.example", `https://${e.app}.fly.dev.other.example`, `https://${e.app}.fly.dev/`, `http://${e.app}.fly.dev`, `https://${e.app}.fly.dev:8443`]) {
      e.url = bad;
      await saveEstate(e);
      const res = await handler(new Request(SITE + "/api/v1/sentinel/check", { headers: { "x-api-key": key } }), ctx);
      expect(res.status, bad).toBe(502);
      expect((await res.json()).error.code).toBe("estate_misconfigured");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ gateway_refusal: "estate_url_mismatch" }));
    e.url = estateOrigin(e.app);
    await saveEstate(e);
    const ok = await handler(new Request(SITE + "/api/v1/sentinel/check", { headers: { "x-api-key": key } }), ctx);
    expect(ok.status).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`https://${e.app}.fly.dev/sentinel/check`);
  });

  it("order: the prefix check runs before authentication (no key needed to refuse, nothing sent, reason logged)", async () => {
    const res = await handler(rawReq(SITE + "/api/v2/registry/agents", {}), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_path");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ gateway_refusal: "outside_prefix" }));
  });

  it("order: a raw-path refusal answers before the prefix check and before authentication", async () => {
    const res = await handler(rawReq(SITE + "/api/v2/%2e%2e/x", {}), ctx);
    expect(res.status).toBe(400);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ gateway_refusal: "encoded_dot" }));
  });

  it("logs the reason code only: never the path, a header, the key or the secret", async () => {
    const secretish = "x-field-agent-id-value-should-not-appear";
    await handler(rawReq(SITE + "/api/v1/registry/agents%2Fz", { "x-api-key": key, "x-field-agent-id": secretish }), ctx);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toBe(JSON.stringify({ gateway_refusal: "encoded_slash" }));
    for (const s of ["registry", "agents", "%2F", key, secretish, "sandbox-secret"]) expect(line).not.toContain(s);
  });

  it("a normal request logs nothing", async () => {
    const res = await handler(new Request(SITE + "/api/v1/registry/agents?limit=5", { headers: { "x-api-key": key } }), ctx);
    expect(res.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
    expect(isRedirectStatus(200)).toBe(false);
  });
});
