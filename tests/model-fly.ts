// A stand-in for the Fly Machines API that MODELS what matters for suspend/resume:
//  - the proxy wakes a stopped machine whose service has autostart on (ping), a service WITHOUT the
//    field counts as autostart on (Fly's default);
//  - updateMachine launches the machine unless skip_launch (and restarts a running one: `restarts`);
//  - updates can land late (updateDelay), waits take time (waitDelay), reads can be stale once
//    after an update (staleReads), and the machine config is stored whole so tests can check
//    that env / mounts / checks / guest / restart / metadata survive.
// Machines are created lazily on first touch: started, one service, autostart on.
import { FlyError } from "../src/lib/fly";

export type ModelMachine = { id: string; name: string; state: string; config: any };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A realistic Fly failure: app name, machine id, URL, a bearer-looking token and an HTTP status in the text. */
export const flyErr = (status: number, op: string, id: string) =>
  new FlyError(
    status,
    `Fly POST /apps/ff-est-0123abcd/machines/${id}/${op} answered HTTP ${status}: {"error":"could not reach https://api.machines.dev/v1/apps/ff-est-0123abcd (Bearer fo1_LEAKME0123456789abcdef rejected)"}`,
  );
/** What must never reach users (publicEstate, /api/health, stored user-visible text). */
export const FLY_LEAK_RE = /fo1_|Bearer|api\.machines\.dev|\/apps\/|ff-est-0123abcd\/|answered|HTTP \d{3}|LEAKME/;

export const RICH_CONFIG = () => ({
  image: "registry.fly.io/x:y",
  env: { FIELD_DATA_DIR: "/data", FORCE_GATEWAY_ENFORCE: "1" },
  services: [
    { protocol: "tcp", internal_port: 8080, autostop: "off", autostart: true, min_machines_running: 1, ports: [{ port: 443, handlers: ["tls", "http"] }] },
    { protocol: "tcp", internal_port: 9090, autostop: "off", autostart: true, ports: [{ port: 9090 }] },
    { protocol: "tcp", internal_port: 7070 }, // no autostart field at all
  ],
  checks: { ledger: { type: "http", port: 8080, path: "/ledger/health", interval: "30s" } },
  mounts: [{ volume: "vol_1", path: "/data", name: "ff_data" }],
  guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
  restart: { policy: "always" },
  metadata: { "ff-portal": "estate" },
});

export class ModelFly {
  machines = new Map<string, ModelMachine>();
  /** Every call, in order: "get m_1", "update m_1 autostart=false skip=true", "stop m_1", ... */
  log: string[] = [];
  restarts = 0;
  secrets: Record<string, string> = {};
  failUpdate = false;
  failUpdateAfter: number | null = null; // fail every update after this many successful ones
  updatesDone = 0;
  failStop = false;
  failStart = false;
  failStartWith: Error | null = null;
  bootMs = 0; // start is accepted at once, the machine reads "starting" until it has booted
  private bootAt = 0;
  failGet = false;
  failStopWith: Error | null = null;
  ignoreUpdate = false; // Fly answers 200 but does not apply the change (read-back must catch it)
  getReturnsNull = false;
  updateThrows404 = false;
  stopNoop = false; // stop answers OK but the machine keeps running
  waitLies = false; // wait reports success regardless of the state
  waitNever = false; // wait never reports the wanted state (timeout)
  stopDelay = 0;
  startDelay = 0;
  updateDelay = 0; // every update lands this long after it was issued
  updateDelayOnce = 0; // only the NEXT update is slow (a stale writer's config landing late)
  waitDelay = 0;
  staleReads = 0; // the next N reads return the snapshot taken before the latest update
  staleAfterUpdate = 0; // after EVERY update the next N reads are stale
  private snapshot: ModelMachine | null = null;

