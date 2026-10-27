// Follow-ups to the lifecycle review (PR #12 review, LOW-1 and INFO-2).
//  1. The config-null pending lifecycle: a stopped machine whose config cannot be read behind a SUSPENDED record
//     goes pending, is retried with backoff, fails after MAX_SUSPEND_RETRIES, is retried slowly, and ends
//     terminal (next_retry_at null): the tick then makes no Fly call, even when Fly could answer again.
//  2. A non-404 error from getMachine on the tick's re-verify path backs off (2, 4, 8, 16, 32, then 60 min, capped)
//     instead of repeating every tick; a 404 keeps its meaning (the record is trusted once the list confirms it).
// Fake clocks: every call takes an explicit `now`; the tick test fakes Date. The Fly side is ModelFly, directly or
// behind the real FlyClient's HTTP calls (fake fetch). No real network.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { ModelFly, machinesApiHandler } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { FlyError } from "../src/lib/fly";
import { retryPendingSuspend } from "../src/lib/billing";
import { MAX_SLOW_RETRIES, MAX_SUSPEND_RETRIES, SLOW_RETRY_MS, configWriteMarks, getEstate, queueEstate, readback, retryDue, saveEstate, suspendEstate, type Estate } from "../src/lib/estates";
import { portalStore } from "../src/lib/store";

const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };
const MIN = 60_000;
const markKey = () => "ops/config_write/" + user.id;

