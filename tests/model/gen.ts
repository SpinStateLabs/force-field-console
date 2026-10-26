// fast-check generators for lifecycle scenarios, the small-scope enumerator, and the shrinker.
import fc from "fast-check";
import type { Action, Scenario, StripeOp, SubStatus, UserInit } from "./scenario";
import { World, type CaseResult } from "./harness";

const gapA = fc.constantFrom(0, 0, 50, 300, 1500, 15_000, 60_000, 130_000);
const stripeGap = fc.constantFrom(0, 400, 1500, 1500, 20_000, 130_000);
const statusA: fc.Arbitrary<SubStatus> = fc.constantFrom("active", "trialing", "past_due", "unpaid", "canceled", "canceled", "incomplete_expired", "paused");
const user = fc.constantFrom(0, 0, 1);
const subN = fc.constantFrom(1, 1, 2, 3);
const price = fc.constantFrom<"op" | "sov">("op", "op", "sov");
const crash = fc.oneof({ weight: 6, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 30 }) });

const stripeOp: fc.Arbitrary<StripeOp> = fc.oneof(
  { weight: 1, arbitrary: fc.record({ k: fc.constant("checkout" as const), u: user, sub: subN, price }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("newsub" as const), u: user, sub: subN, price, status: fc.constantFrom<SubStatus>("active", "active", "trialing", "incomplete"), meta: fc.boolean() }) },
  { weight: 6, arbitrary: fc.record({ k: fc.constant("status" as const), u: user, sub: subN, status: statusA }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("plan" as const), u: user, sub: subN, price }) },
);

const faultA = fc.record({
  f: fc.record(
    {
      p5xxBefore: fc.constantFrom(0, 0, 0.3, 1),
      p5xxAfter: fc.constantFrom(0, 0, 0.3),
      pUnreachable: fc.constantFrom(0, 0, 0.2),
      pStale: fc.constantFrom(0, 0, 0.5),
      staleWindowMs: fc.constantFrom(3000, 15_000),
      pSlow: fc.constantFrom(0, 0, 0.3),
      slowMs: fc.constantFrom(9000, 25_000),
      pSlowUpdate: fc.constantFrom(0, 0, 1),
      slowUpdateMs: fc.constantFrom(12_000, 25_000),
      stopIneffective: fc.oneof({ weight: 8, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
      waitLies: fc.oneof({ weight: 8, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
      updateIgnored: fc.oneof({ weight: 8, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
      transient404: fc.oneof({ weight: 12, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.constant(0.2) }),
    },
    { requiredKeys: [] },
  ),
  stripeTimeout: fc.constantFrom(0, 0, 0, 0.5),
});

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ k: fc.constant("stripe" as const), op: stripeOp, gap: stripeGap }) },
  { weight: 6, arbitrary: fc.record({ k: fc.constant("deliver" as const), ev: fc.nat(12), gap: gapA, limitMs: fc.constantFrom(60_000, 60_000, 60_000, 10_000), crashAt: crash }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("tick" as const), gap: gapA, crashAt: crash }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("poll" as const), u: user, gap: gapA, crashAt: crash }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("key" as const), u: user, gap: gapA }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("upgrade" as const), u: user, gap: gapA }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("retry" as const), u: user, gap: gapA }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("proxy" as const), u: user }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("pstop" as const), u: user }) },
  { weight: 2, arbitrary: faultA.map((x) => ({ k: "fault" as const, f: x.f, stripeTimeout: x.stripeTimeout })) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("jump" as const), ms: fc.constantFrom(60_000, 600_000, 3_600_000) }) },
);

export const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  seed: fc.nat(),
  users: fc.oneof(fc.tuple(fc.constantFrom<UserInit>("ready", "new")).map((t) => [...t]), fc.tuple(fc.constantFrom<UserInit>("ready", "new"), fc.constantFrom<UserInit>("ready", "new")).map((t) => [...t])),
  stripeRetryMs: fc.constantFrom(30_000, 300_000, 3_600_000),
  actions: fc.array(action, { minLength: 1, maxLength: 16 }),
});

export function scenarioForSeed(seed: number): Scenario {
  return fc.sample(scenarioArb, { seed, numRuns: 1 })[0];
}

