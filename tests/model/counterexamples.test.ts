// Minimal counterexamples found by the lifecycle fuzzer / small-scope explorer (shrunk, then written out
// by hand). Each is `it.fails`: it asserts the spec's invariant and is EXPECTED to fail against main d2d7735;
// when a fix lands the test turns red and its `.fails` must be removed (it then guards the fix).
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

describe("lifecycle counterexamples (expected to fail until fixed)", () => {
  // HIGH: the cancel delivery dies after claiming the event (crash / function limit); Stripe's retry inside
  // STALE_CLAIM_MS (10 min) is answered 200 duplicate, Stripe stops retrying, the cancel is never applied.
  it.fails("killed-webhook-claim-dup200: a killed cancel delivery + retry within 10 min loses the cancel", async () => {
    await expectClean(sc(["ready"], [
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 1000 },
      { k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: 2 },
    ], 30_000));
  });

  // HIGH: a guarded config write (key placement / upgrade / arm) whose Fly update outlives the 20 s client
  // timeout is APPLIED after the lock was released and after a cancel suspended the estate: autostart on,
  // machine launched, record "suspended", and the tick never re-verifies a suspended estate without flags.
  it.fails("late-autostart-on-update: a timed-out config write lands after the suspension", async () => {
    await expectClean(sc(["ready"], [
      { k: "fault", f: { pSlowUpdate: 1, slowUpdateMs: 25_000 }, stripeTimeout: 0 },
      { k: "key", u: 0, gap: 21_000 },
      { k: "fault", f: {}, stripeTimeout: 0 },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 0 },
      { k: "deliver", ev: 0, gap: 60_000, limitMs: 60_000, crashAt: null },
    ]));
  });

  // HIGH: two provisioning drivers (the tick and a dashboard advance) in the same instant at create_machine
  // both pass the read-then-write step lease and both create a machine; the orphan keeps running after cancel.
  it.fails("concurrent-drivers-second-machine: tick + dashboard advance at create_machine", async () => {
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

  // MED: an event for a subscription WITHOUT metadata.user_id is resolved through the stripe_customers pointer,
  // which exists only after a first applied event of that customer; delivered earlier it is answered 200
  // "no portal user" and dropped for good, so a paying customer stays on sandbox without an estate.
  it.fails("unknown-user-before-pointer: a granting no-metadata subscription delivered first is dropped", async () => {
    await expectClean(sc(["new"], [
      { k: "stripe", op: { k: "newsub", u: 0, sub: 1, price: "op", status: "incomplete", meta: true }, gap: 1500 },
      { k: "stripe", op: { k: "newsub", u: 0, sub: 3, price: "op", status: "trialing", meta: false }, gap: 1500 },
      { k: "deliver", ev: 1, gap: 30_000, limitMs: 60_000, crashAt: null },
      { k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: null },
    ]));
  });

  // MED (known gap G2): two non-cancel events of one subscription in the same second apply in arrival order.
  it.fails("g2-equal-second: paused then active in one second, delivered reversed, leaves a paying customer suspended", async () => {
    await expectClean(sc(["ready"], [
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "paused" }, gap: 400 },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "active" }, gap: 1000 },
      { k: "deliver", ev: 1, gap: 30_000, limitMs: 60_000, crashAt: null },
      { k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: null },
    ]));
  });

  // HIGH only if assumption A10 is false: a single 404 for a LIVE machine during the cancel's quiesce counts as
  // "gone"; the estate is marked suspended without stopping it or turning autostart off.
  it.fails("a10-transient-404: one spurious 404 during the cancel leaves the machine billing", async () => {
    await expectClean(sc(["ready"], [
      { k: "fault", f: { transient404: 1 }, stripeTimeout: 0 },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 0 },
      { k: "deliver", ev: 0, gap: 300, limitMs: 60_000, crashAt: null },
      { k: "fault", f: {}, stripeTimeout: 0 },
      { k: "jump", ms: 60_000 },
    ]));
  });
});
