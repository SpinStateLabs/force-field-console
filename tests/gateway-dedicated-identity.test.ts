// Rules: a dedicated estate is reached only when the stored app name is the one derived from the user's id
// (newAppName, the function provisioning uses) and the stored url is exactly estateOrigin(app). The shared sandbox
// forwards only the sentinel check, presets and ledger health; the landing-page demo (a sentinel check) still works.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import handler from "../netlify/functions/gateway.mts";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { issueKey } from "../src/lib/keys";
import { newAppName, queueEstate, saveEstate } from "../src/lib/estates";
import { estateOrigin } from "../src/lib/fly";
import { ALLOWED_ROUTES, routeDecision } from "../src/lib/upstream";

const ctx = {} as any;
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };
const SITE = "https://force-field-console.netlify.app";

describe("dedicated estate identity", () => {
  let user: User;
  let key: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    process.env.ESTATE_URL = "https://sandbox.example";
    process.env.ESTATE_SHARED_SECRET = "sandbox-secret";
    user = await createUser("identity@example.com", "sufficiently-long-pass");
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

  const check = () =>
    handler(new Request(SITE + "/api/v1/sentinel/check", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: "{}" }), ctx);

  it("a record whose app AND url were both altered (a consistent pair for another app) sends nothing", async () => {
    const e = await queueEstate(user);
    expect(e.app).toBe(newAppName(user.id));
    e.status = "ready";
    e.step = "done";
    e.app = "ff-est-deadbeef";
    e.url = estateOrigin("ff-est-deadbeef");
    await saveEstate(e);
    const res = await check();
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("estate_misconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ gateway_refusal: "estate_url_mismatch" }));
  });

  it("a stored url that differs from the derived origin only by a trailing slash sends nothing", async () => {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.url = estateOrigin(e.app) + "/";
    await saveEstate(e);
    const res = await check();
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("estate_misconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the derived app and its exact origin are forwarded", async () => {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.url = estateOrigin(newAppName(user.id));
    await saveEstate(e);
    const res = await check();
    expect(res.status).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(estateOrigin(newAppName(user.id)) + "/sentinel/check");
  });

  it("the shared sandbox forwards only the sentinel check, presets and ledger health", () => {
    const samples: [string, string][] = [
      ["POST", "/sentinel/check"],
      ["GET", "/gateway/presets"],
      ["GET", "/gateway/presets/audit"],
      ["GET", "/ledger/health"],
    ];
    const onSandbox = ALLOWED_ROUTES.filter((r) => r.sandbox);
    expect(onSandbox).toHaveLength(samples.length);
    for (const r of onSandbox) expect(samples.some(([m, p]) => m === r.method && r.pattern.test(p)), r.docs).toBe(true);
    for (const [m, p] of samples) expect(routeDecision(m, p, "sandbox"), m + " " + p).toEqual({ ok: true });
    expect(routeDecision("POST", "/gateway/v1/messages", "sandbox")).toMatchObject({ ok: false, status: 403, code: "not_on_sandbox" });
    expect(routeDecision("POST", "/gateway/v1/messages", "estate")).toEqual({ ok: true });
  });

  it("the shared sandbox refuses a governed LLM call with 403 and sends nothing", async () => {
    const res = await handler(
      new Request(SITE + "/api/v1/gateway/v1/messages", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json", "x-field-agent-id": "a", "x-field-token": "t" }, body: "{}" }),
      ctx,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("not_on_sandbox");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the landing-page and dashboard demo (a sentinel check) still works on the shared sandbox", async () => {
    const index = readFileSync(join(__dirname, "..", "public/index.html"), "utf-8");
    const app = readFileSync(join(__dirname, "..", "public/app.js"), "utf-8");
    const demoPaths = [...index.matchAll(/curl -X POST \S*?\/api\/v1(\/[a-z/]+)/g), ...app.matchAll(/"\/api\/v1(\/[a-z/]+)/g)].map((m) => m[1]);
    expect(demoPaths.length).toBeGreaterThan(0);
    for (const p of demoPaths) expect(routeDecision("POST", p, "sandbox"), p).toEqual({ ok: true });
    const res = await check();
    expect(res.status).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://sandbox.example/sentinel/check");
  });
});
