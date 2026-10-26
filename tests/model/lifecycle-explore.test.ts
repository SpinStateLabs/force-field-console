// Exhaustive small-scope exploration (see gen.ts smallScope for the exact scope). Shardable:
// EX_START / EX_COUNT select a slice of the enumeration (by index), EX_OUT the results dir. Failures are
// appended as they are found; a progress file is rewritten every 250 cases.
import { describe, it, vi } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { runCase } from "./harness";
import { smallScope } from "./gen";

const START = Number(process.env.EX_START ?? 0);
const COUNT = Number(process.env.EX_COUNT ?? 40);
const OUT = process.env.EX_OUT ?? "";

describe("lifecycle small-scope exploration", () => {
  it(`enumeration slice ${START}..${START + COUNT - 1}`, async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    if (OUT) mkdirSync(OUT, { recursive: true });
    let i = -1;
    let ran = 0;
    let failed = 0;
    let total = 0;
    const groups: Record<string, number> = {};
    const w0 = performance.now();
    for (const { name, sc } of smallScope()) {
      i++;
      total++;
      if (i < START || i >= START + COUNT) continue;
      ran++;
      try {
        const r = await runCase(sc);
        if (r.violations.length) {
          failed++;
          for (const v of r.violations) groups[v.inv + "|" + v.key] = (groups[v.inv + "|" + v.key] ?? 0) + 1;
          if (OUT) appendFileSync(`${OUT}/explore-${START}.jsonl`, JSON.stringify({ seed: i, name, violations: r.violations, sc }) + "\n");
        }
      } catch (e: any) {
        if (OUT) appendFileSync(`${OUT}/explore-${START}.jsonl`, JSON.stringify({ seed: i, name, harnessError: String(e?.stack ?? e).slice(0, 600), sc }) + "\n");
      }
      if (OUT && ran % 250 === 0) writeFileSync(`${OUT}/explore-${START}.progress.json`, JSON.stringify({ start: START, ran, failed, groups, wallS: Math.round((performance.now() - w0) / 1000) }, null, 1));
    }
    if (OUT) writeFileSync(`${OUT}/explore-${START}.progress.json`, JSON.stringify({ start: START, ran, failed, groups, enumerationSize: total, wallS: Math.round((performance.now() - w0) / 1000), complete: true }, null, 1));
    process.stdout.write(`EXPLORE ${START}+${COUNT}: ran ${ran} of ${total}, failed ${failed}, groups ${JSON.stringify(groups)}\n`);
  }, 24 * 3600_000);
});
