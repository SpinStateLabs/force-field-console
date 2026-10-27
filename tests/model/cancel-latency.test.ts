// Cancel-to-stopped latency (todo 2026-10-26: "p99/max about 1 to 2 h per shard ... not asserted by any
// invariant"). The fuzz / explorer measure it as invariant L5 (harness.ts: L5_RECOVERY_BOUND_MS for every
// scenario, L5_FAULT_FREE_BOUND_MS for scenarios without faults). These hand-written scenarios pin the intended
// number of ticks on the paths that decide it, in virtual time (fake Date, the model's Fly and Stripe):
//  - nothing goes wrong: the webhook itself stops the machine (zero ticks);
//  - the stop fails once: the first retry is due 2 minutes later and the next tick after that stops it;
//  - Fly is down for an hour: retries back off 2, 4, 8, 16, 32 min, so the machine is stopped at the first
//    retry after the outage ends (62 min after the cancellation), not later;
//  - Fly is down until the suspension is marked failed (10 attempts, about 5 h): once the faults clear it is stopped at
//    the next slow retry (SLOW_RETRY_MS, 6 h), inside L5_RECOVERY_BOUND_MS as the harness measures it;
//  - the webhook is killed at any I/O point: it is stopped once the killed invocation's leftovers have expired: its user
//    lock (SUB_LOCK_TTL_MS, 5 min) and its "processing" claim on the event (STALE_CLAIM_MS, 10 min), plus Stripe's redelivery.
//    Measured 2026-10-27: crash points before the pending flag was persisted 12.5 min, after it 6.5 min, late ones 1.5 s.
//    That latency is NOT the tick's: the tick is held off by the dead lock, and the event by the dead claim.
import { describe, it, expect, beforeAll } from "vitest";
import { vi } from "vitest";
import { L5_FAULT_FREE_BOUND_MS, L5_RECOVERY_BOUND_MS, runCase } from "./harness";
import type { Action, Scenario } from "./scenario";
import { STALE_CLAIM_MS } from "../../src/lib/billing";
import { SUB_LOCK_TTL_MS } from "../../src/lib/locks";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

const MIN = 60_000;
const TICK = 2 * MIN;
const cancel: Action[] = [
  { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 1000 },
];
const deliver = (over: Partial<Extract<Action, { k: "deliver" }>> = {}): Action => ({ k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: null, ...over });
const ticks = (n: number): Action[] => Array.from({ length: n }, () => ({ k: "tick", gap: TICK, crashAt: null }) as Action);
const sc = (actions: Action[], over: Partial<Scenario> = {}): Scenario => ({ seed: 7, users: ["ready"], stripeRetryMs: 60_000, actions, ...over });

