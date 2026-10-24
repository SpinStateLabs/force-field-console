// Fourth review: error text never reaches users (with a realistic Fly error), retries are bounded,
// the machine-missing branch of revive, stale bookkeeping after a resume, isGrantingUser, outcome labels,
// and the alert hook lines.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import tickHandler from "../netlify/functions/estate-tick.mts";
import healthHandler from "../netlify/functions/health.mts";
import { FLY_LEAK_RE, ModelFly, machinesApiHandler } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, saveUser, type User } from "../src/lib/users";
import { isGrantingUser, retryPendingSuspend } from "../src/lib/billing";
import {
  MAX_RESUME_RETRIES,
  MAX_SLOW_RETRIES,
  MAX_SUSPEND_RETRIES,
  getEstate,
  publicEstate,
  queueEstate,
  readback,
  recordResumeFailure,
  resumeEstate,
  retryDue,
  reviveEstate,
  saveEstate,
  suspendEstate,
  type Estate,
} from "../src/lib/estates";

const ctx = {} as any;
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };
let user: User;
let fly: ModelFly;
const origDelay = readback.delayMs;

beforeEach(async () => {
  freshStore();
  Object.assign(process.env, FLY_ENV);
  readback.delayMs = 2;
  user = await createUser("gap@example.com", "sufficiently-long-pass");
  fly = new ModelFly();
});
afterEach(() => {
  readback.delayMs = origDelay;
  vi.restoreAllMocks();
  for (const k of Object.keys(FLY_ENV)) delete process.env[k];
});

