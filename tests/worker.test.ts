import { describe, it, expect, beforeEach, afterEach } from "vitest";
import workerHandler from "../netlify/functions/estate-worker-background.mts";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { SELF_AGENTS, getEstate, queueEstate, saveEstate } from "../src/lib/estates";
import { internalToken, kickWorker, runWorker, verifyInternalToken } from "../src/lib/worker";
import { RENEW_PY } from "../src/lib/renewal";

const ctx = {} as any;
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

/** A Fly stand-in whose create_app step fails `failures` times, then everything succeeds and health is always green. */
class LoopFly {
  calls: string[] = [];
  failures = 0;
  volumes: any[] = [];
  machines: any[] = [];
  async createApp(name: string) { this.calls.push("createApp"); if (this.failures > 0) { this.failures -= 1; throw new Error("boom"); } }
  appExists = true;
  async getApp(name: string) { this.calls.push("getApp"); return this.appExists ? { name } : null; }
  async listIps() { return [{ address: "1.1.1.1", type: "shared_v4" }, { address: "::1", type: "v6" }]; }
  async allocateIp() { throw new Error("not expected"); }
  async listVolumes() { return this.volumes; }
  async createVolume(_a: string, name: string) { const v = { id: "vol_1", name }; this.volumes.push(v); return { id: v.id }; }
  async setSecrets() { this.calls.push("setSecrets"); }
  async listMachines() { return this.machines; }
  async createMachine(_a: string, name: string, config: any) { const m = { id: "m_1", name, config }; this.machines.push(m); return m; }
  async getMachine() { return this.machines[0] ?? null; }
  async updateMachine(_a: string, _id: string, config: any) { this.calls.push("updateMachine"); this.machines[0].config = config; return this.machines[0]; }
  async exec(_a: string, _i: string, cmd: string[]) {
    if (cmd[0] === "python3" && cmd[2] === RENEW_PY) return { exit_code: 0, stdout: JSON.stringify({ token_id: "renewed-" + cmd[4] }) + "\n", stderr: "" };
    if (cmd[0] === "python3") return { exit_code: 0, stdout: JSON.stringify({ keys: { "ledger-sign": { pub: "P", fingerprint: "fs" } }, manifests: [], roster_rows: 2 }) + "\n", stderr: "" };
    return { exit_code: 0, stdout: JSON.stringify({ token_id: "tok-" + cmd[4] }) + "\n", stderr: "" };
  }
  async stopMachine() {} async startMachine() {}
}

const greenHealth = async (url: string) => {
  const path = new URL(url).pathname;
  const bodies: Record<string, any> = {
    "/registry/health": { ok: true },
    "/delegation/health": { ok: true },
    "/ledger/health": { signing: "on", require_signing: true, appendable: true, key_fingerprint: "fs" },
    "/gateway/health": { enforce: true, tool_check: true },
    "/attest/health": { signing: "on" },
  };
  return new Response(JSON.stringify(bodies[path] ?? {}), { status: bodies[path] ? 200 : 503, headers: { "content-type": "application/json" } });
};

