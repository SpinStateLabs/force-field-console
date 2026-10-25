import { it, vi } from "vitest";
import { runCase } from "./harness";
it("dbg", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const t = performance.now();
  const r = await runCase({ seed: 1, users: ["ready"], stripeRetryMs: 60000, actions: [{ k: "tick", gap: 120000, crashAt: null }] }, { trace: true });
  process.stdout.write(`ms=${performance.now() - t} rounds=${r.rounds} v=${JSON.stringify(r.violations)} fly=${r.flyCalls} store=${r.storeOps}\n`);
  process.stdout.write(r.trace.slice(0, 60).join("\n") + "\n");
}, 120000);
