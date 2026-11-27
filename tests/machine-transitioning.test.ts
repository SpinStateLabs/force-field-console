// For an owner who may not run the estate, nothing is written into a machine in a transient state (Fly does not document
// what an update with skip_launch does to one): the write is refused as retryable, 409 machine_transitioning.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { freshStore } from "./helpers";
import { createUser, saveUser, type User } from "../src/lib/users";
import { EstateError, MAX_ATTEMPTS, TRANSIENT_MACHINE_STATES, TRANSITIONING_WAIT_MS, advanceEstate, autoRetryFailedEstate, getEstate, machineRunning, queueEstate, resumeEstate, retryEstate, saveEstate, suspendEstate, setEstateAnthropicKey, updateMachineGuarded, upgradeEstateImage } from "../src/lib/estates";
import { emailKey } from "../src/lib/users";

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
  await saveEstate(e); // whole-record write: every field persists (an owned write keeps only the named fields)
  return e;
}

function fakeFly(state: string | string[]) {
  const writes: { skipLaunch: boolean }[] = [];
  const secrets: string[] = [];
  const states = Array.isArray(state) ? [...state] : [state];
  return {
    writes,
    secrets,
    fly: {
      async getMachine() {
        const s = states.length > 1 ? states.shift()! : states[0];
        return { id: "m_1", state: s, config: { image: "img" } };
      },
      async setSecrets(_app: string, kv: Record<string, string>) {
        secrets.push(...Object.keys(kv));
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
    for (const s of ["creating", "starting", "stopping", "suspending", "destroying", "updating", "replacing", "restarting"]) {
      expect(TRANSIENT_MACHINE_STATES.has(s), s).toBe(true);
      expect(machineRunning({ state: s }), s).toBe(false);
    }
    expect(machineRunning({ state: "started" })).toBe(true);
    expect(TRANSIENT_MACHINE_STATES.has("launch_failed")).toBe(false); // a failed start, not a passing state
    expect(machineRunning({ state: "launch_failed" })).toBe(false);
    expect(machineRunning({ state: "stopped" })).toBe(false);
  });

  for (const state of ["creating", "starting", "stopping", "suspending", "destroying", "updating", "replacing", "restarting"]) {
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
  it("a provisioning step that meets a transient machine waits: no attempt spent, the step stays", async () => {
    const e = await estateFor("armwait@example.com", "active");
    Object.assign(e, { status: "provisioning", step: "arm", attempts: 0 });
    await saveEstate(e);
    // the owner qualifies at the provisioning gate, then stops qualifying before the arm write (a race)
    const key = emailKey("armwait@example.com");
    const realGet = st.get.bind(st);
    let reads = 0;
    st.get = async (k: string, o: any) => {
      const v = await realGet(k, o);
      if (k === key && v && ++reads > 1) return { ...v, billing: { ...v.billing, status: "past_due" } };
      return v;
    };
    const { fly, writes } = fakeFly("replacing");
    const r = await advanceEstate((await getEstate(e.user_id))!, fly);
    expect(r.outcome).toBe("waiting");
    expect(writes).toEqual([]);
    const after = (await getEstate(e.user_id))!;
    expect(after.attempts).toBe(0);
    expect(after.step).toBe("arm");
    expect(after.status).toBe("provisioning");
  });
  it("ineligible owner, machine launch_failed: not transient; written with skip_launch, as for any machine not running", async () => {
    const e = await estateFor("lf@example.com", "past_due");
    const { fly, writes } = fakeFly("launch_failed");
    expect(await updateMachineGuarded(e, fly, () => ({ image: "new" }) as any)).toEqual({ launched: false });
    expect(writes).toEqual([{ skipLaunch: true }]);
  });

  async function armWaiting(email: string, sinceMsAgo: number | null) {
    const e = await estateFor(email, "active");
    Object.assign(e, { status: "provisioning", step: "arm", attempts: 0, transitioning_since: sinceMsAgo === null ? null : new Date(Date.now() - sinceMsAgo).toISOString() });
    await saveEstate(e);
    const key = emailKey(email);
    const realGet = st.get.bind(st);
    let reads = 0;
    st.get = async (k: string, o: any) => {
      const v = await realGet(k, o);
      if (k === key && v && ++reads > 1) return { ...v, billing: { ...v.billing, status: "past_due" } };
      return v;
    };
    return e;
  }

  it("the wait is bounded: under 30 minutes it waits (no attempt), the marker is set once", async () => {
    const e = await armWaiting("under@example.com", 10 * 60_000);
    const before = (await getEstate(e.user_id))!.transitioning_since;
    const r = await advanceEstate((await getEstate(e.user_id))!, fakeFly("replacing").fly);
    expect(r.outcome).toBe("waiting");
    const after = (await getEstate(e.user_id))!;
    expect(after.attempts).toBe(0);
    expect(after.transitioning_since).toBe(before); // not moved forward
  });

  it("the wait is bounded: past 30 minutes the step is an ordinary failed attempt (counted, error text)", async () => {
    const e = await armWaiting("over@example.com", TRANSITIONING_WAIT_MS + 60_000);
    const r = await advanceEstate((await getEstate(e.user_id))!, fakeFly("replacing").fly);
    expect(r.outcome).toBe("error");
    const after = (await getEstate(e.user_id))!;
    expect(after.attempts).toBe(1);
    expect(after.error).toMatch(/changing state/);
  });

  /** A record that gave up after a timed-out wait: error state, attempts exhausted, marker 40 minutes old. */
  async function failedAfterWait(email: string) {
    const e = await estateFor(email, "active");
    Object.assign(e, {
      status: "error", step: "arm", attempts: MAX_ATTEMPTS, error: "the machine is changing state",
      transitioning_since: new Date(Date.now() - (TRANSITIONING_WAIT_MS + 10 * 60_000)).toISOString(),
      provision_retry: { count: 0, next_retry_at: new Date(Date.now() - 1000).toISOString() },
    });
    await saveEstate(e);
    return e;
  }

  /** The owner qualifies at the provisioning gate, then stops qualifying before the write (as in armWaiting). */
  function raceToIneligible(email: string) {
    const key = emailKey(email);
    const realGet = st.get.bind(st);
    let reads = 0;
    st.get = async (k: string, o: any) => {
      const v = await realGet(k, o);
      if (k === key && v && ++reads > 1) return { ...v, billing: { ...v.billing, status: "past_due" } };
      return v;
    };
  }

  for (const [name, retry] of [
    ["the owner's retry (retryEstate)", async (e: any) => { await retryEstate(e); }],
    ["the tick's automatic retry (autoRetryFailedEstate)", async (e: any) => { expect(await autoRetryFailedEstate(e)).toBe(true); }],
  ] as const) {
    it(`${name} starts a fresh wait: the old marker is cleared and a transient machine is waited on, not counted`, async () => {
      const email = name.startsWith("the owner") ? "retrywait@example.com" : "autowait@example.com";
      const e = await failedAfterWait(email);
      await retry((await getEstate(e.user_id))!);
      const reset = (await getEstate(e.user_id))!;
      expect(reset.status).toBe("provisioning");
      expect(reset.transitioning_since ?? null).toBeNull();
      raceToIneligible(email);
      const t0 = Date.now();
      const r = await advanceEstate((await getEstate(e.user_id))!, fakeFly("replacing").fly);
      expect(r.outcome).toBe("waiting");
      const after = (await getEstate(e.user_id))!;
      expect(after.attempts).toBe(0);
      expect(new Date(after.transitioning_since!).getTime()).toBeGreaterThanOrEqual(t0 - 1000); // a new marker, from now
    });
  }

  it("a suspension clears the marker (the suspend write owns it)", async () => {
    const e = await estateFor("suspwait@example.com", "active");
    Object.assign(e, { status: "provisioning", step: "arm", attempts: 0, transitioning_since: new Date(Date.now() - 20 * 60_000).toISOString() });
    await saveEstate(e);
    await suspendEstate((await getEstate(e.user_id))!, null, new Date(), "subscription canceled");
    const after = (await getEstate(e.user_id))!;
    expect(after.status).toBe("suspended");
    expect(after.suspended_from).toBe("provisioning");
    expect(after.transitioning_since ?? null).toBeNull();
  });

  it("a resume clears the marker, so the resumed step starts a fresh wait (the resume write owns it)", async () => {
    const e = await estateFor("reswait@example.com", "active");
    Object.assign(e, {
      status: "suspended", suspended_from: "provisioning", suspended_at: new Date().toISOString(), step: "arm", attempts: 0,
      transitioning_since: new Date(Date.now() - (TRANSITIONING_WAIT_MS + 10 * 60_000)).toISOString(),
    });
    await saveEstate(e);
    await resumeEstate((await getEstate(e.user_id))!, null);
    const resumed = (await getEstate(e.user_id))!;
    expect(resumed.status).toBe("provisioning");
    expect(resumed.transitioning_since ?? null).toBeNull();
    raceToIneligible("reswait@example.com");
    const r = await advanceEstate((await getEstate(e.user_id))!, fakeFly("replacing").fly);
    expect(r.outcome).toBe("waiting"); // a fresh wait, not an attempt counted at once against the old marker
    expect((await getEstate(e.user_id))!.attempts).toBe(0);
  });

  it("the marker is cleared when the machine has settled and the step runs", async () => {
    const e = await estateFor("settled@example.com", "active");
    Object.assign(e, { status: "provisioning", step: "arm", attempts: 0, transitioning_since: new Date(Date.now() - 5 * 60_000).toISOString() });
    await saveEstate(e);
    const { fly } = fakeFly("started");
    (fly as any).getMachine = async () => ({ id: "m_1", state: "started", config: { image: "img" } });
    const noNet: any = async () => new Response("{}", { status: 503 });
    const r = await advanceEstate((await getEstate(e.user_id))!, fly, { fetchImpl: noNet });
    expect(r.outcome).not.toBe("waiting");
    expect((await getEstate(e.user_id))!.transitioning_since ?? null).toBeNull();
  });

  it("upgrade: a machine that starts changing state inside the lock defers the upgrade; it is not a failed rollout", async () => {
    const e = await estateFor("upg@example.com", "past_due");
    Object.assign(e, { image: "registry.fly.io/x:old" });
    await saveEstate(e);
    const { fly, writes } = fakeFly(["started", "replacing"]); // the pre-check sees started; the lock sees replacing
    const r = await upgradeEstateImage((await getEstate(e.user_id))!, fly);
    expect(r.outcome).toBe("unchanged");
    expect(writes).toEqual([]);
    const after = (await getEstate(e.user_id))!;
    expect(after.upgrade_deferred?.image).toBe("registry.fly.io/x:y");
    expect(after.upgrade_failed_image ?? null).toBeNull();
  });

  it("key placement: a transitioning machine of an ineligible owner refuses BEFORE the secret is written", async () => {
    const e = await estateFor("key@example.com", "past_due");
    const { fly, secrets, writes } = fakeFly("restarting");
    const err = await setEstateAnthropicKey((await getEstate(e.user_id))!, fly, "sk-ant-api03-" + "a".repeat(90)).then(() => null, (x) => x);
    expect(err).toBeInstanceOf(EstateError);
    expect(err.code).toBe("machine_transitioning");
    expect(secrets).toEqual([]);
    expect(writes).toEqual([]);
  });
});
