// A stopped machine is only durably stopped if the Fly proxy cannot start it again: stopMachine
// alone was seen live to be undone 3 s later by an inbound request (autostart=true). These tests
// run against a Fly model that simulates exactly that (ModelFly.ping).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { ModelFly, machinesApiHandler } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { FlyError, estateMachineConfig, flyConfig } from "../src/lib/fly";
import { MAX_SUSPEND_RETRIES, checkEstateHealth, getEstate, queueEstate, resumeEstate, saveEstate, suspendEstate, type Estate } from "../src/lib/estates";

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
    const r = await suspendEstate((await getEstate(other.id))!, b as any, new Date(), "x");
    expect(r.status).toBe("suspended");
  });

  it("resume turns autostart back ON before starting the machine; a failed restore does not start it or resume", async () => {
    await readyEstate();
    const fly = new ModelFly();
    await suspend(fly);
    fly.log.length = 0;
    fly.failUpdate = true;
    await expect(resumeEstate((await getEstate(user.id))!, fly as any)).rejects.toThrow();
    expect(fly.log).not.toContain("start m_1");
    expect((await getEstate(user.id))!.status).toBe("suspended");

    fly.failUpdate = false;
    fly.log.length = 0;
    const back = await resumeEstate((await getEstate(user.id))!, fly as any);
    expect(back.status).toBe("ready");
    const upd = fly.log.findIndex((l) => l.startsWith("update m_1 autostart=true"));
    const start = fly.log.findIndex((l) => l === "start m_1");
    expect(upd).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(upd);
    expect(fly.machine("m_1").config.services.every((s: any) => s.autostart === true)).toBe(true);
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
