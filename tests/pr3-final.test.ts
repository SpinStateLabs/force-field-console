// Fifth review: wait for 'started' before the read-back, two agreeing reads, no Fly text for users
// (provisioning errors and the endpoint), survivors of earlier rounds, and the injected worker clock.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import estateHandler from "../netlify/functions/estate.mts";
import { FLY_LEAK_RE, ModelFly, flyErr } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, saveUser, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { FlyError } from "../src/lib/fly";
import {
  advanceEstate,
  WAIT_S,
  ensureMachineRunning,
  getEstate,
  publicEstate,
  queueEstate,
  readback,
  recordResumeFailure,
  resumeEstate,
  reviveEstate,
  saveEstate,
  suspendEstate,
  type Estate,
} from "../src/lib/estates";

const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };

/** Serves a pinned (stale) snapshot for `pinN` reads, after letting `pinSkip` genuine reads through. */
class Pinned extends ModelFly {
  pinned: any = null;
  pinN = 0;
  pinSkip = 0;
  async getMachine(a: string, id: string) {
    if (this.pinSkip > 0) {
      this.pinSkip -= 1;
    } else if (this.pinN > 0 && this.pinned) {
      this.pinN -= 1;
      this.log.push("get(stale) " + id);
      return structuredClone(this.pinned);
    }
    return super.getMachine(a, id);
  }
}

/** After `skip` genuine reads, serves the scripted snapshots in order (then genuine reads again). */
class Scripted extends ModelFly {
  skip = 1;
  queue: any[] = [];
  async getMachine(a: string, id: string) {
    if (this.skip > 0) {
      this.skip -= 1;
    } else if (this.queue.length) {
      this.log.push("get(scripted) " + id);
      return structuredClone(this.queue.shift());
    }
    return super.getMachine(a, id);
  }
}

let user: User;
let fly: Pinned;
const origDelay = readback.delayMs;
const origTries = readback.tries;
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, FLY_ENV);
  readback.delayMs = 5;
  user = await createUser("fin@example.com", "sufficiently-long-pass");
  fly = new Pinned();
});
afterEach(() => {
  readback.delayMs = origDelay;
  readback.tries = origTries;
  vi.restoreAllMocks();
  for (const k of Object.keys(FLY_ENV)) delete process.env[k];
});

