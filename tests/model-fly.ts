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
  private snapshot: ModelMachine | null = null;

  machine(id: string, over: Partial<ModelMachine> & { autostart?: boolean } = {}): ModelMachine {
    let m = this.machines.get(id);
    if (!m) {
      m = { id, name: "estate", state: over.state ?? "started", config: over.config ?? { image: "img", services: [{ internal_port: 8080, autostart: over.autostart ?? true }] } };
      this.machines.set(id, m);
    }
    return m;
  }

  async getMachine(_app: string, id: string): Promise<any> {
    this.log.push("get " + id);
    if (this.failGet) throw new FlyError(500, "get failed");
    if (this.getReturnsNull) return null;
    if (this.staleReads > 0 && this.snapshot && this.snapshot.id === id) {
      this.staleReads -= 1;
      return structuredClone(this.snapshot);
    }
    return structuredClone(this.machine(id));
  }

  async updateMachine(_app: string, id: string, config: any, opts: { skipLaunch?: boolean } = {}): Promise<any> {
    this.log.push(`update ${id} autostart=${config.services?.[0]?.autostart} skip=${Boolean(opts.skipLaunch)}`);
    if (this.updateThrows404) throw new FlyError(404, "gone");
    if (this.failUpdate || (this.failUpdateAfter !== null && this.updatesDone >= this.failUpdateAfter)) throw new FlyError(500, "update failed");
    const m = this.machine(id);
    this.snapshot = structuredClone(m);
    const d = this.updateDelayOnce || this.updateDelay;
    this.updateDelayOnce = 0;
    await sleep(d);
    this.updatesDone += 1;
    if (!this.ignoreUpdate) m.config = structuredClone(config);
    if (!opts.skipLaunch) {
      if (m.state === "started") this.restarts += 1;
      m.state = "started"; // an update launches the machine unless skip_launch
    }
    return structuredClone(m);
  }

  async stopMachine(_app: string, id: string): Promise<void> {
    this.log.push("stop " + id);
    await sleep(this.stopDelay);
    if (this.failStopWith) throw this.failStopWith;
    if (this.failStop) throw new FlyError(503, "stop failed");
    if (!this.stopNoop) this.machine(id).state = "stopped";
  }

  async startMachine(_app: string, id: string): Promise<void> {
    this.log.push("start " + id);
    await sleep(this.startDelay);
    if (this.failStart) throw new FlyError(503, "start failed");
    this.machine(id).state = "started";
  }

  async waitMachine(_app: string, id: string, state: string): Promise<boolean> {
    this.log.push(`wait ${id} ${state}`);
    await sleep(this.waitDelay);
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
    const m = this.machine(id);
    if (m.state === "stopped" && (m.config.services ?? []).some((s: any) => s.autostart !== false)) m.state = "started";
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
