// Hand-written scenarios: the harness itself must reach the expected end states on the happy paths
// (so a violation reported by the fuzzer / explorer is about the portal, not the harness).
import { describe, it, expect, beforeAll } from "vitest";
import { vi } from "vitest";
import { runCase } from "./harness";
import type { Scenario } from "./scenario";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

const base = (actions: Scenario["actions"], users: Scenario["users"] = ["ready"]): Scenario => ({ seed: 1, users, stripeRetryMs: 60_000, actions });

describe("harness smoke", () => {
  it("paying customer, nothing happens: stays ready and running", async () => {
    const r = await runCase(base([{ k: "tick", gap: 120_000, crashAt: null }]));
    expect(r.violations).toEqual([]);
  });

  it("cancel: suspended-safe at the end", async () => {
    const r = await runCase(base([
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 1000 },
      { k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: null },
    ]), { trace: true });
    if (r.violations.length) console.info(r.trace.join("\n"));
    expect(r.violations).toEqual([]);
    expect(r.billingAfterCancelMs[0]).toBeLessThan(40_000);
  });

  it("new customer: checkout provisions an estate to ready", async () => {
    const r = await runCase(base([{ k: "stripe", op: { k: "checkout", u: 0, sub: 1, price: "op" }, gap: 1000 }], ["new"]), { trace: true });
    if (r.violations.length) process.stdout.write(r.trace.slice(-80).join("\n") + "\n");
    expect(r.violations).toEqual([]);
  });

  it("cancel then reactivate (past_due -> active)", async () => {
    const r = await runCase(base([
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "unpaid" }, gap: 2000 },
      { k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: null },
      { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "active" }, gap: 2000 },
    ]));
    expect(r.violations).toEqual([]);
  });
});
