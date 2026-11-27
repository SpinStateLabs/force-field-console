// Shared sandbox: POST /sentinel/check is counted per account (all of the account's keys), after the route allowlist,
// before anything is sent; an optional ceiling across all accounts (off by default) answers 503.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import handler from "../netlify/functions/gateway.mts";
import { freshStore } from "./helpers";
import { createUser, getUserById, type User } from "../src/lib/users";
import { issueKey, revokeKey } from "../src/lib/keys";
import { queueEstate, saveEstate } from "../src/lib/estates";
import { estateOrigin } from "../src/lib/fly";
import { GLOBAL_KEY, accountKey, sandboxLimits } from "../src/lib/sandboxlimit";
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

  it("a write of the account record that keeps losing is refused (429, retry-after 1), never let through uncounted", async () => {
    const k = await newKey(await account("busy@example.com"));
    expect((await send(k)).status).toBe(200); // creates the account record
    store.setJSONIfMatch = async () => false;
    const r = await send(k);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("200 checks in one minute: 10 answered, 190 refused, and the refused ones use up no day slots", async () => {
    delete process.env.SANDBOX_ACCOUNT_RPM; // defaults: 10 per minute, 200 per day
    const u = await account("burst@example.com");
    const keys = [];
    for (let i = 0; i < 20; i++) keys.push(await newKey(u)); // 10 calls per key stays under the per-key limit
    const codes: Record<number, number> = {};
    for (let i = 0; i < 200; i++) {
      const r = await send(keys[i % 20]);
      codes[r.status] = (codes[r.status] ?? 0) + 1;
      if (r.status === 429) expect((await r.json()).error.code).toBe("rate_limited_account");
    }
    expect(codes).toEqual({ 200: 10, 429: 190 });
    expect(fetchMock).toHaveBeenCalledTimes(10);
    const rec = (await store.get(accountKey(u.id), { type: "json" })) as any;
    expect(rec).toMatchObject({ day: "20261126", d: 10, minute: "202611261200", m: 10 });
    expect(TIERS.sandbox.rpd - rec.d).toBe(190);
  });

  it("one record per account holds both windows (no record per minute)", async () => {
    const u = await account("onerecord@example.com");
    const k = await newKey(u);
    expect((await send(k)).status).toBe(200);
    vi.setSystemTime(new Date("2026-11-26T12:01:05Z"));
    expect((await send(k)).status).toBe(200);
    const keys = (await store.list({ prefix: "rate/acct/" })).blobs.map((b: any) => b.key);
    expect(keys).toEqual([accountKey(u.id)]);
    expect(await store.get(accountKey(u.id), { type: "json" })).toMatchObject({ d: 2, minute: "202611261201", m: 1 });
  });

  it("the ceiling across accounts, when set, answers 503 sandbox_busy, counts only allowed checks, and spends no account budget", async () => {
    process.env.SANDBOX_ACCOUNT_RPM = "2";
    const keys = [];
    const users = [];
    for (const e of ["g1@example.com", "g2@example.com", "g3@example.com"]) {
      const u = await account(e);
      users.push(u);
      keys.push(await newKey(u));
    }
    for (const k of keys) expect((await send(k)).status).toBe(200); // default: no ceiling, nothing recorded for it
    expect(await store.get(GLOBAL_KEY, { type: "json" })).toBeNull();
    process.env.SANDBOX_GLOBAL_RPM = "4";
    expect((await send(keys[0])).status).toBe(200);
    expect((await send(keys[1])).status).toBe(200);
    expect((await send(keys[2])).status).toBe(200);
    // keys[0] is now at its account limit of 2: refused by the account check, so the ceiling does not count it
    expect((await send(keys[0])).status).toBe(429);
    expect(await store.get(GLOBAL_KEY, { type: "json" })).toMatchObject({ count: 3 });
    process.env.SANDBOX_ACCOUNT_RPM = "10";
    expect((await send(keys[1])).status).toBe(200); // the 4th counted check
    const before = ((await store.get(accountKey(users[2].id), { type: "json" })) as any).d;
    const r = await send(keys[2]);
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("sandbox_busy");
    expect(((await store.get(accountKey(users[2].id), { type: "json" })) as any).d).toBe(before); // no account slot spent
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
