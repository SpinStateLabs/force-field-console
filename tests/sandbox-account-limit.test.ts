// Shared sandbox: POST /sentinel/check is counted per account (all of the account's keys), after the route allowlist,
// before anything is sent; an optional ceiling across all accounts (off by default) answers 503.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import handler from "../netlify/functions/gateway.mts";
import { freshStore } from "./helpers";
import { createUser, getUserById, type User } from "../src/lib/users";
import { issueKey, revokeKey } from "../src/lib/keys";
import { queueEstate, saveEstate } from "../src/lib/estates";
import { estateOrigin } from "../src/lib/fly";
import { sandboxLimits } from "../src/lib/sandboxlimit";
import { TIERS } from "../src/lib/tiers";

const ctx = {} as any;
const SITE = "https://force-field-console.netlify.app";
const ENV_KEYS = ["SANDBOX_ACCOUNT_RPM", "SANDBOX_ACCOUNT_RPD", "SANDBOX_GLOBAL_RPM", "ESTATE_URL", "ESTATE_SHARED_SECRET",
  "FLY_API_TOKEN", "FLY_ORG_SLUG", "FLY_ESTATE_IMAGE", "ESTATE_SECRET_MASTER"];

describe("shared sandbox: sentinel checks per account", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let store: any;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store = freshStore();
    vi.useFakeTimers({ now: new Date("2026-11-26T12:00:05Z"), toFake: ["Date"] });
    process.env.ESTATE_URL = "https://sandbox.example";
    process.env.ESTATE_SHARED_SECRET = "sandbox-secret";
    process.env.SANDBOX_ACCOUNT_RPM = "3";
    fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    warn.mockRestore();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  const send = (key: string, path = "/sentinel/check", method = "POST") =>
    handler(new Request(SITE + "/api/v1" + path, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: method === "GET" ? undefined : "{}",
    }), ctx);

  async function account(email: string) {
    const u = await createUser(email, "sufficiently-long-pass");
    return u;
  }
  const newKey = async (u: User) => (await issueKey((await getUserById(u.id))!, "k")).plaintext;

  it("defaults: the sandbox tier's numbers; the ceiling is off; bad values fall back", () => {
    delete process.env.SANDBOX_ACCOUNT_RPM;
    expect(sandboxLimits()).toEqual({ rpm: TIERS.sandbox.rpm, rpd: TIERS.sandbox.rpd, globalRpm: null });
    for (const bad of ["0", "-1", "abc", "1.5", " ", "9999999999"]) {
      process.env.SANDBOX_ACCOUNT_RPM = bad;
      process.env.SANDBOX_GLOBAL_RPM = bad;
      expect(sandboxLimits().rpm, bad).toBe(TIERS.sandbox.rpm);
      expect(sandboxLimits().globalRpm, bad).toBeNull();
    }
    process.env.SANDBOX_ACCOUNT_RPM = "7";
    process.env.SANDBOX_ACCOUNT_RPD = "70";
    process.env.SANDBOX_GLOBAL_RPM = "300";
    expect(sandboxLimits()).toEqual({ rpm: 7, rpd: 70, globalRpm: 300 });
  });

  it("two keys of one account share one bucket", async () => {
    const u = await account("one@example.com");
    const k1 = await newKey(u);
    const k2 = await newKey(u);
    const statuses = [];
    for (const k of [k1, k2, k1, k2]) statuses.push((await send(k)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const r = await send(k1);
    expect(r.status).toBe(429);
    expect((await r.json()).error.code).toBe("rate_limited_account");
    expect(r.headers.get("retry-after")).toBe("55");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ gateway_refusal: "sandbox_account_limit" }));
  });

  it("revoking a key and making a new one does not reset the count", async () => {
    const u = await account("rotate@example.com");
    const k1 = await newKey(u);
    for (let i = 0; i < 3; i++) expect((await send(k1)).status).toBe(200);
    const fresh = (await getUserById(u.id))!;
    expect(await revokeKey(fresh, fresh.keys[0].hash)).toBe(true);
    const k2 = await newKey(u);
    expect((await send(k2)).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("two accounts each have their own bucket", async () => {
    const ka = await newKey(await account("a@example.com"));
    const kb = await newKey(await account("b@example.com"));
    for (let i = 0; i < 3; i++) {
      expect((await send(ka)).status).toBe(200);
      expect((await send(kb)).status).toBe(200);
    }
    expect((await send(ka)).status).toBe(429);
    expect((await send(kb)).status).toBe(429);
  });

  it("refused paths and the cheap reads do not count", async () => {
    process.env.SANDBOX_ACCOUNT_RPM = "2";
    const k = await newKey(await account("reads@example.com"));
    expect((await send(k, "/sentinel/check", "GET")).status).toBe(405);
    expect((await send(k, "/registry/agents")).status).toBe(403);
    expect((await send(k, "/nope")).status).toBe(404);
    expect((await send(k, "/ledger/health", "GET")).status).toBe(200);
    expect((await send(k, "/gateway/presets", "GET")).status).toBe(200);
    expect((await send(k)).status).toBe(200);
    expect((await send(k)).status).toBe(200);
    expect((await send(k)).status).toBe(429);
  });

  it("the day window: refused until the next UTC day", async () => {
    process.env.SANDBOX_ACCOUNT_RPM = "50";
    process.env.SANDBOX_ACCOUNT_RPD = "2";
    const k = await newKey(await account("day@example.com"));
    expect((await send(k)).status).toBe(200);
    expect((await send(k)).status).toBe(200);
    const r = await send(k);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBe(12 * 3600 - 5);
  });

  it("a counter write that keeps losing is refused, never let through uncounted", async () => {
    const k = await newKey(await account("busy@example.com"));
    expect((await send(k)).status).toBe(200); // creates the counters
    store.setJSONIfMatch = async () => false;
    const r = await send(k);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a minute counter write that keeps losing is refused too", async () => {
    const k = await newKey(await account("busy-minute@example.com"));
    expect((await send(k)).status).toBe(200);
    const real = store.setJSONIfMatch.bind(store);
    store.setJSONIfMatch = async (key: string, v: any, etag: string) => (key.includes("/m") ? false : real(key, v, etag));
    const r = await send(k);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the ceiling across accounts, when set, answers 503 sandbox_busy; off by default", async () => {
    const keys = [];
    for (const e of ["g1@example.com", "g2@example.com", "g3@example.com"]) keys.push(await newKey(await account(e)));
    for (const k of keys) expect((await send(k)).status).toBe(200); // default: no ceiling
    process.env.SANDBOX_GLOBAL_RPM = "4"; // the ceiling counts only while it is set: these are calls 1-4
    expect((await send(keys[0])).status).toBe(200);
    expect((await send(keys[1])).status).toBe(200);
    expect((await send(keys[2])).status).toBe(200);
    expect((await send(keys[0])).status).toBe(200);
    const r = await send(keys[1]);
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("sandbox_busy");
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ gateway_refusal: "sandbox_busy" }));
  });

  it("a dedicated estate is not counted", async () => {
    Object.assign(process.env, { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" });
    process.env.SANDBOX_ACCOUNT_RPM = "1";
    const u = await account("dedicated@example.com");
    const e = await queueEstate(u);
    e.status = "ready";
    e.step = "done";
    e.url = estateOrigin(e.app);
    await saveEstate(e);
    const k = await newKey(u);
    for (let i = 0; i < 4; i++) expect((await send(k)).status).toBe(200);
  });
});
