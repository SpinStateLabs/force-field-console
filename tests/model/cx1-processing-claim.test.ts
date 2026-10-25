// CX1 (group processing-claim-acked-200), minimal repro copied from the lifecycle model's counterexample
// "killed-webhook-claim-dup200" (tests/model/counterexamples.test.ts on test/lifecycle-model, ee59362).
// The cancel delivery is killed at its 2nd I/O, after claimEvent wrote stripe_events/<id> = processing;
// Stripe retries 30 s later, inside STALE_CLAIM_MS. Before the fix that retry was answered 200 duplicate,
// Stripe stopped, and the cancelled customer kept the paid tier with the machine running (S1/S3).
import { describe, it, expect, beforeAll, vi } from "vitest";
import { runCase } from "./harness";
import type { Scenario } from "./scenario";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

describe("CX1 lifecycle model: killed webhook claim + retry within 10 min", () => {
  it("killed-webhook-claim-dup200: the cancel is still applied (machine stopped, autostart off, record suspended)", async () => {
    const s: Scenario = {
      seed: 7,
      users: ["ready"],
      stripeRetryMs: 30_000,
      actions: [
        { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 1000 },
        { k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: 2 },
      ],
    };
    const r = await runCase(s);
    expect(r.violations.map((v) => `${v.inv}|${v.key}: ${v.detail}`)).toEqual([]);
  });
});
