// A stand-in for the Fly Machines API that MODELS the proxy autostart behaviour seen live:
// a stopped machine whose service has autostart=true is started again by the next inbound
// request (ping). Machines are created lazily on first touch, started, autostart on.
import { FlyError } from "../src/lib/fly";

export type ModelMachine = { id: string; name: string; state: string; config: { image: string; services: any[] } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ModelFly {
  machines = new Map<string, ModelMachine>();
  /** Every mutating / reading call, in order: "get m_1", "update m_1 autostart=false skip=true", "stop m_1", ... */
  log: string[] = [];
  failUpdate = false;
  failStop = false;
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

  machine(id: string, over: Partial<ModelMachine> & { autostart?: boolean } = {}): ModelMachine {
    let m = this.machines.get(id);
    if (!m) {
      m = { id, name: "estate", state: over.state ?? "started", config: { image: "img", services: [{ internal_port: 8080, autostart: over.autostart ?? true }] } };
      this.machines.set(id, m);
    }
    return m;
  }

  async getMachine(_app: string, id: string): Promise<any> {
    this.log.push("get " + id);
    if (this.failGet) throw new FlyError(500, "get failed");
    if (this.getReturnsNull) return null;
    return structuredClone(this.machine(id));
  }

  async updateMachine(_app: string, id: string, config: any, opts: { skipLaunch?: boolean } = {}): Promise<any> {
    this.log.push(`update ${id} autostart=${config.services?.[0]?.autostart} skip=${Boolean(opts.skipLaunch)}`);
    if (this.updateThrows404) throw new FlyError(404, "gone");
    if (this.failUpdate) throw new FlyError(500, "update failed");
    const m = this.machine(id);
    if (!this.ignoreUpdate) m.config = structuredClone(config);
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
    this.machine(id).state = "started";
  }

  async waitMachine(_app: string, id: string, state: string): Promise<boolean> {
    this.log.push(`wait ${id} ${state}`);
    if (this.waitLies) return true;
    return !this.waitNever && this.machine(id).state === state;
  }

  async listMachines(): Promise<any[]> {
    return [...this.machines.values()].map((m) => structuredClone(m));
  }

  /** An inbound request through the Fly proxy: starts a stopped machine whose autostart is on. */
  ping(id: string): string {
    const m = this.machine(id);
    if (m.state === "stopped" && m.config.services.some((s) => s.autostart !== false)) m.state = "started";
    return m.state;
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
      if (!sub && method === "GET") return json(await fly.getMachine("a", id));
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
