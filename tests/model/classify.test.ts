// Re-run every recorded failing case (CL_IN dirs, comma-separated, of *.jsonl) with the current harness and
// assign a ROOT-CAUSE group from the observed mechanism. Writes CL_OUT (json) with counts and examples.
import { it, vi } from "vitest";
import { readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { runCase, type CaseResult } from "./harness";
import type { Scenario } from "./scenario";

const IN = (process.env.CL_IN ?? "").split(",").filter(Boolean);
const OUT = process.env.CL_OUT ?? "";
const START = Number(process.env.CL_START ?? 0);
const COUNT = Number(process.env.CL_COUNT ?? 1e9);

export function rootCause(sc: Scenario, r: CaseResult): string[] {
  const out = new Set<string>();
  const faults = sc.actions.filter((a) => a.k === "fault") as any[];
  const has = (k: string) => faults.some((a) => a.f[k]);
  for (const v of r.violations) {
    const d = v.detail;
    if (v.inv === "S6") out.add(v.key === "late-autostart-on-update" ? "late-config-write-after-suspend" : "S6-other");
    else if (v.inv === "S2") out.add(has("pSlow") || has("pSlowUpdate") ? "create-timeout-or-concurrent-drivers" : "concurrent-provision-drivers");
    else if (v.inv === "S5") out.add("leak:" + v.key);
    else if (v.inv === "Q") out.add("no-quiescence");
    else if (/answered 200 duplicate while their claim was still processing/.test(d)) out.add("processing-claim-acked-200");
    else if (has("transient404")) out.add("a10-transient-404");
    else if (/S1|L2/.test(v.inv) && r.violations.some((x) => x.inv === "S6")) out.add("late-config-write-after-suspend");
    else if (sc.actions.some((a) => a.k === "stripe" && a.op.k === "newsub" && !a.op.meta) && /estate=none|others=\{\}/.test(d) && /S4|L1/.test(v.inv)) out.add("unknown-user-before-pointer");
    else {
      // equal-second Stripe ops on one subscription
      let t = 0, last: Record<string, number> = {}, same = false;
      for (const a of sc.actions) {
        if (a.k === "stripe") {
          const key = a.op.u + ":" + a.op.sub;
          if (last[key] !== undefined && Math.floor(last[key] / 1000) === Math.floor(t / 1000)) same = true;
          last[key] = t;
          t += a.gap;
        } else if ("gap" in a) t += a.gap;
        else if (a.k === "jump") t += a.ms;
      }
      out.add(same ? "g2-equal-second" : "unclassified:" + v.inv + "|" + v.key);
    }
  }
  return [...out];
}

it("classify", async () => {
  if (!IN.length || !OUT) return;
  vi.useFakeTimers({ toFake: ["Date"] });
  const cases: any[] = [];
  for (const dir of IN) for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) for (const l of readFileSync(`${dir}/${f}`, "utf8").split("\n")) if (l.trim()) cases.push({ src: dir.split(/[\/]/).pop(), ...JSON.parse(l) });
  const slice = cases.slice(START, START + COUNT);
  const counts: Record<string, number> = {};
  let reproduced = 0, vanished = 0;
  const examples: Record<string, any> = {};
  for (const c of slice) {
    if (!c.sc) continue;
    const r = await runCase(c.sc);
    if (!r.violations.length) { vanished++; continue; }
    reproduced++;
    for (const g of rootCause(c.sc, r)) {
      counts[g] = (counts[g] ?? 0) + 1;
      if (!examples[g] || c.sc.actions.length < examples[g].sc.actions.length) examples[g] = { src: c.src, seed: c.seed, name: c.name, sc: c.sc, violations: r.violations };
    }
    appendFileSync(OUT + ".lines.jsonl", JSON.stringify({ src: c.src, seed: c.seed, groups: rootCause(c.sc, r) }) + "\n");
  }
  writeFileSync(OUT, JSON.stringify({ total: slice.length, reproduced, vanished, counts, examples }, null, 1));
}, 6 * 3600_000);
