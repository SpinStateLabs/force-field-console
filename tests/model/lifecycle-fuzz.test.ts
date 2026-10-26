// Seeded model-based fuzzing of the portal lifecycle (fast-check generated scenarios, the REAL code).
// Env: FZ_START (first seed index, default 0), FZ_COUNT (cases, default 60), FZ_OUT (results dir).
// Every failure is appended to <out>/fuzz-<start>.jsonl immediately and a progress line is written every
// 250 cases, so a killed run keeps everything it found.
import { describe, it, vi } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { runCase } from "./harness";
import { scenarioForSeed } from "./gen";

const START = Number(process.env.FZ_START ?? 0);
const COUNT = Number(process.env.FZ_COUNT ?? 60);
const OUT = process.env.FZ_OUT ?? "";

describe("lifecycle fuzz", () => {
  it(`seeds ${START}..${START + COUNT - 1}`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    if (OUT) mkdirSync(OUT, { recursive: true });
    const groups: Record<string, number> = {};
    let failed = 0;
    let errors = 0;
    let rounds = 0;
    const t0 = Date.now();
    const realNow = () => performance.now();
    const w0 = realNow();
    const bac: number[] = [];
    for (let i = 0; i < COUNT; i++) {
      const seed = START + i;
      const sc = scenarioForSeed(seed);
      try {
        const r = await runCase(sc);
        rounds += r.rounds;
        bac.push(...r.billingAfterCancelMs);
        if (r.violations.length) {
          failed++;
          for (const v of r.violations) groups[v.inv + "|" + v.key] = (groups[v.inv + "|" + v.key] ?? 0) + 1;
          if (OUT) appendFileSync(`${OUT}/fuzz-${START}.jsonl`, JSON.stringify({ seed, violations: r.violations, sc }) + "\n");
        }
      } catch (e: any) {
        errors++;
        if (OUT) appendFileSync(`${OUT}/fuzz-${START}.jsonl`, JSON.stringify({ seed, harnessError: String(e?.stack ?? e).slice(0, 600), sc }) + "\n");
      }
      if (OUT && ((i + 1) % 250 === 0 || i + 1 === COUNT)) {
        bac.sort((a, b) => a - b);
        const q = (p: number) => (bac.length ? bac[Math.min(bac.length - 1, Math.floor(p * bac.length))] : null);
        writeFileSync(`${OUT}/fuzz-${START}.progress.json`, JSON.stringify({ start: START, done: i + 1, of: COUNT, failedCases: failed, harnessErrors: errors, groups, avgRounds: rounds / (i + 1), wallS: Math.round((realNow() - w0) / 1000), billingAfterCancelMs: { n: bac.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: bac[bac.length - 1] ?? null } }, null, 1));
      }
    }
    void t0;
    process.stdout.write(`FUZZ ${START}+${COUNT}: failed ${failed}, errors ${errors}, groups ${JSON.stringify(groups)}\n`);
  }, 24 * 3600_000);
});
