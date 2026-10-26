// Triage: read failing cases (TR_IN dir of *.jsonl), group by invariant|key, shrink up to TR_PER per group,
// write minimal repros (scenario + trace) to TR_OUT/<group>.json as each one finishes.
import { it, vi } from "vitest";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { runCase } from "./harness";
import { shrink } from "./gen";
import { describeAction } from "./scenario";

const IN = process.env.TR_IN ?? "";
const OUT = process.env.TR_OUT ?? "";
const PER = Number(process.env.TR_PER ?? 2);
const ONLY = process.env.TR_ONLY ?? "";

it("triage", async () => {
  if (!IN || !OUT) return;
  vi.useFakeTimers({ toFake: ["Date"] });
  mkdirSync(OUT, { recursive: true });
  const cases: any[] = [];
  for (const f of readdirSync(IN).filter((f) => f.endsWith(".jsonl"))) for (const l of readFileSync(`${IN}/${f}`, "utf8").split("\n")) if (l.trim()) cases.push(JSON.parse(l));
  const byGroup = new Map<string, any[]>();
  for (const c of cases) for (const v of c.violations ?? []) {
    const g = v.inv + "|" + v.key;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(c);
  }
  const summary: any = {};
  for (const [g, cs] of [...byGroup.entries()].sort()) {
    if (ONLY && !g.includes(ONLY)) continue;
    const [inv, key] = g.split("|");
    const file = `${OUT}/${g.replace(/[^a-zA-Z0-9_-]+/g, "_")}.json`;
    summary[g] = cs.length;
    if (existsSync(file)) continue;
    const repros: any[] = [];
    // shortest originals first
    for (const c of [...cs].sort((a, b) => a.sc.actions.length - b.sc.actions.length).slice(0, PER)) {
      const { sc, runs } = await shrink(c.sc, { inv, key }, (s) => runCase(s), 300);
      const r = await runCase(sc, { trace: true });
      repros.push({ fromSeed: c.seed, shrinkRuns: runs, scenario: sc, steps: sc.actions.map(describeAction), users: sc.users, stripeRetryMs: sc.stripeRetryMs, violations: r.violations, trace: r.trace });
    }
    writeFileSync(file, JSON.stringify({ group: g, cases: cs.length, repros }, null, 1));
  }
  writeFileSync(`${OUT}/_summary.json`, JSON.stringify(summary, null, 1));
}, 6 * 3600_000);
