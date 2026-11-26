// Agent pool enforcement at the portal gateway (price book rev 2): a dedicated-estate account may run at most
// billing.agent_pool governed agents. Counted = the estate registry's agents that are NOT retired and NOT platform
// self-agents. Gated: registering (POST /registry/agents). PATCH /registry/agents/<id> (which could revive a retired
// agent) is not forwarded by the console at all. Path variants that the upstream would route the same way are gated too. Fail closed when the
// count cannot be read. The shared sandbox is not gated (no pool).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import handler from "../netlify/functions/gateway.mts";
import { freshStore } from "./helpers";
import { createUser, saveUser, type User } from "../src/lib/users";
import { issueKey } from "../src/lib/keys";
import { SELF_OWNER, queueEstate, saveEstate } from "../src/lib/estates";
import { ALLOWED_ROUTES, routeDecision } from "../src/lib/upstream";
import { classify } from "../src/lib/agentpool";

const ctx = {} as any;
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

type Agent = { agent_id: string; owner: string; status: string };

let user: User;
let key: string;
let base: string;
let agents: Agent[];
let calls: { method: string; url: string }[];
let listFails: boolean;

/** A fake estate registry behind the gateway. */
function fakeEstate() {
  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = String(init?.method ?? "GET").toUpperCase();
    calls.push({ method, url: url.pathname });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const path = decodeURIComponent(url.pathname).replace(/\/+/g, "/").replace(/\/$/, "");
    if (path === "/registry/agents" && method === "GET") return listFails ? json(503, { detail: "down" }) : json(200, agents);
    if (path === "/registry/agents" && method === "POST") {
      const b = JSON.parse(new TextDecoder().decode(init.body));
      agents.push({ agent_id: b.agent_id, owner: b.owner, status: "active" });
      return json(201, agents[agents.length - 1]);
    }
    const m = /^\/registry\/agents\/([^/]+)$/.exec(path);
    if (m && method === "GET") {
      const a = agents.find((x) => x.agent_id === m[1]);
      return a ? json(200, a) : json(404, { detail: "not found" });
    }
    if (m && method === "PATCH") {
      const a = agents.find((x) => x.agent_id === m[1])!;
      Object.assign(a, JSON.parse(new TextDecoder().decode(init.body)));
      return json(200, a);
    }
    return json(200, { ok: true });
  });
}

async function readyEstate(pool: number | undefined, tier: "operator" | "sovereign" = "sovereign") {
  user.tier = tier;
  user.billing = { customer_id: "cus_1", subscription_id: "sub_1", status: "active", price_id: "p", tier, current_period_end: null, updated_at: "t", ...(pool === undefined ? {} : { seats: 3, packs: 0, agent_pool: pool }) };
  await saveUser(user);
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", url: `https://${e.app}.fly.dev` });
  await saveEstate(e);
  base = `https://${e.app}.fly.dev`;
}