async function paying(status = "active", tier: "operator" | "sandbox" = "operator") {
  user.tier = tier;
  user.billing = { customer_id: "cus_1", subscription_id: "sub_A", status, price_id: "price_op", tier, current_period_end: null, updated_at: "t" };
  await saveUser(user);
}
async function estate(over: Partial<Estate> = {}) {
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` }, over);
  await saveEstate(e);
  fly.machine("m_1");
  return e;
}
/** The machine as a cancelled estate leaves it: stopped, proxy autostart off. */
const stopMachineQuietly = () => {
  const m = fly.machine("m_1");
  m.state = "stopped";
  m.config.services[0].autostart = false;
};
const PENDING = { reason: "x", since: "2026-01-01T00:00:00.000Z", attempts: 1, last_error: "machine stop failed", next_retry_at: null, failed: false };
async function tick() {
  const api = machinesApiHandler(fly);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => (await api(String(url), init)) ?? new Response("", { status: 404 })) as any;
  try {
    return await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
  } finally {
    globalThis.fetch = realFetch;
  }
}
const expectNoLeak = async () => {
  const stored = (await getEstate(user.id))!;
  for (const text of [JSON.stringify(stored), JSON.stringify(publicEstate(stored)), JSON.stringify(await (await healthHandler(new Request("http://portal.test/api/health"), ctx)).json())]) {
    expect(text).not.toMatch(FLY_LEAK_RE);
  }
};

describe("no Fly error text reaches users, with a realistic Fly error (app name, machine id, URL, bearer token, status)", () => {
  it("a failing suspend", async () => {
    await estate();
    fly.failStop = true;
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    expect((await getEstate(user.id))!.suspend_pending).toBeTruthy();
    await expectNoLeak();
  });

  it("a failing resume recorded by the tick, including after the retry cap", async () => {
    await paying();
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    stopMachineQuietly();
    fly.failStart = true;
    await tick();
    expect((await getEstate(user.id))!.resume_pending).toBeTruthy();
    await expectNoLeak();
    for (let i = 1; i <= MAX_RESUME_RETRIES + 1; i++) await retryPendingSuspend(user.id, fly as any, new Date(Date.now() + i * 3_600_000));
    expect((await getEstate(user.id))!.resume_pending!.failed).toBe(true);
    await expectNoLeak();
  });

  it("a failing revive of a flagged paying estate", async () => {
    await paying();
    await estate({ suspend_pending: { ...PENDING } });
    stopMachineQuietly();
    fly.failStart = true;
    await tick();
    await expectNoLeak();
  });
});

describe("retries are bounded: fast, then a capped number of slow ones, then none", () => {
  it("a failing suspend stops being retried after MAX_SUSPEND_RETRIES + MAX_SLOW_RETRIES attempts", async () => {
    await estate();
    fly.failStop = true;
    const total = MAX_SUSPEND_RETRIES + MAX_SLOW_RETRIES;
    let r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    for (let i = 1; i < total; i++) {
      if (i >= MAX_SUSPEND_RETRIES) {
        expect(r.suspend_pending!.failed).toBe(true);
        expect(r.suspend_pending!.next_retry_at).toBeTruthy(); // still a slow retry to come
      }
      r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(Date.now() + i * 7 * 3_600_000), "canceled");
    }
    expect(r.suspend_pending!.attempts).toBe(total);
    expect(r.suspend_pending!.next_retry_at).toBeNull();
    expect(retryDue(r.suspend_pending, new Date(Date.now() + 365 * 86_400_000))).toBe(false);
  });

  it("a failing resume stops being retried after MAX_RESUME_RETRIES + MAX_SLOW_RETRIES attempts", async () => {
    await paying();
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    stopMachineQuietly();
    fly.failStart = true;
    const total = MAX_RESUME_RETRIES + MAX_SLOW_RETRIES;
    for (let i = 1; i <= total; i++) {
      const e = (await getEstate(user.id))!;
      if (i > MAX_RESUME_RETRIES) expect(e.resume_pending!.next_retry_at).toBeTruthy();
      await retryPendingSuspend(user.id, fly as any, new Date(Date.now() + i * 7 * 3_600_000));
    }
    const e = (await getEstate(user.id))!;
    expect(e.resume_pending!.attempts).toBe(total);
    expect(e.resume_pending!.next_retry_at).toBeNull();
    expect(retryDue(e.resume_pending, new Date(Date.now() + 365 * 86_400_000))).toBe(false);
  });
});

describe("alert hook lines carry a stable key", () => {
  it("logs ALERT resume_failed / suspend_failed once, when the fast retries are used up", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await paying();
    const e = await estate({ status: "suspended", suspended_from: "ready" });
    for (let i = 0; i < MAX_RESUME_RETRIES + 2; i++) await recordResumeFailure((await getEstate(user.id))!, new Date(Date.now() + i * 3_600_000), new Error("boom"));
    const alerts = spy.mock.calls.filter((c) => String(c[0]).includes("ALERT resume_failed"));
    expect(alerts.length).toBe(1);
    expect(JSON.parse(String(alerts[0][1]))).toMatchObject({ key: "resume_failed", user_id: user.id, app: e.app });

    const other = await createUser("gap2@example.com", "sufficiently-long-pass");
    const e2 = await queueEstate(other);
    Object.assign(e2, { status: "ready", step: "done", machine_id: "m_2" });
    await saveEstate(e2);
    fly.failStop = true;
    for (let i = 0; i < MAX_SUSPEND_RETRIES + 1; i++) await suspendEstate((await getEstate(other.id))!, fly as any, new Date(Date.now() + i * 3_600_000), "x");
    expect(spy.mock.calls.filter((c) => String(c[0]).includes("ALERT suspend_failed")).length).toBe(1);
  });
});

describe("revive and resume bookkeeping", () => {
  it("revive of a flagged estate whose machine is gone marks machine_missing (no throw, no second estate)", async () => {
    await paying();
    await estate({ suspend_pending: { ...PENDING } });
    fly.getReturnsNull = true;
    const r = await reviveEstate((await getEstate(user.id))!, fly as any);
    expect(r.status).toBe("error");
    const stored = (await getEstate(user.id))!;
    expect(stored.error).toMatch(/^machine_missing/);
    expect(stored.machine_id).toBeNull();
    expect(stored.suspend_pending ?? null).toBeNull();
    expect(stored.health?.note).toMatch(/machine_missing/);
    expect((await queueEstate(user)).app).toBe(stored.app);
  });

  it("a successful resume clears resume_pending and its health note", async () => {
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    await recordResumeFailure((await getEstate(user.id))!, new Date(), new Error("x"));
    expect((await getEstate(user.id))!.resume_pending).toBeTruthy();
    stopMachineQuietly();
    const r = await resumeEstate((await getEstate(user.id))!, fly as any);
    expect(r.status).toBe("ready");
    const stored = (await getEstate(user.id))!;
    expect(stored.resume_pending ?? null).toBeNull();
    expect(stored.health ?? null).toBeNull();
  });

  it("a successful revive clears resume_pending and its health note too", async () => {
    await estate({ suspend_pending: { ...PENDING } });
    await recordResumeFailure((await getEstate(user.id))!, new Date(), new Error("x"));
    stopMachineQuietly();
    await reviveEstate((await getEstate(user.id))!, fly as any);
    const stored = (await getEstate(user.id))!;
    expect(stored.resume_pending ?? null).toBeNull();
    expect(stored.suspend_pending ?? null).toBeNull();
    expect(stored.health ?? null).toBeNull();
  });
});

describe("isGrantingUser and the tick's outcome labels", () => {
  it("a user on the sandbox tier is not granting, whatever the mirrored status says", async () => {
    const u = (status: string, tier: any) => ({ tier, billing: { status } }) as any;
    expect(isGrantingUser(u("active", "operator"))).toBe(true);
    expect(isGrantingUser(u("active", "sandbox"))).toBe(false);
    expect(isGrantingUser(u("canceled", "operator"))).toBe(false);
    expect(isGrantingUser(null)).toBe(false);
    // and the tick does not resume a suspended estate for such a user
    await paying("active", "sandbox");
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    stopMachineQuietly();
    const body = await tick();
    expect(body.outcomes.resume_retry_ok ?? 0).toBe(0);
    expect((await getEstate(user.id))!.status).toBe("suspended");
    expect(fly.machine("m_1").state).toBe("stopped");
  });

  it("an estate that ends in machine_missing is reported as a failed resume, not an ok one", async () => {
    await paying();
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    fly.getReturnsNull = true;
    const body = await tick();
    expect(body.outcomes.resume_retry_failed).toBe(1);
    expect(body.outcomes.resume_retry_ok ?? 0).toBe(0);
    expect((await getEstate(user.id))!.status).toBe("error");
  });

  it("a successful reconcile is reported as resume_retry_ok", async () => {
    await paying();
    await estate({ status: "suspended", suspended_from: "ready", suspended_at: "2026-01-01T00:00:00.000Z" });
    stopMachineQuietly();
    const body = await tick();
    expect(body.outcomes.resume_retry_ok).toBe(1);
    expect(body.outcomes.resume_retry_failed ?? 0).toBe(0);
  });
});
