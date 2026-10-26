// CX2 (late-config-write-after-suspend), found by the lifecycle fuzzer: a guarded config write (key
// placement / image upgrade) whose Fly update outlives the 20 s client timeout is APPLIED by Fly after the
// call threw, the user lock was released and a cancel suspended the estate: autostart on, machine launched,
// record "suspended". The scheduled tick must re-verify such an estate and stop the machine again.
//
// The late apply itself (the S6 monitor's "late-autostart-on-update") happens on Fly's side after the portal's
// call was abandoned; the portal cannot prevent it (ASSUMPTION, INFERRED: Fly applies a request it accepted
// even after the client aborted). What the portal must guarantee is S1: at quiescence the cancelled
// customer's machine is stopped, every service has autostart off, and the record reads suspended without
// flags. So that one monitor key is excluded below; every other violation, including any other S6 key, fails.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { runCase } from "./harness";
import type { Scenario } from "./scenario";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

const sc = (users: Scenario["users"], actions: Scenario["actions"], stripeRetryMs = 60_000): Scenario => ({ seed: 7, users, stripeRetryMs, actions });
const FLY_SIDE_LATE_APPLY = "S6|late-autostart-on-update";

async function run(s: Scenario) {
  const r = await runCase(s);
  const all = r.violations.map((v) => `${v.inv}|${v.key}`);
  const rest = r.violations.filter((v) => `${v.inv}|${v.key}` !== FLY_SIDE_LATE_APPLY).map((v) => `${v.inv}|${v.key}: ${v.detail}`);
  return { r, all, rest };
}

describe("CX2 late-config-write-after-suspend", () => {
  it("a timed-out key placement that Fly applies after the suspension is stopped again by the tick", async () => {
    const { all, rest } = await run(sc(["ready"], [
      { k: "fault", f: { pSlowUpdate: 1, slowUpdateMs: 25_000 }, stripeTimeout: 0 },
      { k: "key", u: 0, gap: 21_000 },
      { k: "fault", f: {}, stripeTimeout: 0 },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 0 },
      { k: "deliver", ev: 0, gap: 60_000, limitMs: 60_000, crashAt: null },
    ]));
    expect(all).toContain(FLY_SIDE_LATE_APPLY); // the interleaving really happened
    expect(rest).toEqual([]);
  });

  it("a timed-out image upgrade that Fly applies after the suspension is stopped again by the tick", async () => {
    const { all, rest } = await run(sc(["ready"], [
      { k: "fault", f: { pSlowUpdate: 1, slowUpdateMs: 25_000 }, stripeTimeout: 0 },
      { k: "upgrade", u: 0, gap: 21_000 },
      { k: "fault", f: {}, stripeTimeout: 0 },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 0 },
      { k: "deliver", ev: 0, gap: 60_000, limitMs: 60_000, crashAt: null },
    ]));
    expect(all).toContain(FLY_SIDE_LATE_APPLY);
    expect(rest).toEqual([]);
  });

  it("a write Fly applies minutes later, after a tick already found the machine quiet, is still caught", async () => {
    const { all, rest } = await run(sc(["ready"], [
      { k: "fault", f: { pSlowUpdate: 1, slowUpdateMs: 300_000 }, stripeTimeout: 0 },
      { k: "key", u: 0, gap: 21_000 },
      { k: "fault", f: {}, stripeTimeout: 0 },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 0 },
      { k: "deliver", ev: 0, gap: 60_000, limitMs: 60_000, crashAt: null },
      { k: "tick", gap: 120_000, crashAt: null }, // the machine is quiet here; the write has not landed yet
    ]));
    expect(all).toContain(FLY_SIDE_LATE_APPLY);
    expect(rest).toEqual([]);
  });

  it("a late autostart-on write followed by a platform stop (stopped, autostart ON) is re-quieted by the tick", async () => {
    const { all, rest } = await run(sc(["ready"], [
      { k: "fault", f: { pSlowUpdate: 1, slowUpdateMs: 25_000 }, stripeTimeout: 0 },
      { k: "key", u: 0, gap: 21_000 },
      { k: "fault", f: {}, stripeTimeout: 0 },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 0 },
      { k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: null },
      { k: "pstop", u: 0 },
    ]));
    expect(all).toContain(FLY_SIDE_LATE_APPLY);
    expect(rest).toEqual([]);
  });
});
