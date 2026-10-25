// Virtual time for model-based tests of the REAL portal functions.
//
// - Date is frozen (vitest fake Date) and moved only by this scheduler.
// - globalThis.setTimeout / clearTimeout and AbortSignal.timeout are replaced while a case runs, so
//   every sleep, lock wait, read-back delay, Fly/Stripe client timeout and function time limit happens
//   in VIRTUAL time: a 20 s Fly timeout costs nothing, and the order of events is decided by the
//   scenario (latencies), not by the host machine.
// - Every invocation (a webhook delivery, a tick, a dashboard write, a worker) runs in its own
//   AsyncLocalStorage context. Killing it (platform time limit, a crash after the k-th I/O) drops
//   every later callback of that context: no further store write or Fly call is ever made by it, and
//   no `finally` runs (a killed Netlify function does not release its locks). Requests it had
//   already sent still land (see the Fly / store models).
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { vi } from "vitest";

export type Inv = {
  id: number;
  kind: string;
  label: string;
  dead: boolean;
  killedBy: string | null;
  ops: number;
  killAtOp: number | null;
  startedAt: number;
  endedAt: number | null;
  done: boolean;
  result?: any;
  error?: any;
  onEnd?: (inv: Inv) => void;
};

function ended(inv: Inv) {
  const f = inv.onEnd;
  inv.onEnd = undefined;
  if (f) f(inv);
}

export const als = new AsyncLocalStorage<Inv>();
export const NEVER: Promise<never> = new Promise<never>(() => {});

const real = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setImmediate: globalThis.setImmediate,
  abortTimeout: AbortSignal.timeout.bind(AbortSignal),
};

type Timer = { t: number; seq: number; fn: () => void; inv: Inv | undefined; cancelled: boolean; ref(): Timer; unref(): Timer; hasRef(): boolean; [Symbol.toPrimitive](): number };

export class VClock {
  now = 0;
  private q: Timer[] = [];
  private seq = 0;
  private invSeq = 0;
  invocations: Inv[] = [];
  installed = false;

  install(startMs: number): void {
    this.now = startMs;
    this.q = [];
    this.invocations = [];
    vi.setSystemTime(startMs);
    const self = this;
    globalThis.setTimeout = ((fn: (...a: any[]) => void, ms?: number, ...args: any[]) => self.schedule(Number(ms) || 0, () => fn(...args))) as any;
    globalThis.clearTimeout = ((h: any) => {
      if (h && typeof h === "object" && "cancelled" in h) h.cancelled = true;
      else real.clearTimeout(h);
    }) as any;
    (AbortSignal as any).timeout = (ms: number) => {
      const c = new AbortController();
      self.schedule(ms, () => c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
      return c.signal;
    };
    this.installed = true;
  }

  uninstall(): void {
    globalThis.setTimeout = real.setTimeout;
    globalThis.clearTimeout = real.clearTimeout;
    (AbortSignal as any).timeout = real.abortTimeout;
    this.q = [];
    this.installed = false;
  }

  schedule(ms: number, fn: () => void): Timer {
    const inv = als.getStore();
    const timer: Timer = {
      t: this.now + Math.max(0, ms),
      seq: this.seq++,
      fn: AsyncResource.bind(fn),
      inv,
      cancelled: false,
      ref() { return timer; },
      unref() { return timer; },
      hasRef() { return true; },
      [Symbol.toPrimitive]() { return timer.seq; },
    };
    // binary insertion by (t, seq)
    let lo = 0;
    let hi = this.q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.q[mid];
      if (m.t < timer.t || (m.t === timer.t && m.seq < timer.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.q.splice(lo, 0, timer);
    return timer;
  }

  /** Schedule outside any invocation: runs even when the caller has been killed (a request in flight lands). */
  scheduleDetached(ms: number, fn: () => void): Timer {
    return als.exit(() => this.schedule(ms, fn));
  }

  /** A virtual sleep inside the current context (never resolves for a killed invocation). */
  sleep(ms: number): Promise<void> {
    return new Promise<void>((r) => this.schedule(ms, r));
  }

  private setNow(t: number): void {
    if (t > this.now) {
      this.now = t;
      vi.setSystemTime(t);
    }
  }

  /** Drain microtasks (and any real-async completions) without moving virtual time. */
  async flush(): Promise<void> {
    for (let i = 0; i < 2; i++) await new Promise<void>((r) => real.setImmediate(r));
  }

  nextAt(): number | null {
    while (this.q.length && this.q[0].cancelled) this.q.shift();
    return this.q.length ? this.q[0].t : null;
  }

  /** Run every timer due up to tEnd (inclusive), then set the clock to tEnd. */
  async runUntil(tEnd: number): Promise<void> {
    for (;;) {
      await this.flush();
      const at = this.nextAt();
      if (at === null || at > tEnd) break;
      const t = this.q.shift()!;
      this.setNow(t.t);
      if (t.inv?.dead) continue;
      try {
        t.fn();
      } catch (e) {
        // a timer callback threw synchronously: record on the invocation if any
        if (t.inv) t.inv.error = t.inv.error ?? e;
      }
    }
    this.setNow(tEnd);
    await this.flush();
  }

  /** Start an invocation at the current virtual time. */
  invoke<T>(kind: string, label: string, fn: () => Promise<T>, opts: { limitMs?: number | null; killAtOp?: number | null } = {}): Inv {
    const inv: Inv = { id: ++this.invSeq, kind, label, dead: false, killedBy: null, ops: 0, killAtOp: opts.killAtOp ?? null, startedAt: this.now, endedAt: null, done: false };
    this.invocations.push(inv);
    als.run(inv, () => {
      if (opts.limitMs) {
        this.schedule(opts.limitMs, () => {
          if (!inv.done && !inv.dead) {
            inv.dead = true;
            inv.killedBy = "time_limit";
            inv.endedAt = this.now;
          }
        });
      }
      Promise.resolve()
        .then(fn)
        .then(
          (r) => {
            if (inv.dead) return;
            inv.done = true;
            inv.result = r;
            inv.endedAt = this.now;
          },
          (e) => {
            if (inv.dead) return;
            inv.done = true;
            inv.error = e;
            inv.endedAt = this.now;
          },
        );
    });
    return inv;
  }

  /** Called by the store / network models before every I/O: false when the caller is dead (or dies now). */
  ioAllowed(): boolean {
    const inv = als.getStore();
    if (!inv) return true;
    if (inv.dead) return false;
    inv.ops += 1;
    if (inv.killAtOp !== null && inv.ops >= inv.killAtOp) {
      inv.dead = true;
      inv.killedBy = "crash_at_op_" + inv.ops;
      inv.endedAt = this.now;
      return false;
    }
    return true;
  }

  current(): Inv | undefined {
    return als.getStore();
  }

  liveInvocations(): Inv[] {
    return this.invocations.filter((i) => !i.done && !i.dead);
  }
}

export const clock = new VClock();
