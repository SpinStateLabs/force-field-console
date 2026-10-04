import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import handler from "../netlify/functions/gateway.mts";
import healthHandler from "../netlify/functions/health.mts";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { issueKey } from "../src/lib/keys";
import { estateSecret, queueEstate, saveEstate } from "../src/lib/estates";

const ctx = {} as any;
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

describe("gateway tenant routing", () => {
  let user: User;
  let key: string;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    process.env.ESTATE_URL = "https://sandbox.example";
    process.env.ESTATE_SHARED_SECRET = "sandbox-secret";
    user = await createUser("tenant@example.com", "sufficiently-long-pass");
    key = (await issueKey(user, "t")).plaintext;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
    delete process.env.ESTATE_URL;
    delete process.env.ESTATE_SHARED_SECRET;
  });

  function captureFetch() {
    const seen: { url: string; headers: Headers }[] = [];
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      seen.push({ url: typeof input === "string" ? input : input.url, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    return seen;
  }

  it("routes a ready dedicated estate to its own origin with the derived secret", async () => {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.url = `https://${e.app}.fly.dev`;
    await saveEstate(e);
    const seen = captureFetch();
    const res = await handler(new Request("http://portal.test/api/v1/sentinel/check?x=1", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: "{}" }), ctx);
    expect(res.status).toBe(200);
    expect(seen[0].url).toBe(`https://${e.app}.fly.dev/sentinel/check?x=1`);
    expect(seen[0].headers.get("x-field-auth")).toBe(estateSecret(e.app));
    expect(seen[0].headers.get("x-ff-tenant")).toBe(user.id);
  });

  it("refuses while provisioning (503) and when suspended (403) without touching any estate", async () => {
    const e = await queueEstate(user);
    const seen = captureFetch();
    const prov = await handler(new Request("http://portal.test/api/v1/sentinel/check", { headers: { "x-api-key": key } }), ctx);
    expect(prov.status).toBe(503);
    expect((await prov.json()).error.code).toBe("estate_provisioning");
    e.status = "suspended";
    await saveEstate(e);
    const sus = await handler(new Request("http://portal.test/api/v1/sentinel/check", { headers: { "x-api-key": key } }), ctx);
    expect(sus.status).toBe(403);
    expect((await sus.json()).error.code).toBe("estate_suspended");
    expect(seen).toHaveLength(0);
  });

  it("sends pending_manual estates and sandbox accounts to the shared sandbox", async () => {
    delete process.env.FLY_API_TOKEN;
    const e = await queueEstate(user);
    expect(e.status).toBe("pending_manual");
    const seen = captureFetch();
    const res = await handler(new Request("http://portal.test/api/v1/registry/health", { headers: { "x-api-key": key } }), ctx);
    expect(res.status).toBe(200);
    expect(seen[0].url).toBe("https://sandbox.example/registry/health");
    expect(seen[0].headers.get("x-field-auth")).toBe("sandbox-secret");
  });
});

describe("health capability flags", () => {
  afterEach(() => {
    for (const k of [...Object.keys(FLY_ENV), "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_OPERATOR", "STRIPE_PRICE_SOVEREIGN", "ESTATE_URL"]) delete process.env[k];
  });

  it("reports billing and provisioning as configured only when their variables are all set", async () => {
    const off = await (await healthHandler(new Request("http://portal.test/api/health"), ctx)).json();
    expect(off).toMatchObject({ ok: true, billing_configured: false, provisioning_configured: false, store_scope: "deploy", version: "0.2.2" });
    Object.assign(process.env, FLY_ENV, { STRIPE_SECRET_KEY: "a", STRIPE_WEBHOOK_SECRET: "b", STRIPE_PRICE_OPERATOR: "c", STRIPE_PRICE_SOVEREIGN: "d", ESTATE_URL: "https://s" });
    const on = await (await healthHandler(new Request("http://portal.test/api/health"), ctx)).json();
    expect(on).toMatchObject({ estate_attached: true, billing_configured: true, provisioning_configured: true });
  });
});
