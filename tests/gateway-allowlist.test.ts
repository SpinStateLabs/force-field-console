// Rule: the gateway forwards only the routes the console documents to customers (src/lib/upstream.ts ALLOWED_ROUTES),
// with their documented method; routes that read or write across tenants only to a dedicated estate. Everything else
// is refused before the perimeter secret is attached, and nothing is sent upstream.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import handler from "../netlify/functions/gateway.mts";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { issueKey } from "../src/lib/keys";
import { queueEstate, saveEstate } from "../src/lib/estates";
import { estateOrigin } from "../src/lib/fly";
import { ALLOWED_ROUTES, routeDecision } from "../src/lib/upstream";

const ctx = {} as any;
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };
const SITE = "https://force-field-console.netlify.app";
const TOKEN = "123e4567-e89b-42d3-a456-426614174000";

// [method, path after /api/v1 (query allowed), allowed on the shared sandbox]
const DOCUMENTED: [string, string, boolean][] = [
  ["POST", "/registry/agents", false],
  ["GET", "/registry/agents", false],
  ["POST", "/delegation/tokens", false],
  ["POST", "/sentinel/check", true],
  ["POST", "/gateway/v1/messages", false], // spends on the estate's model key: dedicated only
  ["GET", "/gateway/presets", true],
  ["GET", "/gateway/presets/audit", true],
  ["GET", "/attest/pack?period=2026-Q3", false],
  ["GET", "/attest/pack.html?period=2026-Q3", false],
  ["GET", "/ledger/health", true],
  ["GET", "/lifecycle/findings", false],
];

// Families that must never be reachable through the console, on any estate.
const EXCLUDED: [string, string][] = [
  // ops-console root API and page
  ["GET", "/"],
  ["POST", "/api/agents/invoice-bot/kill"],
  ["POST", "/api/agents/invoice-bot/revive"],
  ["POST", "/api/agents/invoice-bot/drill"],
  ["POST", "/api/agents/bulk"],
  ["POST", "/api/fleet/halt"],
  ["POST", `/api/tokens/${TOKEN}/revoke`],
  ["POST", "/api/escalations/e1/resolve"],
  ["POST", "/api/check"],
  ["GET", "/api/agents"],
  // kill-switch
  ["POST", "/killswitch/kill/invoice-bot"],
  ["POST", "/killswitch/kill/domain/finance"],
  ["POST", "/killswitch/revive/invoice-bot"],
  ["GET", "/killswitch/status/invoice-bot"],
  // governor (writes and reads)
  ["PUT", "/governor/policies/invoice-bot"],
  ["POST", "/governor/policies/invoice-bot"],
  ["PUT", "/governor/caps/invoice-bot"],
  ["POST", "/governor/usage/invoice-bot"],
  ["GET", "/governor/totals/invoice-bot"],
  // federation, replay, crosswalk
  ["POST", "/federation/contracts"],
  ["GET", "/federation/contracts/c1"],
  ["POST", "/replay/run"],
  ["GET", "/crosswalk/report"],
  // ledger writes and admin
  ["POST", "/ledger/events"],
  ["GET", "/ledger/events"],
  ["GET", "/ledger/verify"],
  ["POST", "/ledger/rotate"],
  ["POST", "/ledger/hold"],
  ["POST", "/ledger/hold/release"],
  ["POST", "/ledger/export"],
  ["POST", "/ledger/retention/apply"],
  // registry beyond register/list
  ["PATCH", "/registry/agents/invoice-bot"],
  ["GET", "/registry/agents/invoice-bot"],
  ["POST", "/registry/agents/invoice-bot/attest"],
  ["POST", "/registry/discover"],
  // delegation beyond mint (revoke is an operator action, not a customer route: decision line 34 A)
  ["POST", `/delegation/tokens/${TOKEN}/revoke`],
  ["GET", `/delegation/tokens/${TOKEN}`],
  ["GET", `/delegation/tokens/${TOKEN}/revoke`],
  ["POST", "/delegation/introspect"],
  ["POST", "/delegation/oauth/introspect"],
  // lifecycle, sentinel, gateway extras
  ["POST", "/lifecycle/sweep"],
  ["GET", "/sentinel/clauses"],
  ["GET", "/gateway/telemetry"],
  // health and operator routes
  ["GET", "/health"],
  ["GET", "/registry/health"],
  ["GET", "/sentinel/health"],
  ["GET", "/registry/operator/verify-hash"],
  ["GET", "/registry/operator/rotation-state"],
  // near misses of allowed routes
  ["GET", "/registry/agents/"],
  ["GET", "/Registry/agents"],
  ["POST", "/sentinel/check/"],
  ["POST", "/gateway/v1/messages/x"],
  ["GET", "/attest/pack.json"],
  ["GET", "/ledger/health/x"],
  // path parameters outside the platform's id rules
  ["POST", "/delegation/tokens/not-a-uuid/revoke"],
  ["POST", `/delegation/tokens/${TOKEN.toUpperCase()}/revoke`],
  ["POST", "/delegation/tokens/123e4567-e89b-12d3-a456-426614174000/revoke"], // version 1, not a minted v4 id
  ["POST", `/delegation/tokens/${TOKEN}x/revoke`],
  ["GET", "/gateway/presets/AUDIT"],
  ["GET", "/gateway/presets/" + "a".repeat(33)],
];