const send = (path: string, method = "POST", body: unknown = undefined) =>
  handler(new Request("http://portal.test/api/v1" + path, { method, headers: { "x-api-key": key, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), ctx);
const reg = (id: string) => send("/registry/agents", "POST", { agent_id: id, name: id, owner: "me@example.com", domain: "finance" });
const own = (n: number, status = "active") => Array.from({ length: n }, (_, i) => ({ agent_id: "a" + i, owner: "me@example.com", status }));

beforeEach(async () => {
  freshStore();
  Object.assign(process.env, FLY_ENV);
  user = await createUser("pool@example.com", "sufficiently-long-pass");
  key = (await issueKey(user, "t")).plaintext;
  agents = [];
  calls = [];
  listFails = false;
  fakeEstate();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(FLY_ENV)) delete process.env[k];
  delete process.env.ESTATE_URL;
  delete process.env.ESTATE_SHARED_SECRET;
});

describe("registering an agent", () => {
  it("below the pool: forwarded (201)", async () => {
    await readyEstate(3);
    agents = own(2);
    const r = await reg("new");
    expect(r.status).toBe(201);
    expect(agents).toHaveLength(3);
  });

  it("at the pool: 403 agent_pool_full with the numbers; nothing forwarded", async () => {
    await readyEstate(3);
    agents = own(3);
    const r = await reg("over");
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe("agent_pool_full");
    expect(body.error.agent_pool).toBe(3);
    expect(body.error.in_use).toBe(3);
    // customers cannot retire through the console: the message must not tell them to
    expect(body.error.message).toMatch(/contact Spin State Labs/);
    expect(body.error.message).not.toMatch(/^Retire|\. Retire an agent/);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("platform self-agents and retired agents do not count", async () => {
    await readyEstate(2);
    agents = [...own(1), { agent_id: "conformance-sentinel", owner: SELF_OWNER, status: "active" }, { agent_id: "old", owner: "me@example.com", status: "retired" }];
    expect((await reg("second")).status).toBe(201);
    expect((await reg("third")).status).toBe(403);
  });

  it("no agent_pool recorded (older subscription): the tier minimum's pool applies", async () => {
    await readyEstate(undefined, "sovereign"); // 3 seats x 20 = 60
    agents = own(60);
    expect((await reg("x")).status).toBe(403);
    agents = own(59);
    expect((await reg("y")).status).toBe(201);
  });

  it("the count cannot be read: 503 agent_count_unavailable (fail closed)", async () => {
    await readyEstate(5);
    listFails = true;
    const r = await reg("z");
    expect(r.status).toBe(503);
    expect((await r.json()).error.code).toBe("agent_count_unavailable");
  });

  it("path variants are refused before the pool gate (raw-path refusal or route allowlist); nothing is forwarded", async () => {
    await readyEstate(1);
    agents = own(1);
    for (const p of ["/registry/agents/", "/registry//agents", "//registry/agents", "/registry/agents//", "/registry%2Fagents", "/registry/%61gents"]) {
      const r = await send(p, "POST", { agent_id: "v", name: "v", owner: "me@example.com", domain: "d" });
      expect([400, 404], p).toContain(r.status);
    }
    expect(calls).toEqual([]);
  });

  it("an undecodable path under /registry is refused (404 at the route allowlist), not forwarded", async () => {
    await readyEstate(5);
    const r = await send("/registry/agents%E0%A4%A", "POST", {});
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("not_found");
    expect(calls).toEqual([]);
  });

  it("concurrent registrations never exceed the pool", async () => {
    await readyEstate(3);
    agents = own(1);
    const rs = await Promise.all(["c1", "c2", "c3", "c4", "c5"].map((id) => reg(id)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(2);
    expect(agents.filter((a) => a.status !== "retired")).toHaveLength(3);
  });
});

describe("reviving or changing an agent (PATCH)", () => {
  it("PATCH /registry/agents/<id> is not forwarded through the console (404): no revival past the pool is possible", async () => {
    await readyEstate(2);
    agents = [...own(2), { agent_id: "old", owner: "me@example.com", status: "retired" }];
    for (const body of [{ status: "active" }, { status: "retired" }, { domain: "ops" }]) {
      const r = await send("/registry/agents/old", "PATCH", body);
      expect(r.status, JSON.stringify(body)).toBe(404);
      expect((await r.json()).error.code).toBe("not_found");
    }
    expect(agents.find((a) => a.agent_id === "old")!.status).toBe("retired");
    expect(calls).toEqual([]);
  });

  it("PATCH stays off the route allowlist, and the pool gate has no revival branch", () => {
    expect(ALLOWED_ROUTES.some((r) => r.method.toUpperCase() === "PATCH")).toBe(false);
    for (const p of ["/registry/agents/old", "/registry/agents", "/registry/agents/old/status"]) {
      expect(routeDecision("PATCH", p, "estate").ok, p).toBe(false);
      expect(routeDecision("PATCH", p, "sandbox").ok, p).toBe(false);
    }
    const revive = new TextEncoder().encode(JSON.stringify({ status: "active" })).buffer as ArrayBuffer;
    expect(classify("PATCH", "/registry/agents/old", revive)).toBeNull();
    expect(classify("POST", "/registry/agents", undefined)).toEqual({ kind: "register" });
  });
});

describe("not gated", () => {
  it("reads, other services, and the shared sandbox", async () => {
    await readyEstate(0);
    agents = own(5);
    expect((await send("/registry/agents", "GET")).status).toBe(200);
    expect((await send("/sentinel/check", "POST", {})).status).toBe(200);
  });

  it("a sandbox account (no dedicated estate) cannot register on the shared sandbox (403 not_on_sandbox); nothing is sent", async () => {
    process.env.ESTATE_URL = "https://sandbox.example";
    process.env.ESTATE_SHARED_SECRET = "s";
    const r = await reg("sb");
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe("not_on_sandbox");
    expect(calls).toEqual([]);
  });
});

describe("self-agent owner spoofing", () => {
  it("an agent registered under the platform owner name but not a platform id COUNTS", async () => {
    await readyEstate(2);
    agents = [...own(1), { agent_id: "my-hidden-bot", owner: SELF_OWNER, status: "active" }, { agent_id: "force-gateway", owner: SELF_OWNER, status: "active" }];
    const r = await reg("third");
    expect(r.status).toBe(403);
    expect((await r.json()).error.in_use).toBe(2);
  });
});