async function estate(over: Partial<Estate> = {}) {
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` }, over);
  await saveEstate(e);
  fly.machine("m_1");
  return e;
}
const PENDING = { reason: "x", since: "2026-01-01T00:00:00.000Z", attempts: 1, last_error: "machine stop failed", next_retry_at: null, failed: false };
const stopQuietly = () => {
  const m = fly.machine("m_1");
  m.state = "stopped";
  m.config.services[0].autostart = false;
};

describe("MED: the start is accepted before the machine has booted", () => {
  it("resume of a machine that takes 300 ms to boot waits for 'started' before reading back (read-back alone spans only ~15 ms)", async () => {
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    stopQuietly();
    fly.bootMs = 300;
    const r = await resumeEstate((await getEstate(user.id))!, fly as any);
    expect(r.status).toBe("ready");
    expect(fly.machine("m_1").state).toBe("started");
    expect(fly.autostartOff("m_1")).toBe(true); // resume only starts: autostart stays off
    expect(fly.log).toContain("wait m_1 started");
  });

  it("revive of a flagged paying estate with a slow boot also succeeds", async () => {
    await estate({ suspend_pending: { ...PENDING } });
    stopQuietly();
    fly.bootMs = 300;
    await reviveEstate((await getEstate(user.id))!, fly as any);
    expect((await getEstate(user.id))!.suspend_pending ?? null).toBeNull();
    expect(fly.machine("m_1").state).toBe("started");
  });
});

describe("LOW: a failed start plus one stale 'started / autostart on' read-back must not pass", () => {
  it("revive: the start fails, the wait lies, the first read-back is a stale snapshot: the flag stays and the machine stays stopped", async () => {
    await estate({ suspend_pending: { ...PENDING } });
    const snapshot = structuredClone(fly.machine("m_1")); // started, autostart on
    stopQuietly();
    fly.pinned = snapshot;
    fly.pinSkip = 1; // the decision read is genuine
    fly.pinN = 1; // the first read-back read is stale
    fly.failStart = true;
    fly.waitLies = true;
    await expect(reviveEstate((await getEstate(user.id))!, fly as any)).rejects.toBeTruthy();
    expect((await getEstate(user.id))!.suspend_pending).toBeTruthy();
    expect(fly.machine("m_1").state).toBe("stopped");
  });

  it("revive: start fails and every read-back is stale: the (honest) wait refuses it", async () => {
    await estate({ suspend_pending: { ...PENDING } });
    const snapshot = structuredClone(fly.machine("m_1"));
    stopQuietly();
    fly.pinned = snapshot;
    fly.pinSkip = 1;
    fly.pinN = 6;
    fly.failStart = true;
    await expect(reviveEstate((await getEstate(user.id))!, fly as any)).rejects.toBeTruthy();
    expect((await getEstate(user.id))!.suspend_pending).toBeTruthy();
  });

  it("suspend: the stop does nothing, the wait lies, one stale 'stopped / autostart off' read-back: still not suspended", async () => {
    await estate();
    const stale = structuredClone(fly.machine("m_1"));
    stale.state = "stopped";
    stale.config.services[0].autostart = false;
    fly.pinned = stale;
    fly.pinSkip = 1;
    fly.pinN = 1;
    fly.stopNoop = true;
    fly.waitLies = true;
    const r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    expect(r.status).toBe("ready");
    expect(r.suspend_pending).toBeTruthy();
    expect(fly.machine("m_1").state).toBe("started");
  });
});

describe("ensureMachineRunning, deterministically", () => {
  it("the read-back is retried: one stale read after the start does not fail it (and needs more than one try)", async () => {
    await estate();
    stopQuietly();
    fly.pinned = structuredClone(fly.machine("m_1")); // stopped
    fly.pinSkip = 1; // the existence read is genuine
    fly.pinN = 1; // the first read-back read is the stale, pre-start snapshot
    expect(await ensureMachineRunning("a", fly as any, "m_1")).toBe("running");
    const afterStart = fly.log.slice(fly.log.indexOf("start m_1"));
    expect(afterStart.filter((l) => l.startsWith("get")).length).toBeGreaterThanOrEqual(3); // stale + two agreeing
  });

  it("a Fly 404 from the start means the machine is gone", async () => {
    await estate();
    stopQuietly();
    fly.failStartWith = new FlyError(404, "gone");
    fly.listMachines = async () => []; // gone: the app's machine list no longer carries it either (CX4)
    expect(await ensureMachineRunning("a", fly as any, "m_1")).toBe("gone");
  });

  it("only the start is issued: no config update, and autostart is left as it was", async () => {
    await estate();
    stopQuietly();
    expect(await ensureMachineRunning("a", fly as any, "m_1")).toBe("running");
    expect(fly.log.some((l) => l.startsWith("update"))).toBe(false);
    expect(fly.autostartOff("m_1")).toBe(true);
  });

  it("the wait for 'started' is bounded to WAIT_S seconds", async () => {
    await estate();
    stopQuietly();
    await ensureMachineRunning("a", fly as any, "m_1");
    expect(fly.waits.filter((w) => w.state === "started").map((w) => w.timeoutS)).toEqual([WAIT_S]);
  });
});

describe("the agree counter resets on every disagreement (good, bad, good must not add up to two)", () => {
  const snap = (state: string, autostart: boolean) => ({ id: "m_1", name: "estate", state, config: { image: "img", services: [{ internal_port: 8080, autostart }] } });

  it("quiesce: stopped / autostart off, then a machine that is NOT stopped, then stopped again: not accepted", async () => {
    await estate();
    readback.tries = 3;
    const s = new Scripted();
    s.machine("m_1");
    s.waitLies = true;
    s.queue = [snap("stopped", false), snap("started", false), snap("stopped", false)];
    await expect(suspendEstate({ ...(await getEstate(user.id))! }, s as any, new Date(), "canceled")).resolves.toMatchObject({ status: "ready" });
    expect((await getEstate(user.id))!.suspend_pending).toBeTruthy();
  });

  it("quiesce: a stopped machine whose autostart is still ON in the middle also resets it", async () => {
    await estate();
    readback.tries = 3;
    const s = new Scripted();
    s.machine("m_1");
    s.waitLies = true;
    s.queue = [snap("stopped", false), snap("stopped", true), snap("stopped", false)];
    await expect(suspendEstate({ ...(await getEstate(user.id))! }, s as any, new Date(), "canceled")).resolves.toMatchObject({ status: "ready" });
    expect((await getEstate(user.id))!.suspend_pending).toBeTruthy();
  });

  it("ensureMachineRunning: started, then NOT started, then started: not accepted; started, started: accepted", async () => {
    await estate();
    readback.tries = 3;
    const s = new Scripted();
    s.machine("m_1");
    s.queue = [snap("started", false), snap("stopped", false), snap("started", false)];
    await expect(ensureMachineRunning("a", s as any, "m_1")).rejects.toBeTruthy();
    const ok = new Scripted();
    ok.machine("m_1");
    ok.queue = [snap("started", false), snap("started", false)];
    expect(await ensureMachineRunning("a", ok as any, "m_1")).toBe("running");
  });

  it("the quiesce waits at most WAIT_S seconds for the stop", async () => {
    await estate();
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    expect(fly.waits.filter((w) => w.state === "stopped").map((w) => w.timeoutS)).toEqual([WAIT_S]);
  });
});

describe("no Fly text reaches users", () => {
  it("an unexpected (non-Fly, non-Estate) error in a provisioning step is stored as fixed generic text", async () => {
    user.tier = "operator";
    await saveUser(user);
    const e = await queueEstate(user);
    const bad: any = new Proxy({}, { get: () => async () => { throw new TypeError("cannot read properties of undefined (fo1_LEAKME0123456789abcdef) at /apps/ff-est-0123abcd/machines"); } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await advanceEstate(e, bad);
    const stored = (await getEstate(user.id))!;
    expect(stored.error).toBe("an unexpected error occurred; retrying");
    expect(JSON.stringify(stored)).not.toMatch(FLY_LEAK_RE);
  });

  it("a provisioning step failing with a realistic Fly error: publicEstate error, log and stored record are generic", async () => {
    user.tier = "operator";
    await saveUser(user);
    const e = await queueEstate(user);
    const bad: any = new Proxy({}, { get: () => async () => { throw flyErr(500, "x", "m_9"); } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await advanceEstate(e, bad);
    const stored = (await getEstate(user.id))!;
    expect(stored.error).toBeTruthy();
    expect(JSON.stringify(publicEstate(stored))).not.toMatch(FLY_LEAK_RE);
    expect(JSON.stringify(stored)).not.toMatch(FLY_LEAK_RE);
  });

  it("the estate endpoint answers a generic 502 for a Fly failure, keeping the detail in the server log", async () => {
    user.tier = "operator";
    await saveUser(user);
    await estate();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "could not reach https://api.machines.dev/v1/apps/ff-est-0123abcd (Bearer fo1_LEAKME0123456789abcdef rejected)" }), { status: 500 })) as any;
    try {
      const res = await estateHandler(
        new Request("http://portal.test/api/estate/anthropic-key", { method: "POST", headers: { cookie: sessionCookie(await issueSession(user.id)).split(";")[0] }, body: JSON.stringify({ key: "sk-ant-" + "a".repeat(40) }) }),
        {} as any,
      );
      const text = await res.text();
      expect(res.status).toBe(502);
      expect(text).not.toMatch(FLY_LEAK_RE);
      expect(logged.mock.calls.some((c) => /Fly request failed/.test(String(c[0])))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("the ALERT log lines carry the stable key and counters, never Fly text", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await estate({ status: "suspended", suspended_from: "ready" });
    for (let i = 0; i < 12; i++) await recordResumeFailure((await getEstate(user.id))!, new Date(Date.now() + i * 3_600_000), flyErr(503, "start", "m_1"));
    const other = await createUser("fin2@example.com", "sufficiently-long-pass");
    const e2 = await queueEstate(other);
    Object.assign(e2, { status: "ready", step: "done", machine_id: "m_2" });
    await saveEstate(e2);
    fly.failStop = true;
    for (let i = 0; i < 11; i++) await suspendEstate((await getEstate(other.id))!, fly as any, new Date(Date.now() + i * 3_600_000), "x");
    const alerts = spy.mock.calls.filter((c) => String(c[0]).startsWith("ALERT"));
    expect(alerts.length).toBe(2);
    for (const a of alerts) expect(a.map(String).join(" ")).not.toMatch(FLY_LEAK_RE);
  });
});