let user: User;
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, FLY_ENV);
  user = await createUser("followups@example.com", "sufficiently-long-pass");
});
afterEach(() => {
  for (const k of Object.keys(FLY_ENV)) delete process.env[k];
  delete process.env.URL;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const suspendedRecord = { status: "suspended" as const, suspended_from: "ready" as const, suspended_at: new Date().toISOString() };
async function suspendedEstate(): Promise<Estate> {
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` }, suspendedRecord);
  await saveEstate(e);
  return e;
}
const stored = async () => (await getEstate(user.id))!;

// ---------------------------------------------------------------------------------------------------------
// 1. config-null pending lifecycle
// ---------------------------------------------------------------------------------------------------------
describe("a stopped machine whose config cannot be read behind a suspended record: the whole pending lifecycle", () => {
  const origDelay = readback.delayMs;
  beforeEach(() => {
    readback.delayMs = 1;
  });
  afterEach(() => {
    readback.delayMs = origDelay;
  });

  it("backs off 2/4/8/16/32/60 min, fails at MAX_SUSPEND_RETRIES with one ALERT, retries slowly, ends terminal; nothing is written or stopped; the tick then does nothing", async () => {
    const alerts: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: any[]) => {
      const s = a.map(String).join(" ");
      if (s.startsWith("ALERT")) alerts.push(s);
    });
    await suspendedEstate();
    await (await portalStore()).setJSON(markKey(), { at: new Date().toISOString() }); // a recent guarded config write
    const fly = new ModelFly();
    fly.machine("m_1", { state: "stopped" }).config = null; // Fly answers, but without a readable config

    // The re-verify (a later non-granting event, or the tick with the mark): the record is not trusted.
    let now = new Date("2026-10-27T00:00:00.000Z");
    let e = await suspendEstate(await stored(), fly as any, now, "re-verified");
    expect(e.status).toBe("suspended");
    expect(e.suspend_pending!.attempts).toBe(1);
    expect(e.suspend_pending!.failed).toBe(false);
    expect(e.health?.note).toMatch(/^suspend pending/);

    const total = MAX_SUSPEND_RETRIES + MAX_SLOW_RETRIES;
    const delays: number[] = [];
    for (let attempt = 1; attempt < total; attempt++) {
      const p = (await stored()).suspend_pending!;
      expect(p.attempts).toBe(attempt);
      expect(p.failed).toBe(attempt >= MAX_SUSPEND_RETRIES);
      expect(p.next_retry_at).toBeTruthy(); // not terminal yet
      const due = new Date(p.next_retry_at!);
      delays.push(due.getTime() - now.getTime());
      expect(retryDue(p, new Date(due.getTime() - 1))).toBe(false); // not before the backoff has passed
      expect(retryDue(p, due)).toBe(true);
      now = due;
      const r = await retryPendingSuspend(user.id, fly as any, now); // the tick's retry
      expect(r.outcome).toBe("pending");
    }
    // 2, 4, 8, 16, 32, 60, 60, 60, 60 min (attempts 1..9), then SLOW_RETRY_MS (6 h) for the slow retries (attempts 10..17)
    expect(delays).toEqual([2, 4, 8, 16, 32, 60, 60, 60, 60].map((m) => m * MIN).concat(Array(MAX_SLOW_RETRIES).fill(SLOW_RETRY_MS)));

    // Terminal: the 18th attempt leaves next_retry_at null, failed, health says an operator must act.
    e = await stored();
    expect(e.status).toBe("suspended");
    expect(e.suspend_pending).toMatchObject({ attempts: total, failed: true, next_retry_at: null });
    expect(e.health?.note).toMatch(/^suspend failed: .*operator action needed/);
    expect(retryDue(e.suspend_pending, new Date(now.getTime() + 365 * 86_400_000))).toBe(false);
    expect(alerts.filter((a) => a.startsWith("ALERT suspend_failed"))).toHaveLength(1); // once, at the 10th attempt
    expect((await configWriteMarks()).has(user.id)).toBe(true); // the mark is kept: the machine was never found quiet

    // Fail-safe: no config write and no stop in all rounds, only reads.
    expect(new Set(fly.log)).toEqual(new Set(["get m_1"]));
    // 2 reads in the first round (re-verify + quiesce), 1 in each of the others.
    expect(fly.log.length).toBe(2 + (total - 1));

    // Even when Fly can read the config again (autostart off), nothing recovers the terminal record by itself:
    // the tick makes no Fly call and reports it in /api/health's counter; the record is left as it is.
    fly.machine("m_1").config = { image: "img", services: [{ internal_port: 8080, autostart: false }] };
    fly.log.length = 0;
    process.env.URL = "https://portal.test";
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    const api = machinesApiHandler(fly);
    globalThis.fetch = (async (url: any, init?: any) => (seen.push(String(url)), (await api(String(url), init)) ?? new Response("", { status: 404 }))) as any;
    try {
      const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(body.outcomes).toEqual({});
      expect(body.suspend_failed).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fly.log).toEqual([]);
    expect(seen).toEqual([]);
    expect((await stored()).suspend_pending).toMatchObject({ failed: true, next_retry_at: null });

    // What does act on it (the README says so): a later cancel event for the user retries the stop once (the
    // webhook calls suspendEstate for a suspended record too), and with Fly readable that clears the flag.
    const later = await suspendEstate(await stored(), fly as any, new Date(now.getTime() + 86_400_000), "subscription canceled");
    expect(later.status).toBe("suspended");
    expect(later.suspend_pending).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
// 2. non-404 getMachine error on the tick's re-verify path
// ---------------------------------------------------------------------------------------------------------
describe("a non-404 getMachine error on the re-verify path backs off instead of retrying every tick", () => {
  const origDelay = readback.delayMs;
  beforeEach(() => {
    readback.delayMs = 1;
  });
  afterEach(() => {
    readback.delayMs = origDelay;
  });

  /** A suspended estate with no flag, a quiet stopped machine, and a fresh config-write mark. */
  async function marked(at: Date): Promise<ModelFly> {
    await suspendedEstate();
    await (await portalStore()).setJSON(markKey(), { at: at.toISOString() });
    const fly = new ModelFly();
    fly.machine("m_1", { state: "stopped", autostart: false });
    return fly;
  }
  const mark = async () => (await (await portalStore()).get(markKey(), { type: "json" })) as { at: string; reverify_failures?: number; reverify_next_at?: string } | null;

  it("the schedule is 2, 4, 8, 16, 32, then 60 min (capped); inside it no Fly call is made; the error still surfaces", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t0 = new Date("2026-10-27T00:00:00.000Z");
    const fly = await marked(t0);
    fly.failGet = true; // Fly answers HTTP 500 to every machine read
    let now = t0;
    const gaps: number[] = [];
    for (let n = 1; n <= 8; n++) {
      fly.log.length = 0;
      await expect(retryPendingSuspend(user.id, fly as any, now, { reverify: true })).rejects.toBeInstanceOf(FlyError);
      expect(fly.log).toEqual(["get m_1"]); // exactly one read per attempt
      const m = (await mark())!;
      expect(m.reverify_failures).toBe(n);
      const gap = Date.parse(m.reverify_next_at!) - now.getTime();
      gaps.push(gap);

      // inside the window: no Fly call, no error, the outcome says "backoff"
      fly.log.length = 0;
      const early = new Date(Date.parse(m.reverify_next_at!) - 1);
      const r = await retryPendingSuspend(user.id, fly as any, early, { reverify: true });
      expect(r.outcome).toBe("backoff");
      expect(fly.log).toEqual([]);
      now = new Date(m.reverify_next_at!); // at the boundary the next read is allowed
    }
    expect(gaps).toEqual([2, 4, 8, 16, 32, 60, 60, 60].map((m) => m * MIN));
    expect((await mark())!.at).toBe(t0.toISOString()); // the write's own timestamp is untouched
    const e = await stored();
    expect(e.status).toBe("suspended");
    expect(e.suspend_pending).toBeFalsy(); // no pending flag was invented for a read that failed
    fly.failGet = false;
  });

  it("when Fly recovers the next due look succeeds, the backoff is cleared, and the mark settles as before", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t0 = new Date("2026-10-27T00:00:00.000Z");
    const fly = await marked(t0);
    fly.failGet = true;
    await expect(retryPendingSuspend(user.id, fly as any, t0, { reverify: true })).rejects.toBeTruthy();
    const next = new Date((await mark())!.reverify_next_at!);
    fly.failGet = false;
    fly.log.length = 0;
    const r = await retryPendingSuspend(user.id, fly as any, next, { reverify: true });
    expect(r.outcome).toBe("suspended");
    expect(fly.log).toEqual(["get m_1"]);
    expect(await mark()).toEqual({ at: t0.toISOString() }); // backoff fields gone, the mark kept (the write is not yet 30 min old)
    // a later look is not delayed
    fly.log.length = 0;
    expect((await retryPendingSuspend(user.id, fly as any, new Date(next.getTime() + 1), { reverify: true })).outcome).toBe("suspended");
    expect(fly.log).toEqual(["get m_1"]);
    // and once the write is 30 minutes old the quiet look deletes the mark
    await retryPendingSuspend(user.id, fly as any, new Date(t0.getTime() + 31 * MIN), { reverify: true });
    expect((await configWriteMarks()).has(user.id)).toBe(false);
  });

  it("a fresh guarded config write resets the backoff (a new mark replaces the old one)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t0 = new Date("2026-10-27T00:00:00.000Z");
    const fly = await marked(t0);
    fly.failGet = true;
    await expect(retryPendingSuspend(user.id, fly as any, t0, { reverify: true })).rejects.toBeTruthy();
    expect((await mark())!.reverify_failures).toBe(1);
    await (await portalStore()).setJSON(markKey(), { at: new Date(t0.getTime() + MIN).toISOString() }); // what updateMachineGuarded writes
    fly.log.length = 0;
    await expect(retryPendingSuspend(user.id, fly as any, new Date(t0.getTime() + MIN), { reverify: true })).rejects.toBeTruthy();
    expect(fly.log).toEqual(["get m_1"]); // not held back by the old window
    expect((await mark())!.reverify_failures).toBe(1);
  });

  it("a 404 keeps its meaning: the record is trusted once the machine list agrees, no failure is recorded, no backoff", async () => {
    const t0 = new Date("2026-10-27T00:00:00.000Z");
    // (a) FlyClient maps 404 to null (ModelFly strict: the machine is not there and not listed)
    const fly = await marked(t0);
    fly.machines.clear();
    fly.strict = true;
    fly.log.length = 0;
    const r = await retryPendingSuspend(user.id, fly as any, t0, { reverify: true });
    expect(r.outcome).toBe("suspended");
    expect((await mark())!.reverify_failures).toBeUndefined();
    expect((await mark())!.reverify_next_at).toBeUndefined();
    expect((await stored()).suspend_pending).toBeFalsy();
    expect((await retryPendingSuspend(user.id, fly as any, new Date(t0.getTime() + 1), { reverify: true })).outcome).toBe("suspended"); // not "backoff"
    // (b) a raw FlyError 404 thrown by getMachine is handled by suspendEstate itself, never reaching the backoff
    const fly2 = new ModelFly();
    fly2.getMachine = async () => {
      throw new FlyError(404, "not found");
    };
    const r2 = await retryPendingSuspend(user.id, fly2 as any, new Date(t0.getTime() + 2), { reverify: true });
    expect(r2.outcome).toBe("suspended");
    expect((await mark())!.reverify_failures).toBeUndefined();
  });

  it("404 that the machine list contradicts (still listed) is still not trusted: pending, as before", async () => {
    const t0 = new Date("2026-10-27T00:00:00.000Z");
    const fly = await marked(t0);
    fly.getReturnsNull = true; // reads say "not found" while the list still carries the machine
    const r = await retryPendingSuspend(user.id, fly as any, t0, { reverify: true });
    expect(r.outcome).toBe("pending");
    expect((await stored()).suspend_pending).toBeTruthy();
    expect((await mark())!.reverify_failures).toBeUndefined(); // an unconfirmed 404 goes pending, not into the read backoff
  });

  it("through the tick with a fake clock: the failing read is made once per backoff window, counted as suspend_retry_threw, then reverify_backoff", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.URL = "https://portal.test";
    const t0 = new Date("2026-10-27T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(t0);
    const fly = await marked(t0);
    fly.failGet = true;
    const api = machinesApiHandler(fly);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => (await api(String(url), init)) ?? new Response("", { status: 404 })) as any;
    const tick = async () => (await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json()).outcomes;
    try {
      expect(await tick()).toEqual({ suspend_retry_threw: 1 });
      const reads = () => fly.log.filter((l) => l === "get m_1").length;
      expect(reads()).toBe(1);
      // ticks every 2 minutes: the window is 2 min after the first failure, then 4, then 8
      vi.setSystemTime(new Date(t0.getTime() + 1 * MIN));
      expect(await tick()).toEqual({ reverify_backoff: 1 });
      expect(reads()).toBe(1);
      vi.setSystemTime(new Date(t0.getTime() + 2 * MIN));
      expect(await tick()).toEqual({ suspend_retry_threw: 1 });
      expect(reads()).toBe(2);
      for (const m of [3, 4, 5]) {
        vi.setSystemTime(new Date(t0.getTime() + m * MIN));
        expect(await tick()).toEqual({ reverify_backoff: 1 }); // the second window ends at 2 + 4 = 6 min
      }
      expect(reads()).toBe(2);
      vi.setSystemTime(new Date(t0.getTime() + 6 * MIN + 1));
      expect(await tick()).toEqual({ suspend_retry_threw: 1 });
      expect(reads()).toBe(3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
