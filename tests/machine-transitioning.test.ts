// For an owner who may not run the estate, nothing is written into a machine in a transient state (Fly does not document
// what an update with skip_launch does to one): the write is refused as retryable, 409 machine_transitioning.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshStore } from "./helpers";
import { createUser, saveUser, type User } from "../src/lib/users";
import { EstateError, TRANSIENT_MACHINE_STATES, machineRunning, queueEstate, saveEstate, updateMachineGuarded } from "../src/lib/estates";

const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };
let st: any;

beforeEach(() => {
  st = freshStore();
  Object.assign(process.env, FLY_ENV);
});
afterEach(() => {
  for (const k of Object.keys(FLY_ENV)) delete process.env[k];
});

async function estateFor(email: string, status: string) {
  const u: User = await createUser(email, "sufficiently-long-pass");
  const sub = "sub_" + email.split("@")[0];
  u.tier = "operator";
  u.billing = { customer_id: "cus_1", subscription_id: sub, status, price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" } as any;
  await saveUser(u);
  await st.setJSON("paid_subscriptions/" + sub, { customer: "cus_1", first_paid_invoice: "in_1", at: "2026-11-01T00:00:00Z" });
  const e = await queueEstate(u);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` });
  await saveEstate(e, undefined, { owns: ["status", "machine_id", "step"] });
  return e;
}

function fakeFly(state: string) {
  const writes: { skipLaunch: boolean }[] = [];
  return {
    writes,
    fly: {
      async getMachine() {
        return { id: "m_1", state, config: { image: "img" } };
      },
      async updateMachine(_a: string, _id: string, _cfg: any, opts: { skipLaunch?: boolean } = {}) {
        writes.push({ skipLaunch: opts.skipLaunch === true });
        return {};
      },
    } as any,
  };
}

describe("transient machine states", () => {
  it("the documented transient states never count as running", () => {
    for (const s of ["creating", "starting", "stopping", "suspending", "destroying", "updating", "replacing", "restarting", "launch_failed"]) {
      expect(TRANSIENT_MACHINE_STATES.has(s), s).toBe(true);
      expect(machineRunning({ state: s }), s).toBe(false);
    }
    expect(machineRunning({ state: "started" })).toBe(true);
    expect(machineRunning({ state: "stopped" })).toBe(false);
  });

  for (const state of ["creating", "starting", "stopping", "suspending", "destroying", "updating", "replacing", "restarting", "launch_failed"]) {
    it(`ineligible owner, machine ${state}: nothing is written; 409 machine_transitioning (retryable)`, async () => {
      const e = await estateFor(`t-${state}@example.com`, "past_due");
      const { fly, writes } = fakeFly(state);
      const err = await updateMachineGuarded(e, fly, () => ({ image: "new" }) as any).then(() => null, (x) => x);
      expect(err).toBeInstanceOf(EstateError);
      expect(err.status).toBe(409);
      expect(err.code).toBe("machine_transitioning");
      expect(writes).toEqual([]);
      expect((await st.list({ prefix: "ops/config_write/" })).blobs).toEqual([]); // no config-write mark either
    });
  }

  it("ineligible owner: a started machine is written with a launch; a stopped one with skip_launch", async () => {
    const a = await estateFor("run@example.com", "past_due");
    const r1 = fakeFly("started");
    expect(await updateMachineGuarded(a, r1.fly, () => ({ image: "new" }) as any)).toEqual({ launched: true });
    expect(r1.writes).toEqual([{ skipLaunch: false }]);
    const b = await estateFor("sleep@example.com", "past_due");
    const r2 = fakeFly("stopped");
    expect(await updateMachineGuarded(b, r2.fly, () => ({ image: "new" }) as any)).toEqual({ launched: false });
    expect(r2.writes).toEqual([{ skipLaunch: true }]);
  });

  it("an owner who may run the estate is written to in any state (unchanged behaviour)", async () => {
    const e = await estateFor("paid@example.com", "active");
    const { fly, writes } = fakeFly("replacing");
    expect(await updateMachineGuarded(e, fly, () => ({ image: "new" }) as any)).toEqual({ launched: true });
    expect(writes).toEqual([{ skipLaunch: false }]);
  });
});
