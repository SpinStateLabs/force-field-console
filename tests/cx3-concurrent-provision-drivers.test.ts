// CX3 (concurrent-provision-drivers): two provisioning drivers (the scheduled tick and a dashboard
// POST /api/estate/advance) start the same step in the same instant from copies of the record that
// carry no lease. Both must not pass the step lease: before the fix both saved their own lease
// (saveEstate merges "mine wins"), both listed Fly (empty) and both created a machine / volume. After
// a cancel only the machine on the record was stopped; the orphan kept running with autostart on.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelFly } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { advanceEstate, getEstate, queueEstate, readback, saveEstate, suspendEstate, type Estate } from "../src/lib/estates";

// Fake, non-secret test values (the same shape the other estate tests use).
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fly with create calls that take time (as the real API does), so two drivers can both list "none" first. */
class CreatingFly extends ModelFly {
  createMs = 20;
  creates: string[] = [];
  volumes: { id: string; name: string }[] = [];
  private n = 0;
  async listVolumes(): Promise<any[]> {
    return this.volumes.map((v) => ({ ...v }));
  }
  async createVolume(_app: string, name: string): Promise<{ id: string }> {
    await sleep(this.createMs);
    const id = "vol_" + ++this.n;
    this.creates.push("volume " + id);
    this.volumes.push({ id, name });
    return { id };
  }
  async createMachine(_app: string, name: string, config: any): Promise<any> {
    await sleep(this.createMs);
    const id = "m" + ++this.n;
    this.creates.push("machine " + id);
    this.machines.set(id, { id, name, state: "started", config: structuredClone(config) });
    return { id, name, state: "started", config: structuredClone(config) };
  }
}

let user: User;
let fly: CreatingFly;
const origDelay = readback.delayMs;
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, FLY_ENV);
  readback.delayMs = 1;
  user = await createUser("cx3@example.com", "sufficiently-long-pass");
  fly = new CreatingFly();
});
afterEach(() => {
  readback.delayMs = origDelay;
  for (const k of Object.keys(FLY_ENV)) delete process.env[k];
});

async function atStep(step: Estate["step"], over: Partial<Estate> = {}): Promise<Estate> {
  const e = await queueEstate(user);
  Object.assign(e, { status: "provisioning", step, lease_until: null, ips: ["1.2.3.4"] }, over);
  await saveEstate(e);
  return e;
}

describe("CX3 concurrent provisioning drivers", () => {
  it("tick + dashboard advance at create_machine in the same instant create ONE machine; the cancel stops every machine", async () => {
    await atStep("create_machine", { volume_id: "vol_0" });
    // Both drivers read the record before either has written its lease.
    const tickCopy = (await getEstate(user.id))!;
    const dashCopy = (await getEstate(user.id))!;
    const [a, b] = await Promise.all([advanceEstate(tickCopy, fly as any), advanceEstate(dashCopy, fly as any)]);

    expect(fly.creates).toEqual(["machine m1"]);
    expect([...fly.machines.keys()]).toEqual(["m1"]);
    expect([a.outcome, b.outcome].sort()).toEqual(["progressed", "waiting"]);
    const stored = (await getEstate(user.id))!;
    expect(stored.machine_id).toBe("m1");
    expect(stored.step).toBe("wait_boot");
    expect(stored.lease_until).toBeNull();

    // Later cancel: every machine of the app is stopped with autostart off and the record reads suspended.
    const s = await suspendEstate(stored, fly as any, new Date(), "subscription canceled");
    expect(s.status).toBe("suspended");
    for (const m of fly.machines.values()) {
      expect(m.state).toBe("stopped");
      expect(fly.autostartOff(m.id)).toBe(true);
    }
  });

  it("tick + dashboard advance at create_volume in the same instant create ONE volume", async () => {
    await atStep("create_volume");
    const tickCopy = (await getEstate(user.id))!;
    const dashCopy = (await getEstate(user.id))!;
    await Promise.all([advanceEstate(tickCopy, fly as any), advanceEstate(dashCopy, fly as any)]);
    expect(fly.creates).toEqual(["volume vol_1"]);
    const stored = (await getEstate(user.id))!;
    expect(stored.volume_id).toBe("vol_1");
    expect(stored.step).toBe("set_base_secrets");
  });

  it("a driver whose copy predates a step another driver already completed does not re-run that step", async () => {
    await atStep("create_machine", { volume_id: "vol_0" });
    const stale = (await getEstate(user.id))!;
    const first = await advanceEstate((await getEstate(user.id))!, fly as any);
    expect(first.outcome).toBe("progressed");
    // The stale copy still says create_machine with no machine_id and no lease.
    const r = await advanceEstate(stale, fly as any);
    expect(r.outcome).toBe("waiting");
    expect(fly.creates).toEqual(["machine m1"]);
    const stored = (await getEstate(user.id))!;
    expect(stored.machine_id).toBe("m1");
    expect(stored.step).toBe("wait_boot");
  });

  it("the lease still expires: a driver whose predecessor died mid-step takes the step over", async () => {
    const t0 = new Date("2026-10-25T09:00:00Z");
    await atStep("create_machine", { volume_id: "vol_0", lease_until: new Date(t0.getTime() + 25_000).toISOString() });
    const held = await advanceEstate((await getEstate(user.id))!, fly as any, { now: new Date(t0.getTime() + 1_000) });
    expect(held.outcome).toBe("waiting");
    expect(fly.creates).toEqual([]);
    const later = await advanceEstate((await getEstate(user.id))!, fly as any, { now: new Date(t0.getTime() + 26_000) });
    expect(later.outcome).toBe("progressed");
    expect(fly.creates).toEqual(["machine m1"]);
  });

  it("a driver whose copy predates a pending suspension takes no lease and creates nothing (the lease's stored suspend_pending clause)", async () => {
    await atStep("create_machine", { volume_id: "vol_0" });
    const stale = (await getEstate(user.id))!;
    // A cancel lands while create_machine may be in flight: the STORED record now carries suspend_pending.
    const s = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "subscription canceled");
    expect(s.suspend_pending).toBeTruthy();
    expect(stale.suspend_pending).toBeFalsy();
    // The stale copy passes the copy-side checks; only the conditional lease write can stop it.
    const r = await advanceEstate(stale, fly as any);
    expect(r.outcome).toBe("waiting");
    expect(r.estate.suspend_pending).toBeTruthy();
    expect(fly.creates).toEqual([]);
    expect([...fly.machines.keys()]).toEqual([]);
    const stored = (await getEstate(user.id))!;
    expect(stored.suspend_pending).toBeTruthy();
    expect(stored.status).toBe("provisioning");
    expect(stored.step).toBe("create_machine");
    expect(stored.machine_id ?? null).toBeNull();
    expect(stored.lease_until ?? null).toBeNull();
  });
});
