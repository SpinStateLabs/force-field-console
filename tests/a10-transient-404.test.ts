// CX4 (group a10-transient-404, found by the lifecycle model's fuzzer): assumption A10 says a Fly 404 for a
// machine means the machine is gone. It is unverified. When a single 404 is answered for a LIVE machine:
//  - during a cancel's quiesce the estate was marked suspended without a stop or an autostart-off write,
//    so the machine kept running (and billing) with autostart on;
//  - during a resume / revive the paying estate went to machine_missing with machine_id nulled, so the
//    still-running machine was orphaned (a later cancel never stops it).
// A 404 must be confirmed (the app's machine list must not carry the machine) before it counts as gone.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelFly } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { FlyError } from "../src/lib/fly";
import { ensureMachineRunning, getEstate, queueEstate, quiesceMachine, resumeEstate, reviveEstate, saveEstate, suspendEstate, type Estate } from "../src/lib/estates";

const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

/** Fly answers 404 for the next `n404` reads of a machine that is still there (A10 false). */
class Transient404Fly extends ModelFly {
  n404 = 0;
  async getMachine(app: string, id: string): Promise<any> {
    if (this.n404 > 0 && this.machines.get(id)) {
      this.n404 -= 1;
      this.log.push("get " + id + " -> 404");
      return null;
    }
    return super.getMachine(app, id);
  }
}

let user: User;
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, FLY_ENV);
  user = await createUser("a10@example.com", "sufficiently-long-pass");
});
afterEach(() => {
  for (const k of Object.keys(FLY_ENV)) delete process.env[k];
});

async function estate(over: Partial<Estate> = {}) {
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` }, over);
  await saveEstate(e);
  return e;
}

describe("CX4: a transient Fly 404 for a live machine is not 'gone'", () => {
  it("cancel: one spurious 404 does not mark the estate suspended while the machine runs with autostart on", async () => {
    await estate();
    const fly = new Transient404Fly();
    fly.machine("m_1", { state: "started", autostart: true });
    fly.n404 = 1;
    const r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "subscription canceled");
    const stored = (await getEstate(user.id))!;
    const quiet = fly.machine("m_1").state === "stopped" && fly.autostartOff("m_1");
    // Invariant S1: a record that reads suspended has a stopped machine with autostart off.
    if (stored.status === "suspended" && !stored.suspend_pending) expect(quiet).toBe(true);
    else expect(stored.suspend_pending).toBeTruthy(); // otherwise the stop stays pending for the tick
    expect(stored.machine_id).toBe("m_1");
    expect(fly.ping("m_1") === "stopped" || Boolean(stored.suspend_pending)).toBe(true);
    // The tick's retry (no fault now) completes the suspension.
    await suspendEstate(r, fly as any, new Date(), "subscription canceled", { requirePending: true });
    const done = (await getEstate(user.id))!;
    expect(done.status).toBe("suspended");
    expect(fly.machine("m_1").state).toBe("stopped");
    expect(fly.autostartOff("m_1")).toBe(true);
    expect(fly.ping("m_1")).toBe("stopped");
  });

  it("a 404 from the stop of a machine that is still listed does not count as stopped", async () => {
    const fly = new Transient404Fly();
    fly.machine("m_1", { state: "started", autostart: true });
    fly.failStopWith = new FlyError(404, "gone");
    await expect(quiesceMachine("a", fly as any, "m_1")).rejects.toThrow();
    expect(fly.machine("m_1").state).toBe("started");
  });

  it("resume: one spurious 404 does not put a paying estate into machine_missing nor null its machine_id", async () => {
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: new Date().toISOString() });
    const fly = new Transient404Fly();
    fly.machine("m_1", { state: "stopped", autostart: false });
    fly.n404 = 1;
    await resumeEstate((await getEstate(user.id))!, fly as any).catch(() => undefined);
    const stored = (await getEstate(user.id))!;
    expect(stored.status).not.toBe("error");
    expect(stored.error ?? "").not.toMatch(/machine_missing/);
    expect(stored.machine_id).toBe("m_1");
  });

  it("revive: one spurious 404 does not put a flagged paying estate into machine_missing", async () => {
    await estate({ resume_pending: { since: new Date().toISOString(), attempts: 0, last_error: "", next_retry_at: null, failed: false } });
    const fly = new Transient404Fly();
    fly.machine("m_1", { state: "started", autostart: true });
    fly.n404 = 1;
    await reviveEstate((await getEstate(user.id))!, fly as any).catch(() => undefined);
    const stored = (await getEstate(user.id))!;
    expect(stored.error ?? "").not.toMatch(/machine_missing/);
    expect(stored.machine_id).toBe("m_1");
  });

  it("ensureMachineRunning: a 404 from the start of a machine that is still listed is not 'gone'", async () => {
    const fly = new Transient404Fly();
    fly.machine("m_1", { state: "stopped" });
    fly.failStartWith = new FlyError(404, "gone");
    await expect(ensureMachineRunning("a", fly as any, "m_1")).rejects.toThrow();
  });

  it("a machine that really is gone (404 and not listed) still counts as gone", async () => {
    const fly = new Transient404Fly();
    fly.getReturnsNull = true;
    expect(await quiesceMachine("a", fly as any, "m_9")).toBe("gone");
    expect(await ensureMachineRunning("a", fly as any, "m_9")).toBe("gone");
  });
});