  // --- opt-in faithful mode (defaults keep the behaviour every existing test was written against) ---
  /** No lazy creation: an unknown or destroyed machine answers 404 (getMachine -> null, writes throw FlyError 404). */
  strict = false;
  /** Eventually consistent reads: with probability eventualP a read returns ANY version current within the last eventualMs. */
  eventualMs = 0;
  eventualP = 0;
  /** Probability that any call fails with 500 / 502 / 503 / 429 before it is applied. */
  p5xx = 0;
  /** Honour the wait timeout: a wait whose waitDelay exceeds timeoutS answers false (Fly's 408) after timeoutS. */
  honourWaitTimeout = false;
  rand: () => number = Math.random;
  private history = new Map<string, { at: number; state: string; config: any }[]>();

  private record(m: ModelMachine): void {
    if (!this.eventualMs) return;
    const h = this.history.get(m.id) ?? [];
    h.push({ at: Date.now(), state: m.state, config: structuredClone(m.config) });
    if (h.length > 30) h.shift();
    this.history.set(m.id, h);
  }
  private maybe5xx(op: string, id: string): void {
    if (this.p5xx > 0 && this.rand() < this.p5xx) throw flyErr([500, 502, 503, 429][Math.floor(this.rand() * 4)], op, id);
  }
  private gone(id: string): boolean {
    const m = this.machines.get(id);
    return this.strict && (!m || m.state === "destroyed");
  }
  /** Fly destroys the machine (operator, host loss): later calls answer 404 in strict mode. */
  destroy(id: string): void {
    const m = this.machines.get(id);
    if (m) m.state = "destroyed";
  }

  machine(id: string, over: Partial<ModelMachine> & { autostart?: boolean } = {}): ModelMachine {
    let m = this.machines.get(id);
    if (m && m.state === "starting" && Date.now() >= this.bootAt) m.state = "started";
    if (!m) {
      m = { id, name: "estate", state: over.state ?? "started", config: over.config ?? { image: "img", services: [{ internal_port: 8080, autostart: over.autostart ?? true }] } };
      this.machines.set(id, m);
    }
    return m;
  }

  async getMachine(_app: string, id: string): Promise<any> {
    this.log.push("get " + id);
    if (this.failGet) throw flyErr(500, "", id);
    if (this.getReturnsNull) return null;
    this.maybe5xx("", id);
    if (this.gone(id)) return null; // FlyClient.getMachine maps 404 to null
    if (this.eventualMs && this.rand() < this.eventualP) {
      const lo = Date.now() - this.eventualMs;
      const h = (this.history.get(id) ?? []).filter((v, i, a) => v.at >= lo || a[i + 1] === undefined || a[i + 1].at >= lo);
      if (h.length) {
        const v = h[Math.floor(this.rand() * h.length)];
        return { ...structuredClone(this.machine(id)), state: v.state, config: structuredClone(v.config) };
      }
    }
    if (this.staleReads > 0 && this.snapshot && this.snapshot.id === id) {
      this.staleReads -= 1;
      return structuredClone(this.snapshot);
    }
    return structuredClone(this.machine(id));
  }

  async updateMachine(_app: string, id: string, config: any, opts: { skipLaunch?: boolean } = {}): Promise<any> {
    this.log.push(`update ${id} autostart=${config.services?.[0]?.autostart} skip=${Boolean(opts.skipLaunch)}`);
    if (this.updateThrows404 || this.gone(id)) throw new FlyError(404, "gone");
    if (this.failUpdate || (this.failUpdateAfter !== null && this.updatesDone >= this.failUpdateAfter)) throw flyErr(500, "", id);
    this.maybe5xx("", id);
    const m = this.machine(id);
    this.snapshot = structuredClone(m);
    const d = this.updateDelayOnce || this.updateDelay;
    this.updateDelayOnce = 0;
    await sleep(d);
    this.updatesDone += 1;
    if (this.staleAfterUpdate) this.staleReads = this.staleAfterUpdate;
    if (!this.ignoreUpdate) m.config = structuredClone(config);
    if (!opts.skipLaunch) {
      if (m.state === "started") this.restarts += 1;
      m.state = "started"; // an update launches the machine unless skip_launch
    }
    this.record(m);
    return structuredClone(m);
  }

