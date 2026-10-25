import { it, vi } from "vitest";
import { runCase } from "./harness";
it("dbg late update", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const r = await runCase({ seed: 3, users: ["ready"], stripeRetryMs: 60000, actions: [
    { k: "fault", f: { pSlowUpdate: 1, slowUpdateMs: 25000 }, stripeTimeout: 0 },
    { k: "key", u: 0, gap: 21000 },
    { k: "fault", f: {}, stripeTimeout: 0 },
    { k: "stripe", op: { k: "status", u: 0, sub: 1, status: "canceled" }, gap: 0 },
    { k: "deliver", ev: 0, gap: 60000, limitMs: 60000, crashAt: null },
  ] }, { trace: true });
  process.stdout.write(`rounds=${r.rounds}\n${JSON.stringify(r.violations, null, 1)}\n`);
  process.stdout.write(r.trace.slice(0, 80).join("\n") + "\n");
}, 120000);
