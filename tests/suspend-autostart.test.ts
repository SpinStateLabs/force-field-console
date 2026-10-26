// A stopped machine is only durably stopped if the Fly proxy cannot start it again: stopMachine
// alone was seen live to be undone 3 s later by an inbound request (autostart=true). These tests
// run against a Fly model that simulates exactly that (ModelFly.ping).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { ModelFly, machinesApiHandler } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { FlyError, estateMachineConfig, flyConfig } from "../src/lib/fly";
import { MAX_SUSPEND_RETRIES, checkEstateHealth, configWriteMarks, getEstate, machineAwake, queueEstate, readback, resumeEstate, saveEstate, suspendEstate, updateMachineGuarded, type Estate } from "../src/lib/estates";
import { portalStore } from "../src/lib/store";

const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

let user: User;
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, FLY_ENV);
  user = await createUser("auto@example.com", "sufficiently-long-pass");
});
afterEach(() => {
  for (const k of Object.keys(FLY_ENV)) delete process.env[k];
  delete process.env.URL;
});

async function readyEstate(over: Partial<Estate> = {}) {
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` }, over);
  await saveEstate(e);
  return e;
}
const suspend = async (fly: ModelFly) => suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "subscription canceled");

describe("a suspended machine stays stopped when the proxy gets a request", () => {
  it("running machine with autostart on: after suspend, an inbound request does not start it", async () => {
    await readyEstate();
    const fly = new ModelFly();
    fly.machine("m_1", { state: "started", autostart: true });
    const r = await suspend(fly);
    expect(r.status).toBe("suspended");
    expect(fly.ping("m_1")).toBe("stopped");
    expect(fly.ping("m_1")).toBe("stopped");
  });

  it("autostart is switched off BEFORE the stop (no window where a stopped machine can be woken)", async () => {
    await readyEstate();
    const fly = new ModelFly();
    await suspend(fly);
    const upd = fly.log.findIndex((l) => l.startsWith("update m_1 autostart=false"));
    const stop = fly.log.findIndex((l) => l === "stop m_1");
    expect(upd).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(upd);
  });

  it("an already-stopped machine (autostart still on) is switched off without being launched, and not stopped again", async () => {
    await readyEstate();
    const fly = new ModelFly();
    fly.machine("m_1", { state: "stopped", autostart: true });
    const r = await suspend(fly);
    expect(r.status).toBe("suspended");
    expect(fly.log).toContain("update m_1 autostart=false skip=true");
    expect(fly.log).not.toContain("stop m_1");
    expect(fly.ping("m_1")).toBe("stopped");
  });

  it("is verified by a read-back: a 200 that did not apply the change keeps the suspension pending", async () => {
    await readyEstate();
    const fly = new ModelFly();
    fly.ignoreUpdate = true;
    const r = await suspend(fly);
    expect(r.status).toBe("ready");
    expect(r.suspend_pending).toBeTruthy();
    expect(r.health?.note).toMatch(/suspend pending/);
  });

  it("a failing config update keeps the suspension pending (no stop attempted, gateway refuses), bounded by the retry cap", async () => {
    await readyEstate();
    const fly = new ModelFly();
    fly.failUpdate = true;
    let r = await suspend(fly);
    expect(r.status).toBe("ready");
    expect(r.suspend_pending!.attempts).toBe(1);
    expect(fly.log).not.toContain("stop m_1");
    for (let i = 1; i < MAX_SUSPEND_RETRIES; i++) r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(Date.now() + i * 3_600_000), "retry");
    expect(r.suspend_pending!.failed).toBe(true);
    expect(r.status).toBe("ready");
    fly.failUpdate = false;
    r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "operator retry");
    expect(r.status).toBe("suspended");
    expect(fly.ping("m_1")).toBe("stopped");
  });

  it("a stop that never reaches 'stopped' keeps the suspension pending", async () => {
    await readyEstate();
    const fly = new ModelFly();
    fly.waitNever = true;
    const r = await suspend(fly);
    expect(r.status).toBe("ready");
    expect(r.suspend_pending).toBeTruthy();
  });

  it("the read-back catches a machine that is still running although stop and wait said OK", async () => {
    await readyEstate();
    const fly = new ModelFly();
    fly.stopNoop = true;
    fly.waitLies = true;
    const r = await suspend(fly);
    expect(r.status).toBe("ready");
    expect(r.suspend_pending).toBeTruthy();
  });

  it("a Fly 404 (machine gone) counts as stopped, whether the read or the update reports it", async () => {
    await readyEstate();
    const a = new ModelFly();
    a.getReturnsNull = true;
    expect((await suspend(a)).status).toBe("suspended");

    const other = await createUser("auto2@example.com", "sufficiently-long-pass");
    const e = await queueEstate(other);
    Object.assign(e, { status: "ready", step: "done", machine_id: "m_2" });
    await saveEstate(e);
    const b = new ModelFly();
    b.updateThrows404 = true;
    b.listMachines = async () => []; // gone: the app's machine list no longer carries it either (CX4)
    const r = await suspendEstate((await getEstate(other.id))!, b as any, new Date(), "x");
    expect(r.status).toBe("suspended");
  });

  it("resume only starts the machine (no config update); a failed start leaves it suspended, stopped, autostart off", async () => {
    await readyEstate();
    const fly = new ModelFly();
    await suspend(fly);
    fly.log.length = 0;
    fly.failStart = true;
    await expect(resumeEstate((await getEstate(user.id))!, fly as any)).rejects.toThrow();
    expect((await getEstate(user.id))!.status).toBe("suspended");
    expect(fly.machine("m_1").state).toBe("stopped");
    expect(fly.autostartOff("m_1")).toBe(true);

    fly.failStart = false;
    fly.log.length = 0;
    const back = await resumeEstate((await getEstate(user.id))!, fly as any);
    expect(back.status).toBe("ready");
    expect(fly.log.filter((l) => l.startsWith("update"))).toEqual([]);
    expect(fly.log).toContain("start m_1");
    expect(fly.machine("m_1").state).toBe("started");
  });
});

describe("provisioning creates machines with the proxy fields explicit", () => {
  it("every service sets autostart=true, autostop=off and min_machines_running=1, in both postures", () => {
    const cfg = flyConfig()!;
    for (const posture of ["boot", "armed"] as const) {
      const c = estateMachineConfig(cfg, "vol_1", posture, "signer");
      expect(c.services!.length).toBeGreaterThan(0);
      for (const s of c.services!) {
        expect(s.autostart).toBe(true);
        expect(s.autostop).toBe("off");
        expect(s.min_machines_running).toBe(1);
      }
    }
  });
});

describe("the tick never looks at a suspended estate through the proxy URL", () => {
  it("makes no request to the estate origin or its Fly app, and checkEstateHealth skips it", async () => {
    process.env.URL = "https://portal.test";
    const e = await readyEstate();
    const fly = new ModelFly();
    await suspend(fly);
    const seen: string[] = [];
    const api = machinesApiHandler(fly);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      seen.push(String(url));
      return (await api(String(url), init)) ?? new Response("", { status: 404 });
    }) as any;
    try {
      const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(body.outcomes).toEqual({});
      const stored = (await getEstate(user.id))!;
      expect(await checkEstateHealth(stored, { getApp: async () => seen.push("getApp") } as any, { fetchImpl: (async (u: any) => (seen.push(String(u)), new Response("{}", { status: 200 }))) as any })).toBe("skipped");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen.filter((u) => u.includes(e.app) || u === "getApp")).toEqual([]);
    expect(fly.ping("m_1")).toBe("stopped");
  });
});

// The production case of the guard above (PL-PR7-R1-01): every armed estate carries a config-write mark
// (ops/config_write/<user>, written by every guarded machine-config write and never deleted while ready).
// After a real suspension the tick reads such an estate once per tick through the Machines API (never the
// proxy URL) until the mark is at least CONFIG_WRITE_SETTLE_MS (30 min) old and the machine was found quiet.
describe("a suspended estate with a config-write mark: the tick reads it through the Machines API only, until the write has settled", () => {
  const origDelay = readback.delayMs;
  beforeEach(() => {
    readback.delayMs = 1;
  });
  afterEach(() => {
    readback.delayMs = origDelay;
  });

  /** One tick with the real FlyClient's HTTP calls answered by the Fly model; every URL is recorded. */
  async function tick(fly: ModelFly, seen: string[]): Promise<Record<string, number>> {
    const api = machinesApiHandler(fly);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      seen.push(String(url));
      return (await api(String(url), init)) ?? new Response("", { status: 404 });
    }) as any;
    try {
      return (await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json()).outcomes;
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  const notMachinesApi = (seen: string[]) => seen.filter((u) => new URL(u).hostname !== "api.machines.dev");

  /** A ready estate that had a guarded config write (the mark), then a real suspension; the Fly log is reset. */
  async function markedSuspended(): Promise<{ e: Estate; fly: ModelFly }> {
    process.env.URL = "https://portal.test";
    const e = await readyEstate();
    const fly = new ModelFly();
    await updateMachineGuarded(e, fly as any, (cur) => cur ?? { image: "img", services: [{ internal_port: 8080, autostart: true }] } as any, { readCurrent: true });
    expect((await configWriteMarks()).has(user.id)).toBe(true);
    const s = await suspend(fly);
    expect(s.status).toBe("suspended");
    expect(fly.ping("m_1")).toBe("stopped");
    fly.log.length = 0;
    return { e, fly };
  }

  it("fresh mark: one Machines-API read, zero origin requests, the mark is kept and the machine stays stopped", async () => {
    const { fly } = await markedSuspended();
    const seen: string[] = [];
    expect(await tick(fly, seen)).toEqual({ suspend_retry_ok: 1 });
    expect(fly.log).toEqual(["get m_1"]);
    expect(notMachinesApi(seen)).toEqual([]);
    expect((await configWriteMarks()).has(user.id)).toBe(true);
    const stored = (await getEstate(user.id))!;
    expect(stored.status).toBe("suspended");
    expect(stored.suspend_pending).toBeFalsy();
    expect(fly.ping("m_1")).toBe("stopped");
  });

  it("mark older than 30 min: read once, the mark is deleted, and the next tick makes no Fly call at all", async () => {
    const { fly } = await markedSuspended();
    await (await portalStore()).setJSON("ops/config_write/" + user.id, { at: new Date(Date.now() - 31 * 60_000).toISOString() });
    const seen: string[] = [];
    expect(await tick(fly, seen)).toEqual({ suspend_retry_ok: 1 });
    expect(fly.log).toEqual(["get m_1"]);
    expect(notMachinesApi(seen)).toEqual([]);
    expect((await configWriteMarks()).has(user.id)).toBe(false);

    fly.log.length = 0;
    const seen2: string[] = [];
    expect(await tick(fly, seen2)).toEqual({});
    expect(fly.log).toEqual([]);
    expect(seen2).toEqual([]);
    expect(fly.ping("m_1")).toBe("stopped");
  });

  it("a late autostart-on write that landed after the suspension is quieted again on the next tick", async () => {
    const { fly } = await markedSuspended();
    // Fly applies the abandoned guarded update late: the stopped machine's proxy autostart is back on.
    fly.machine("m_1").config.services[0].autostart = true;
    const seen: string[] = [];
    expect(await tick(fly, seen)).toEqual({ suspend_retry_ok: 1 });
    expect(fly.log).toContain("update m_1 autostart=false skip=true");
    expect(fly.log).not.toContain("stop m_1");
    expect(fly.log.filter((l) => l === "get m_1").length).toBeGreaterThanOrEqual(4); // re-verify, quiesce read, two read-backs
    expect(notMachinesApi(seen)).toEqual([]);
    expect(fly.ping("m_1")).toBe("stopped");
    const stored = (await getEstate(user.id))!;
    expect(stored.status).toBe("suspended");
    expect(stored.suspend_pending).toBeFalsy();
  });
});

const suspendedRecord = { status: "suspended" as const, suspended_from: "ready" as const, suspended_at: new Date().toISOString() };

// PL-PR7-R1-03: quiesceMachine treats a machine whose config cannot be read as an error; the re-check behind a
// suspended record must not treat the same machine as quiet (fail-open).
describe("a stopped machine whose config cannot be read is not trusted behind a suspended record", () => {
  it("machineAwake: stopped with no readable config counts as awake; stopped with every autostart off is quiet", () => {
    expect(machineAwake({ state: "stopped", config: null })).toBe(true);
    expect(machineAwake({ state: "stopped" })).toBe(true);
    expect(machineAwake({ state: "stopped", config: { image: "img", services: [{ internal_port: 8080, autostart: false }] } as any })).toBe(false);
    expect(machineAwake({ state: "destroyed", config: null })).toBe(false);
    expect(machineAwake(null)).toBe(false);
  });

  it("the re-verify goes pending (gateway refuses, the tick retries) instead of trusting the record; no config write, no stop", async () => {
    await readyEstate(suspendedRecord);
    const fly = new ModelFly();
    fly.machine("m_1", { state: "stopped" }).config = null;
    const r = await suspend(fly);
    expect(r.status).toBe("suspended");
    expect(r.suspend_pending).toBeTruthy();
    expect(r.suspend_pending!.attempts).toBe(1);
    expect(r.health?.note).toMatch(/suspend pending/);
    expect(fly.log.filter((l) => l.startsWith("update") || l.startsWith("stop"))).toEqual([]);
    expect(r.log.some((l) => /the machine config could not be read/.test(l.note))).toBe(true);
    expect((await getEstate(user.id))!.suspend_pending).toBeTruthy();
  });
});

// PL-PR8-R4-04: a transient state (starting / replacing) behind a suspended record is awake: quieted (stop with
// read-back), never trusted as quiet and never taken as "gone".
describe("a transient machine state behind a suspended record is quieted, not trusted and not taken as gone", () => {
  const origDelay = readback.delayMs;
  beforeEach(() => {
    readback.delayMs = 1;
  });
  afterEach(() => {
    readback.delayMs = origDelay;
  });

  it.each(["starting", "replacing"])("state %s: the re-verify stops the machine and keeps the record suspended", async (state) => {
    await readyEstate(suspendedRecord);
    const fly = new ModelFly();
    fly.machine("m_1", { state, autostart: false });
    (fly as any).bootAt = Date.now() + 3_600_000; // the model would otherwise finish a "starting" boot on the first read
    const r = await suspend(fly);
    expect(r.status).toBe("suspended");
    expect(r.suspend_pending).toBeFalsy();
    expect(fly.log[0]).toBe("get m_1");
    expect(fly.log).toContain("stop m_1");
    expect(fly.machine("m_1").state).toBe("stopped");
    expect(r.log.some((l) => /stopped with proxy autostart disabled \(verified by read-back\)/.test(l.note))).toBe(true);
    expect(r.log.some((l) => /already gone/.test(l.note))).toBe(false);
    expect(fly.ping("m_1")).toBe("stopped");
  });
});