const WRONG_METHOD: [string, string][] = [
  ["GET", "/sentinel/check"],
  ["PUT", "/registry/agents"],
  ["DELETE", "/registry/agents"],
  ["PATCH", "/delegation/tokens"],
  ["GET", "/delegation/tokens"], // the token list is not forwarded: the path exists only for POST (mint)
  ["GET", "/gateway/v1/messages"],
  ["POST", "/ledger/health"],
  ["HEAD", "/ledger/health"],
  ["OPTIONS", "/attest/pack"],
  ["POST", "/lifecycle/findings"],
];

function req(method: string, path: string, key: string): Request {
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(SITE + "/api/v1" + path, {
    method,
    headers: { "x-api-key": key, ...(hasBody ? { "content-type": "application/json" } : {}) },
    body: hasBody ? "{}" : undefined,
  });
}

describe("ALLOWED_ROUTES: every entry cites the console document that promises it", () => {
  it("each cited file:line exists", () => {
    for (const r of ALLOWED_ROUTES) {
      for (const ref of r.docs.split(";").map((s) => s.trim())) {
        const m = /^([\w./-]+):(\d+)/.exec(ref);
        expect(m, r.docs).not.toBeNull();
        const lines = readFileSync(join(__dirname, "..", m![1]), "utf-8").split("\n");
        expect(Number(m![2]) <= lines.length, ref).toBe(true);
      }
    }
  });

  it("the first cited line names the route's path (or, for presets, the preset header)", () => {
    for (const r of ALLOWED_ROUTES) {
      const m = /^([\w./-]+):(\d+)/.exec(r.docs)!;
      const line = readFileSync(join(__dirname, "..", m[1]), "utf-8").split("\n")[Number(m[2]) - 1];
      const stem = r.pattern.source.replace(/^\^/, "").replace(/\\\//g, "/").replace(/\\\./g, ".").split(/[[(]/)[0].replace(/\$$/, "").replace(/\/$/, "");
      const expected = stem.startsWith("/gateway/presets") ? "x-force-preset" : stem;
      expect(line, r.docs).toContain(expected);
    }
  });
});

describe("routeDecision (pure)", () => {
  it.each(DOCUMENTED)("%s %s is allowed on a dedicated estate", (method, path) => {
    expect(routeDecision(method, path.split("?")[0], "estate")).toEqual({ ok: true });
  });

  it.each(DOCUMENTED)("%s %s on the shared sandbox follows its sandbox flag (%s)", (method, path, sandbox) => {
    const d = routeDecision(method, path.split("?")[0], "sandbox");
    if (sandbox) expect(d).toEqual({ ok: true });
    else expect(d).toMatchObject({ ok: false, reason: "not_on_sandbox", status: 403 });
  });

  it.each(EXCLUDED)("%s %s is not a route (404) on either estate", (method, path) => {
    for (const kind of ["estate", "sandbox"] as const) {
      expect(routeDecision(method, path, kind)).toMatchObject({ ok: false, reason: "path_not_allowed", status: 404 });
    }
  });

  it.each(WRONG_METHOD)("%s %s: the path is allowed but not this method (405)", (method, path) => {
    for (const kind of ["estate", "sandbox"] as const) {
      expect(routeDecision(method, path, kind)).toMatchObject({ ok: false, reason: "method_not_allowed", status: 405 });
    }
  });
});

describe("gateway handler: the allowlist decides before anything is sent", () => {
  let user: User;
  let key: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;

  async function dedicated(): Promise<string> {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.url = estateOrigin(e.app);
    await saveEstate(e);
    return e.url;
  }

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    process.env.ESTATE_URL = "https://sandbox.example";
    process.env.ESTATE_SHARED_SECRET = "sandbox-secret";
    user = await createUser("allowlist@example.com", "sufficiently-long-pass");
    key = (await issueKey(user, "t")).plaintext;
    fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
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

  it.each(DOCUMENTED)("dedicated estate: %s %s is forwarded to the estate, path and query unchanged", async (method, path) => {
    const origin = await dedicated();
    const res = await handler(req(method, path, key), ctx);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(origin + path);
    expect(init.method).toBe(method);
  });

  it.each(DOCUMENTED)("shared sandbox: %s %s is forwarded only when allowed there (%s)", async (method, path, sandbox) => {
    const res = await handler(req(method, path, key), ctx);
    if (sandbox) {
      expect(res.status).toBe(200);
      expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://sandbox.example" + path);
    } else {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: "not_on_sandbox", message: "This route needs a dedicated estate; it is not available on the shared sandbox." } });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(JSON.stringify({ gateway_refusal: "not_on_sandbox" }));
    }
  });

  it.each(EXCLUDED)("dedicated estate: %s %s answers 404 with a fixed body and sends nothing", async (method, path) => {
    await dedicated();
    const res = await handler(req(method, path, key), ctx);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "No such route on the console gateway." } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ gateway_refusal: "path_not_allowed" }));
  });

  it.each(EXCLUDED)("shared sandbox: %s %s answers 404 and sends nothing", async (method, path) => {
    const res = await handler(req(method, path, key), ctx);
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(WRONG_METHOD)("dedicated estate: %s %s answers 405 and sends nothing", async (method, path) => {
    await dedicated();
    const res = await handler(req(method, path, key), ctx);
    expect(res.status).toBe(405);
    expect((await res.json()).error.code).toBe("method_not_allowed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ gateway_refusal: "method_not_allowed" }));
  });

  it("an unauthenticated caller learns nothing about the allowlist: 401 before the route decision", async () => {
    const res = await handler(new Request(SITE + "/api/v1/api/fleet/halt", { method: "POST" }), ctx);
    expect(res.status).toBe(401);
    expect(warn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