describe("worker loop", () => {
  let user: User;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    user = await createUser("worker@example.com", "sufficiently-long-pass");
  });

  afterEach(() => {
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
    delete process.env.URL;
  });

  it("drives an estate from queued to ready in one run, retrying a transient failure, and releases the worker lease", async () => {
    await queueEstate(user);
    const fly = new LoopFly();
    fly.failures = 1;
    const r = await runWorker(user.id, "advance", fly as any, { fetchImpl: greenHealth, sleep: async () => {}, budgetMs: 60000 });
    expect(r.last).toBe("done");
    expect(r.status).toBe("ready");
    expect(r.iterations).toBeGreaterThanOrEqual(13);
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("ready");
    expect(e.worker_until).toBeNull();
    expect(e.attempts).toBe(0);
    expect(e.log.some((l) => l.note.includes("attempt 1 failed"))).toBe(true);
    expect(JSON.stringify(e)).not.toContain("tok-");
  });

  it("refuses to run beside a live worker and reports no_estate for accounts without one", async () => {
    const e = await queueEstate(user);
    e.worker_until = new Date(Date.now() + 600000).toISOString();
    await saveEstate(e);
    const fly = new LoopFly();
    const r = await runWorker(user.id, "advance", fly as any, { sleep: async () => {} });
    expect(r.last).toBe("worker_active");
    expect(fly.calls).toHaveLength(0);
    const other = await createUser("nobody@example.com", "sufficiently-long-pass");
    expect((await runWorker(other.id, "advance", fly as any)).last).toBe("no_estate");
  });

  it("stops at the budget and clears the lease", async () => {
    await queueEstate(user);
    const fly = new LoopFly();
    // An injected clock (1000 ms per reading) makes the budget deterministic: started at 0, loop checks read
    // 1000, 2000, 3000 (inside a 3500 ms budget) and 4000 (over it): exactly three iterations.
    let t = -1000;
    const clock = () => (t += 1000);
    const r = await runWorker(user.id, "advance", fly as any, { fetchImpl: async () => new Response("", { status: 503 }), sleep: async () => {}, budgetMs: 3500, now: clock });
    expect(r.iterations).toBe(3);
    expect((await getEstate(user.id))!.worker_until).toBeNull();
  });

  it("renew action renews only when due", async () => {
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.machine_id = "m_1";
    for (const a of SELF_AGENTS) e.self_agents[a.id] = { provisioned_at: new Date(Date.now() - 26 * 86400000).toISOString() };
    await saveEstate(e);
    const fly = new LoopFly();
    fly.machines.push({ id: "m_1", name: "estate", config: { image: "i" } });
    expect((await runWorker(user.id, "renew", fly as any)).last).toBe("renewed");
    expect(fly.calls.filter((c) => c === "updateMachine")).toHaveLength(1);
    expect((await runWorker(user.id, "renew", fly as any)).last).toBe("not_due");
  });

  it("internal tokens are per user and constant-time verified", () => {
    const t = internalToken("u1", "s");
    expect(verifyInternalToken(t, "u1", "s")).toBe(true);
    expect(verifyInternalToken(t, "u2", "s")).toBe(false);
    expect(verifyInternalToken(t, "u1", "other")).toBe(false);
    expect(verifyInternalToken(null, "u1", "s")).toBe(false);
    expect(verifyInternalToken("short", "u1", "s")).toBe(false);
  });

  it("kickWorker posts an internal kick to the site URL and reports acceptance", async () => {
    let seen: any = null;
    const fetchImpl = async (url: string, init?: any) => { seen = { url, init }; return new Response("", { status: 202 }); };
    expect(await kickWorker("u1", "advance", fetchImpl)).toBe(false); // no URL
    process.env.URL = "https://portal.test/";
    expect(await kickWorker("u1", "renew", fetchImpl)).toBe(true);
    expect(seen.url).toBe("https://portal.test/.netlify/functions/estate-worker-background");
    expect(seen.init.headers["x-ff-internal"]).toBe(internalToken("u1"));
    expect(JSON.parse(seen.init.body)).toEqual({ user_id: "u1", action: "renew" });
  });
});

