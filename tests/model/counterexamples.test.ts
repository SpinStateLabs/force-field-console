// Minimal counterexamples found by the lifecycle fuzzer / small-scope explorer (shrunk, then written out
// by hand). Each asserts the spec's invariants with NO exclusions. They were all `it.fails` against main
// d2d7735; after the fixes merged to main 86d014c (PRs #5..#10) five pass and are now plain guards. CX2 stays
// `it.fails`: see the comment on that test for exactly why.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { runCase } from "./harness";
import type { Scenario } from "./scenario";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

const sc = (users: Scenario["users"], actions: Scenario["actions"], stripeRetryMs = 60_000): Scenario => ({ seed: 7, users, stripeRetryMs, actions });
const expectClean = async (s: Scenario) => {
  const r = await runCase(s);
  expect(r.violations.map((v) => `${v.inv}|${v.key}: ${v.detail}`)).toEqual([]);
};

describe("lifecycle counterexamples (guards for the CX1-CX6 fixes)", () => {
  // CX1, HIGH, fixed by #9: the cancel delivery dies after claiming the event (crash / function limit); Stripe's
  // retry inside STALE_CLAIM_MS (10 min) was answered 200 duplicate, Stripe stopped retrying, the cancel was lost.
  it("killed-webhook-claim-dup200: a killed cancel delivery + retry within 10 min loses the cancel", async () => {
    await expectClean(sc(["ready"], [
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 1000 },
      { k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: 2 },
    ], 30_000));
  });

  // CX2, HIGH, fixed by #7: a guarded config write (key placement / upgrade / arm) whose Fly update outlives the
  // 20 s client timeout is APPLIED after the lock was released and after a cancel suspended the estate:
  // autostart on, machine launched, record "suspended", and the tick never re-verified a suspended estate.
  // STILL it.fails after #7 (measured on 86d014c + this branch): the ONLY remaining violation is the S6 monitor
  // key "late-autostart-on-update" (at t=25.18 s: "an update with autostart ON landed ... while the record was
  // suspended; issued 25s earlier, caller already gone"). That is Fly applying an abandoned request on its own
  // side, which the portal cannot prevent; #7 makes the tick re-quiet the machine, so S1/L2 hold at
  // quiescence. This test asserts every invariant with no exclusions, so it keeps failing by design. The fix
  // is guarded by tests/model/cx2-late-config-write.test.ts (from #7), which excludes only that one monitor
  // key and asserts it really fired. Not deleted, not loosened.
  it.fails("late-autostart-on-update: a timed-out config write lands after the suspension", async () => {
    await expectClean(sc(["ready"], [
      { k: "fault", f: { pSlowUpdate: 1, slowUpdateMs: 25_000 }, stripeTimeout: 0 },
      { k: "key", u: 0, gap: 21_000 },
      { k: "fault", f: {}, stripeTimeout: 0 },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 0 },
      { k: "deliver", ev: 0, gap: 60_000, limitMs: 60_000, crashAt: null },
    ]));
  });

  // CX3, HIGH, fixed by #5: two provisioning drivers (the tick and a dashboard advance) in the same instant at
  // create_machine both passed the read-then-write step lease and both created a machine; the orphan kept running.
  it("concurrent-drivers-second-machine: tick + dashboard advance at create_machine", async () => {
    await expectClean(sc(["new"], [
      { k: "stripe", op: { k: "checkout", u: 0, sub: 1, price: "op" }, gap: 1000 },
      { k: "deliver", ev: 1, gap: 30_000, limitMs: 60_000, crashAt: null },
      { k: "tick", gap: 120_000, crashAt: null },
      { k: "tick", gap: 120_000, crashAt: null },
      { k: "tick", gap: 120_000, crashAt: null },
      { k: "tick", gap: 120_000, crashAt: null },
      { k: "poll", u: 0, gap: 0, crashAt: null },
      { k: "tick", gap: 60_000, crashAt: null },
      { k: "jump", ms: 3_600_000 },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 1000 },
      { k: "deliver", ev: 2, gap: 60_000, limitMs: 60_000, crashAt: null },
    ]));
  });

  // CX5, MED, fixed by #10: an event for a subscription WITHOUT metadata.user_id was resolved only through the
  // stripe_customers pointer, which exists only after a first applied event of that customer; delivered earlier
  // it was answered 200 "no portal user" and dropped for good, so a paying customer stayed on sandbox.
  it("unknown-user-before-pointer: a granting no-metadata subscription delivered first is dropped", async () => {
    await expectClean(sc(["new"], [
      { k: "stripe", op: { k: "newsub", u: 0, sub: 1, price: "op", status: "incomplete", meta: true }, gap: 1500 },
      { k: "stripe", op: { k: "newsub", u: 0, sub: 3, price: "op", status: "trialing", meta: false }, gap: 1500 },
      { k: "deliver", ev: 1, gap: 30_000, limitMs: 60_000, crashAt: null },
      { k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: null },
    ]));
  });

  // CX6, MED (known gap G2), fixed by #6: two non-cancel events of one subscription in the same second applied
  // in arrival order.
  it("g2-equal-second: paused then active in one second, delivered reversed, leaves a paying customer suspended", async () => {
    await expectClean(sc(["ready"], [
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "paused" }, gap: 400 },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "active" }, gap: 1000 },
      { k: "deliver", ev: 1, gap: 30_000, limitMs: 60_000, crashAt: null },
      { k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: null },
    ]));
  });

  // CX4, HIGH only if assumption A10 is false, fixed by #8: a single 404 for a LIVE machine during the cancel's
  // quiesce counted as "gone"; the estate was marked suspended without stopping it or turning autostart off.
  it("a10-transient-404: one spurious 404 during the cancel leaves the machine billing", async () => {
    await expectClean(sc(["ready"], [
      { k: "fault", f: { transient404: 1 }, stripeTimeout: 0 },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 0 },
      { k: "deliver", ev: 0, gap: 300, limitMs: 60_000, crashAt: null },
      { k: "fault", f: {}, stripeTimeout: 0 },
      { k: "jump", ms: 60_000 },
    ]));
  });
});