// ------------------------------------------------------------------ small-scope enumeration
//
// Scope (documented in the report):
//  - user 0 starts READY (paying on sub1, machine running) or NEW (checkout of sub1 first);
//  - user 1 starts READY and is cancelled once, its event delivered concurrently with user 0's first delivery;
//  - user 0 Stripe op sequences of length 1..3 over ALPHABET (6 ops, sub1..sub3), each op either in its own
//    second (distinct `created`) or in the same second as the previous one;
//  - delivery orders: every permutation of the emitted events when there are <= 4 of them, else 24 fixed
//    permutations; each delivered sequentially (30 s apart) without faults;
//  - for the identity and the reverse order only: each of FAULTS x {sequential 30 s, concurrent 0-50 ms}.
export const ALPHABET: { name: string; op: (u: number) => StripeOp }[] = [
  { name: "c1", op: (u) => ({ k: "status", u, sub: 1, status: "canceled" }) },
  { name: "x1", op: (u) => ({ k: "status", u, sub: 1, status: "unpaid" }) },
  { name: "a1", op: (u) => ({ k: "status", u, sub: 1, status: "active" }) },
  { name: "n2", op: (u) => ({ k: "newsub", u, sub: 2, price: "op", status: "active", meta: true }) },
  { name: "m3", op: (u) => ({ k: "newsub", u, sub: 3, price: "sov", status: "active", meta: false }) },
  { name: "c2", op: (u) => ({ k: "status", u, sub: 2, status: "canceled" }) },
];

export type FaultChoice = { name: string; pre: Action[]; deliver?: Partial<Extract<Action, { k: "deliver" }>>; extra?: Action[] };
export const FAULTS: FaultChoice[] = [
  { name: "crash@3", pre: [], deliver: { crashAt: 3 } },
  { name: "crash@8", pre: [], deliver: { crashAt: 8 } },
  { name: "crash@14", pre: [], deliver: { crashAt: 14 } },
  { name: "limit10s+slowupdate", pre: [{ k: "fault", f: { pSlowUpdate: 1, slowUpdateMs: 25_000 }, stripeTimeout: 0 }], deliver: { limitMs: 10_000 } },
  { name: "fly5xx", pre: [{ k: "fault", f: { p5xxBefore: 1 }, stripeTimeout: 0 }] },
  { name: "stale", pre: [{ k: "fault", f: { pStale: 0.5, staleWindowMs: 15_000 }, stripeTimeout: 0 }] },
  { name: "dup-first", pre: [], extra: [{ k: "deliver", ev: 0, gap: 30_000, limitMs: 60_000, crashAt: null }] },
  { name: "tick-between", pre: [], extra: [] },
];

function permutations<T>(a: T[]): T[][] {
  if (a.length <= 1) return [a.slice()];
  const out: T[][] = [];
  a.forEach((x, i) => {
    for (const p of permutations([...a.slice(0, i), ...a.slice(i + 1)])) out.push([x, ...p]);
  });
  return out;
}

function eventCount(users: UserInit[], ops: StripeOp[]): number {
  const w = new World({ seed: 0, users, stripeRetryMs: 60_000, actions: [] });
  for (const o of ops) w.applyStripe(o);
  return w.events.length;
}