describe("worker and tick functions", () => {
  let user: User;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, FLY_ENV);
    user = await createUser("fn@example.com", "sufficiently-long-pass");
  });

  afterEach(() => {
    for (const k of Object.keys(FLY_ENV)) delete process.env[k];
    delete process.env.URL;
  });

  it("worker function: 401 without session or internal token; 501 unconfigured; accepts a session", async () => {
    const anon = await workerHandler(new Request("http://portal.test/.netlify/functions/estate-worker-background", { method: "POST", body: "{}" }), ctx);
    expect(anon.status).toBe(401);
    const forged = await workerHandler(new Request("http://portal.test/.netlify/functions/estate-worker-background", { method: "POST", headers: { "x-ff-internal": "nope" }, body: JSON.stringify({ user_id: user.id }) }), ctx);
    expect(forged.status).toBe(401);
    const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
    delete process.env.FLY_API_TOKEN;
    const off = await workerHandler(new Request("http://portal.test/.netlify/functions/estate-worker-background", { method: "POST", headers: { cookie }, body: "{}" }), ctx);
    expect(off.status).toBe(501);
    process.env.FLY_API_TOKEN = "fo1_test";
    const ok = await workerHandler(new Request("http://portal.test/.netlify/functions/estate-worker-background", { method: "POST", headers: { cookie }, body: "{}" }), ctx);
    expect(ok.status).toBe(200);
    expect((await ok.json()).last).toBe("no_estate");
    const internal = await workerHandler(new Request("http://portal.test/.netlify/functions/estate-worker-background", { method: "POST", headers: { "x-ff-internal": internalToken(user.id) }, body: JSON.stringify({ user_id: user.id, action: "renew" }) }), ctx);
    expect(internal.status).toBe(200);
  });

  async function readyEstate(u: User, image: string) {
    const e = await queueEstate(u);
    e.status = "ready";
    e.step = "done";
    e.machine_id = "m_1";
    e.volume_id = "vol_1";
    e.url = "https://" + e.app + ".fly.dev";
    e.image = image;
    e.fingerprints = { "ledger-sign": "fs" };
    e.self_agents = Object.fromEntries(SELF_AGENTS.map((a) => [a.id, { provisioned_at: new Date().toISOString() }]));
    await saveEstate(e);
    return e;
  }

  /** Routes the tick's real fetches: Fly Machines API (app / machine reads), estate health, worker kicks. */
  function routedFetch(o: { appExists: boolean; ledger: any | null; kicks: any[] }) {
    return (async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith("https://api.machines.dev/v1/apps/")) {
        if (u.includes("/machines/")) return new Response(JSON.stringify({ id: "m_1", config: { image: "registry.fly.io/x:y" } }), { status: 200 });
        return o.appExists ? new Response(JSON.stringify({ name: "app" }), { status: 200 }) : new Response("", { status: 404 });
      }
      if (u.endsWith("/ledger/health")) return o.ledger ? new Response(JSON.stringify(o.ledger), { status: 200 }) : new Response("", { status: 503 });
      o.kicks.push(JSON.parse(init.body));
      return new Response("", { status: 202 });
    }) as any;
  }

  it("tick: health-checks ready estates (ok / missing app), kicks ONE image upgrade per tick, and halts while an estate failed on that image", async () => {
    process.env.URL = "https://portal.test";
    const a = await readyEstate(user, "registry.fly.io/x:y");
    const realFetch = globalThis.fetch;
    const kicks: any[] = [];
    try {
      // On the configured image and healthy: nothing to do but record the health look.
      globalThis.fetch = routedFetch({ appExists: true, ledger: { ok: true, appendable: true }, kicks });
      let body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(body.outcomes).toEqual({ health_ok: 1 });
      expect(body.drifted).toBe(0);
      expect((await getEstate(a.user_id))!.health).toMatchObject({ ok: true });

      // The estate image moved on: one upgrade kick.
      process.env.FLY_ESTATE_IMAGE = "registry.fly.io/x:z";
      body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(body.drifted).toBe(1);
      expect(body.outcomes).toEqual({ health_ok: 1, upgrade_kicked: 1 });
      expect(kicks).toEqual([{ user_id: a.user_id, action: "upgrade" }]);

      // Another estate failed on that image: the rollout halts (no kick for anyone).
      const other = await createUser("failed@example.com", "sufficiently-long-pass");
      const b = await readyEstate(other, "registry.fly.io/x:y");
      b.upgrade_failed_image = "registry.fly.io/x:z";
      await saveEstate(b);
      kicks.length = 0;
      body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(body.outcomes).toEqual({ health_ok: 2, upgrade_halted: 1 });
      expect(kicks).toEqual([]);

      // The Fly app behind a ready estate is gone: an honest error, never a kick.
      globalThis.fetch = routedFetch({ appExists: false, ledger: null, kicks });
      body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(body.outcomes).toEqual({ health_app_missing: 2 });
      expect((await getEstate(a.user_id))!.status).toBe("error");
      expect((await getEstate(a.user_id))!.error).toMatch(/estate_app_missing/);
      expect(kicks).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      process.env.FLY_ESTATE_IMAGE = FLY_ENV.FLY_ESTATE_IMAGE;
    }
  });

  it("renew holds the worker lease too: refused beside a live worker, lease cleared afterwards; the tick does not kick an upgrade for an estate whose renewal is due", async () => {
    const fly = new LoopFly();
    const e = await readyEstate(user, "registry.fly.io/x:y");
    e.self_agents = Object.fromEntries(SELF_AGENTS.map((a) => [a.id, { provisioned_at: new Date(Date.now() - 26 * 86400_000).toISOString() }]));
    e.worker_until = new Date(Date.now() + 600_000).toISOString();
    await saveEstate(e);
    fly.machines.push({ id: "m_1", name: "estate", config: { image: e.image } });
    expect((await runWorker(user.id, "renew", fly as any, { fetchImpl: greenHealth })).last).toBe("worker_active");
    e.worker_until = null;
    await saveEstate(e);
    const r = await runWorker(user.id, "renew", fly as any, { fetchImpl: greenHealth });
    expect(r.last).toBe("renewed");
    expect((await getEstate(user.id))!.worker_until).toBeNull();

    // Due for renewal AND on an old image: the tick kicks the renewal only.
    process.env.URL = "https://portal.test";
    process.env.FLY_ESTATE_IMAGE = "registry.fly.io/x:z";
    const due = (await getEstate(user.id))!;
    due.self_agents = Object.fromEntries(SELF_AGENTS.map((a) => [a.id, { provisioned_at: new Date(Date.now() - 26 * 86400_000).toISOString() }]));
    await saveEstate(due);
    const kicks: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = routedFetch({ appExists: true, ledger: { ok: true, appendable: true }, kicks });
    try {
      const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(kicks).toEqual([{ user_id: user.id, action: "renew" }]);
      expect(body.outcomes).toEqual({ renew_kicked: 1, health_ok: 1 });
      expect(body.drifted).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      process.env.FLY_ESTATE_IMAGE = FLY_ENV.FLY_ESTATE_IMAGE;
    }
  });

  it("worker upgrade action: updates the machine to the configured image and re-verifies the posture; a no-op on the current image", async () => {
    const fly = new LoopFly();
    const e = await readyEstate(user, "registry.fly.io/x:old");
    fly.machines.push({ id: "m_1", name: "estate", config: { image: e.image } });
    const r = await runWorker(user.id, "upgrade", fly as any, { fetchImpl: greenHealth, sleep: async () => {} });
    expect(r.last).toBe("upgraded");
    expect(fly.calls).toContain("updateMachine");
    expect(fly.machines[0].config.image).toBe("registry.fly.io/x:y");
    const cur = (await getEstate(user.id))!;
    expect(cur.image).toBe("registry.fly.io/x:y");
    expect(cur.worker_until).toBeNull();
    const again = await runWorker(user.id, "upgrade", fly as any, { fetchImpl: greenHealth, sleep: async () => {} });
    expect(again.last).toBe("unchanged");
  });

  it("tick: kicks the worker for idle provisioning estates and renewals, skips estates with a live worker", async () => {
    process.env.URL = "https://portal.test";
    const e = await queueEstate(user);
    const other = await createUser("busy@example.com", "sufficiently-long-pass");
    const busy = await queueEstate(other);
    busy.worker_until = new Date(Date.now() + 600000).toISOString();
    await saveEstate(busy);
    const kicks: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => { kicks.push(JSON.parse(init.body)); return new Response("", { status: 202 }); }) as any;
    try {
      const res = await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }));
      const body = await res.json();
      expect(body.pending).toBe(1);
      expect(kicks).toEqual([{ user_id: e.user_id, action: "advance" }]);
      expect(body.outcomes).toEqual({ kicked: 1 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