describe("cancel-to-stopped latency (the portal's own retry clock)", () => {
  it("the bounds themselves: the fault-free bound is one tick, the recovery bound is one slow retry plus a margin", () => {
    expect(L5_FAULT_FREE_BOUND_MS).toBeLessThanOrEqual(TICK);
    expect(L5_RECOVERY_BOUND_MS).toBe(6 * 3_600_000 + 15 * MIN);
  });

  it("no fault: stopped by the webhook itself, before the answer, with zero ticks", async () => {
    const r = await runCase(sc([...cancel, deliver()]));
    expect(r.violations).toEqual([]);
    expect(r.billingAfterCancelMs[0]).toBeLessThan(10_000);
    expect(r.cancelLatency[0]).toMatchObject({ sinceDeliveryMs: 0, faultFree: true });
  });

  it("the first stop fails (Fly 5xx), Fly recovers at once: stopped by the first tick after the 2-minute backoff", async () => {
    const r = await runCase(
      sc([
        { k: "fault", f: { p5xxBefore: 1 }, stripeTimeout: 0 },
        ...cancel,
        deliver(),
        { k: "fault", f: {}, stripeTimeout: 0 },
        ...ticks(4),
      ]),
    );
    expect(r.violations).toEqual([]);
    // cancel +1 s, delivery +30 s (the suspension is flagged pending right away, retry due 2 min later), then a tick
    // every 2 min: the first tick is at about +61 s (not due), the second at about +181 s (due) and stops it.
    expect(r.billingAfterCancelMs[0]).toBeGreaterThan(2 * MIN);
    expect(r.billingAfterCancelMs[0]).toBeLessThanOrEqual(1000 + 30_000 + 2 * MIN + TICK + 15_000);
  });

  it("Fly is down for an hour: retries back off 2, 4, 8, 16, 32 min, so it is stopped at the first retry after the outage ends", async () => {
    // outage: the delivery and 30 ticks (60 min); Fly recovers; then ticks continue
    const r = await runCase(
      sc([
        { k: "fault", f: { p5xxBefore: 1 }, stripeTimeout: 0 },
        ...cancel,
        deliver(),
        ...ticks(30),
        { k: "fault", f: {}, stripeTimeout: 0 },
        ...ticks(20),
      ]),
    );
    expect(r.violations).toEqual([]);
    // the retries fall at about +2, +6, +14, +30, +62 min after the flag; the outage ends at about +61 min, so the
    // 62-minute retry stops it: at most one tick later than that
    const stopped = r.billingAfterCancelMs[0];
    expect(stopped).toBeGreaterThan(60 * MIN);
    expect(stopped).toBeLessThanOrEqual(1000 + 30_000 + 62 * MIN + TICK + 15_000);
  });

  it("Fly is down until the suspension is marked failed: once the faults clear it is stopped at the next slow retry, inside the L5 recovery bound", async () => {
    // attempt 1 is the webhook's; the retries fall at about +2, +6, +14, +30, +62, +122, +182, +242 and +302 min, and the
    // 10th failed attempt (MAX_SUSPEND_RETRIES) marks it failed with the next (slow) retry 6 h later. The outage covers all
    // ten (160 ticks, 320 min); quiescence then clears the faults and the slow retry stops the machine. L5 (harness.ts)
    // measures that from the start of quiescence, so a slower schedule (a longer SLOW_RETRY_MS) shows up as an L5 violation.
    const r = await runCase(
      sc([
        { k: "fault", f: { p5xxBefore: 1 }, stripeTimeout: 0 },
        ...cancel,
        deliver(),
        ...ticks(160),
      ]),
    );
    expect(r.violations).toEqual([]);
    expect(r.cancelLatency).toHaveLength(1);
    const { sinceRecoveryMs, faultFree } = r.cancelLatency[0];
    expect(faultFree).toBe(false);
    // the slow retry is due about 302 + 360 = 662 min after the flag; quiescence starts at about 321 min
    expect(sinceRecoveryMs).toBeGreaterThan(5 * 3_600_000);
    expect(sinceRecoveryMs).toBeLessThanOrEqual(L5_RECOVERY_BOUND_MS);
  });

  it("the webhook is killed at any I/O point: stopped once its lock (5 min) and its event claim (10 min) have expired, and not later", async () => {
    const worst: number[] = [];
    for (let k = 1; k <= 24; k++) {
      const r = await runCase(sc([...cancel, deliver({ crashAt: k }), ...ticks(6)]));
      expect(r.violations, `crashAt ${k}`).toEqual([]);
      if (r.billingAfterCancelMs.length) worst.push(r.billingAfterCancelMs[0]);
    }
    expect(worst.length).toBeGreaterThan(0);
    // delivery +30 s, then the stale claim (10 min) is the longest wait; three minutes for Stripe's redelivery steps
    expect(Math.max(...worst)).toBeLessThanOrEqual(1000 + 30_000 + STALE_CLAIM_MS + 3 * MIN);
    // a killed webhook whose pending flag was persisted waits for the dead lock, not for the claim: lock TTL + two ticks
    expect(worst.filter((w) => w > 1000 + 30_000 + SUB_LOCK_TTL_MS + 2 * TICK + 15_000 && w < STALE_CLAIM_MS).length).toBe(0);
    expect(Math.min(...worst)).toBeLessThan(10_000); // killed late: the stop had already happened inline
  });
});