  async stopMachine(_app: string, id: string): Promise<void> {
    this.log.push("stop " + id);
    await sleep(this.stopDelay);
    if (this.failStopWith) throw this.failStopWith;
    if (this.failStop) throw flyErr(503, "stop", id);
    if (this.gone(id)) throw new FlyError(404, "gone");
    this.maybe5xx("stop", id);
    if (!this.stopNoop) this.machine(id).state = "stopped";
    this.record(this.machine(id));
  }

  async startMachine(_app: string, id: string): Promise<void> {
    this.log.push("start " + id);
    await sleep(this.startDelay);
    if (this.failStartWith) throw this.failStartWith;
    if (this.failStart) throw flyErr(503, "start", id);
    if (this.gone(id)) throw new FlyError(404, "gone");
    this.maybe5xx("start", id);
    if (this.bootMs > 0) {
      this.machine(id).state = "starting";
      this.bootAt = Date.now() + this.bootMs;
    } else this.machine(id).state = "started";
    this.record(this.machine(id));
  }

  waits: { state: string; timeoutS: number }[] = [];
  async waitMachine(_app: string, id: string, state: string, timeoutS = 30): Promise<boolean> {
    this.log.push(`wait ${id} ${state}`);
    this.waits.push({ state, timeoutS });
    if (this.gone(id)) throw new FlyError(404, "gone");
    if (this.honourWaitTimeout && this.waitDelay > timeoutS * 1000) {
      await sleep(timeoutS * 1000);
      return false;
    }
    await sleep(this.waitDelay);
    if (state === "started" && this.machine(id).state === "starting") await sleep(Math.max(0, this.bootAt - Date.now()) + 2);
    if (this.waitLies) return true;
    return !this.waitNever && this.machine(id).state === state;
  }

  async listMachines(): Promise<any[]> {
    return [...this.machines.values()].map((m) => structuredClone(m));
  }

  async setSecrets(_app: string, secrets: Record<string, string>): Promise<void> {
    Object.assign(this.secrets, secrets);
  }

  /** RENEW_PY / provisioning style exec: answer a token id so renewSelfAgents succeeds. */
  async exec(_app: string, _id: string, cmd: string[]): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    return { exit_code: 0, stdout: JSON.stringify({ token_id: "tok-" + cmd[cmd.length - 1] }) + "\n", stderr: "" };
  }

  /** An inbound request through the Fly proxy: starts a stopped machine whose autostart is on (or unset). */
  ping(id: string): string {
    if (this.gone(id)) return "gone";
    const m = this.machine(id);
    if (m.state === "stopped" && (m.config.services ?? []).some((s: any) => s.autostart !== false)) {
      m.state = "started";
      this.record(m);
    }
    return m.state;
  }

  autostartOff(id: string): boolean {
    return (this.machine(id).config.services ?? []).every((s: any) => s.autostart === false);
  }
}

/**
 * The same model behind the REAL FlyClient's HTTP calls (for tests that drive the tick through
 * globalThis.fetch). Returns null for URLs that are not the Machines API so callers can chain.
 */
export function machinesApiHandler(fly: ModelFly) {
  return async (url: string, init?: any): Promise<Response | null> => {
    const m = /^https:\/\/api\.machines\.dev\/v1\/apps\/[^/]+\/machines\/([^/?]+)(\/stop|\/start|\/wait)?(\?.*)?$/.exec(url);
    if (!m) return null;
    const id = m[1];
    const sub = m[2];
    const method = init?.method ?? "GET";
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    try {
      if (!sub && method === "GET") {
        const r = await fly.getMachine("a", id);
        return r ? json(r) : json({ error: "not found" }, 404);
      }
      if (!sub && method === "POST") {
        const body = JSON.parse(init.body);
        return json(await fly.updateMachine("a", id, body.config, { skipLaunch: body.skip_launch }));
      }
      if (sub === "/stop") return await fly.stopMachine("a", id), json({ ok: true });
      if (sub === "/start") return await fly.startMachine("a", id), json({ ok: true });
      if (sub === "/wait") return json({ ok: true }, (await fly.waitMachine("a", id, new URL(url).searchParams.get("state") ?? "stopped")) ? 200 : 408);
    } catch (e: any) {
      if (e instanceof FlyError) return json({ error: e.message }, e.status);
      throw e;
    }
    return json({}, 404);
  };
}