export function* smallScope(): Generator<{ name: string; sc: Scenario }> {
  const seqs: number[][] = [];
  for (let L = 1; L <= 3; L++) {
    const rec = (pre: number[]) => {
      if (pre.length === L) return void seqs.push(pre);
      for (let i = 0; i < ALPHABET.length; i++) rec([...pre, i]);
    };
    rec([]);
  }
  let n = 0;
  for (const init of ["ready", "new"] as UserInit[]) {
    for (const seq of seqs) {
      for (const sameSecond of [false, true]) {
        const ops: StripeOp[] = [];
        if (init === "new") ops.push({ k: "checkout", u: 0, sub: 1, price: "op" });
        for (const i of seq) ops.push(ALPHABET[i].op(0));
        const users: UserInit[] = [init, "ready"];
        const evs = eventCount(users, [...ops, { k: "status", u: 1, sub: 1, status: "canceled" }]);
        const nev = evs - 1; // user 1's cancel is the last event
        const u1ev = nev;
        if (nev === 0) continue;
        const idx = Array.from({ length: nev }, (_, i) => i);
        let perms = permutations(idx.slice(0, Math.min(nev, 4)));
        if (nev > 4) perms = perms.map((p) => [...p, ...idx.slice(4)]); // 24 fixed orders of the first four, the rest in order
        const stripeActs: Action[] = ops.map((op, i) => ({ k: "stripe", op, gap: i === 0 ? 1000 : sameSecond ? 0 : 1500 }));
        stripeActs.push({ k: "stripe", op: { k: "status", u: 1, sub: 1, status: "canceled" }, gap: 1000 });
        const label = `${init}:${seq.map((i) => ALPHABET[i].name).join(",")}${sameSecond ? ":same-second" : ""}`;
        const mk = (order: number[], f: FaultChoice | null, concurrent: boolean): Scenario => {
          const acts: Action[] = [...stripeActs, ...(f?.pre ?? [])];
          order.forEach((evi, j) => {
            acts.push({ k: "deliver", ev: evi, gap: concurrent ? 25 : 30_000, limitMs: 60_000, crashAt: null, ...(j === 0 ? f?.deliver ?? {} : {}) } as Action);
            if (j === 0) acts.push({ k: "deliver", ev: u1ev, gap: concurrent ? 10 : 30_000, limitMs: 60_000, crashAt: null });
            if (f?.name === "tick-between" && j === 0) acts.push({ k: "tick", gap: concurrent ? 15 : 30_000, crashAt: null });
          });
          acts.push(...(f?.extra ?? []));
          return { seed: 1000 + n, users, stripeRetryMs: 300_000, actions: acts };
        };
        for (const p of perms) {
          n++;
          yield { name: `${label} order=${p.join("")}`, sc: mk(p, null, false) };
        }
        const special = [idx, [...idx].reverse()].filter((p, i, a) => i === 0 || p.join() !== a[0].join());
        for (const p of special)
          for (const f of FAULTS)
            for (const conc of [false, true]) {
              n++;
              yield { name: `${label} order=${p.join("")} fault=${f.name}${conc ? " concurrent" : ""}`, sc: mk(p, f, conc) };
            }
        // concurrent delivery without faults for the identity order
        n++;
        yield { name: `${label} order=${idx.join("")} concurrent`, sc: mk(idx, null, true) };
      }
    }
  }
}

// ------------------------------------------------------------------ shrinking
export type Sig = { inv: string; key: string };

function variants(sc: Scenario): Scenario[] {
  const out: Scenario[] = [];
  const A = sc.actions;
  // drop chunks of actions (largest first), then single actions
  for (let size = Math.max(1, Math.floor(A.length / 2)); size >= 1; size = Math.floor(size / 2)) {
    for (let i = 0; i + size <= A.length; i += size) out.push({ ...sc, actions: [...A.slice(0, i), ...A.slice(i + size)] });
    if (size === 1) break;
  }
  // fewer users
  if (sc.users.length > 1) for (const keep of [0, 1]) out.push({ ...sc, users: [sc.users[keep]], actions: A.filter((a) => (a.k === "stripe" ? a.op.u % 2 === keep : !("u" in a) || a.u % 2 === keep)).map((a) => ("u" in a ? { ...a, u: 0 } : "op" in a ? { ...a, op: { ...a.op, u: 0 } } : a)) as Action[] });
  // simplify single actions
  A.forEach((a, i) => {
    const put = (b: Action) => out.push({ ...sc, actions: [...A.slice(0, i), b, ...A.slice(i + 1)] });
    if ("gap" in a && a.gap !== 0 && a.gap !== 30_000) put({ ...a, gap: 30_000 } as Action);
    if ("crashAt" in a && a.crashAt !== null) put({ ...a, crashAt: null } as Action);
    if (a.k === "deliver" && a.limitMs !== 60_000) put({ ...a, limitMs: 60_000 });
    if (a.k === "fault") {
      for (const key of Object.keys(a.f)) {
        const f: any = { ...a.f };
        delete f[key];
        if (Object.keys(f).length !== Object.keys(a.f).length) put({ ...a, f });
      }
      if (a.stripeTimeout) put({ ...a, stripeTimeout: 0 });
    }
  });
  return out;
}

/** Greedy delta-debugging: the smallest scenario (fewest actions, simplest faults) that still shows `sig`. */
export async function shrink(sc: Scenario, sig: Sig, run: (sc: Scenario) => Promise<CaseResult>, budget = 400): Promise<{ sc: Scenario; runs: number }> {
  let best = sc;
  let runs = 0;
  const has = (r: CaseResult) => r.violations.some((v) => v.inv === sig.inv && v.key === sig.key);
  let improved = true;
  while (improved && runs < budget) {
    improved = false;
    for (const v of variants(best)) {
      if (runs >= budget) break;
      runs++;
      let r: CaseResult;
      try {
        r = await run(v);
      } catch {
        continue;
      }
      if (has(r)) {
        best = v;
        improved = true;
        break;
      }
    }
  }
  // normalise unused fault fields away for readability
  return { sc: best, runs };
}
