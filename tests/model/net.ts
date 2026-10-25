// HTTP-level models behind globalThis.fetch, driven by the REAL FlyClient / stripeRequest code:
//
// FLY (Machines REST + the GraphQL calls provisioning uses + the public proxy at <app>.fly.dev):
//  - a request is APPLIED at issue time + latency, whether or not the client is still waiting: a
//    client timeout (FlyClient: 20 s AbortSignal) does not cancel a request Fly accepted, so a slow
//    update can land after the caller gave up (and after its lock was released);
//  - POST /machines/{id} (update) restarts a started machine and launches a stopped one unless
//    skip_launch (assumption A3); skip_launch applies config only;
//  - the proxy wakes a stopped machine when ANY service has autostart !== false (absent = on, A4);
//    every request to <app>.fly.dev is such a request (health looks, armedPosture polls, scanners);
//  - reads are EVENTUALLY CONSISTENT: with probability pStale a GET returns any version of the
//    machine that was current within the last staleWindowMs (not only "the one before the update");
//  - waits honour their timeout (A6) and answer 408 unless the state is reached (waitLies: 200 always);
//  - 404 = gone (machine or app destroyed); transient404 (an A6 violation) answers 404 for a live machine;
//  - faults: 5xx/429 before applying, 5xx AFTER applying (a gateway error on an accepted call),
//    unreachable, stop accepted but ineffective, update answered 200 but not applied.
// STRIPE: GET /v1/subscriptions/{id} answers the current truth (stripe.ts stub), with timeout / 429 faults.
import { clock, NEVER } from "./vclock";

export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FlyFaults = {
  p5xxBefore: number;
  p5xxAfter: number;
  pUnreachable: number;
  pStale: number;
  staleWindowMs: number;
  pSlow: number; // a call takes slowMs (longer than the 20 s client timeout when slowMs > 20000)
  slowMs: number;
  pSlowUpdate: number; // a machine UPDATE takes slowUpdateMs (A8: ~20 s seen live)
  slowUpdateMs: number;
  stopIneffective: boolean;
  waitLies: boolean;
  updateIgnored: boolean;
  transient404: number;
};
export const NO_FLY_FAULTS = (): FlyFaults => ({ p5xxBefore: 0, p5xxAfter: 0, pUnreachable: 0, pStale: 0, staleWindowMs: 0, pSlow: 0, slowMs: 0, pSlowUpdate: 0, slowUpdateMs: 0, stopIneffective: false, waitLies: false, updateIgnored: false, transient404: 0 });

type Version = { from: number; to: number | null; state: string; config: any };
export type FMachine = { id: string; name: string; app: string; state: string; config: any; history: Version[]; restarts: number; starts: number; wakes: number; createdAt: number };
export type FApp = { name: string; machines: Map<string, FMachine>; volumes: { id: string; name: string }[]; ips: { address: string; type: string }[]; secrets: Record<string, string>; shared: string | null };

export type StripeSub = { id: string; customer: string; status: string; price: string; user_meta: string | null; created: number };

export class Net {
  apps = new Map<string, FApp>();
  faults: FlyFaults = NO_FLY_FAULTS();
  stripeFaults = { pTimeout: 0, p429: 0, slowMs: 0 };
  subs = new Map<string, StripeSub>();
  rng: Rng = Math.random;
  baseLatency: [number, number] = [20, 200];
  /** Every Fly call: "t=... POST update m_x skip=1 -> 200" (for repro traces). */
  trace: string[] = [];
  traceOn = false;
  machineSeq = 0;
  /** Requests to an origin while its machine was stopped (wakes counted on the machine). */
  originHits = 0;

  private lat(): number {
    const [a, b] = this.baseLatency;
    return a + Math.floor(this.rng() * (b - a + 1));
  }
  private log(s: string) {
    if (this.traceOn) this.trace.push(`${new Date(clock.now).toISOString().slice(11, 23)} ${s}`);
  }

  app(name: string): FApp {
    let a = this.apps.get(name);
    if (!a) {
      a = { name, machines: new Map(), volumes: [], ips: [], secrets: {}, shared: null };
      this.apps.set(name, a);
    }
    return a;
  }
  machineByApp(app: string): FMachine | null {
    const a = this.apps.get(app);
    if (!a) return null;
    for (const m of a.machines.values()) if (m.name === "estate" && m.state !== "destroyed") return m;
    return null;
  }
  setMachine(m: FMachine, patch: { state?: string; config?: any }) {
    const prev = m.history[m.history.length - 1];
    if (prev) prev.to = clock.now;
    if (patch.state !== undefined) m.state = patch.state;
    if (patch.config !== undefined) m.config = structuredClone(patch.config);
    m.history.push({ from: clock.now, to: null, state: m.state, config: structuredClone(m.config) });
    if (m.history.length > 40) m.history.splice(0, m.history.length - 40);
  }
  addMachine(app: string, config: any, state = "started"): FMachine {
    const a = this.app(app);
    const id = `m${++this.machineSeq}`;
    const m: FMachine = { id, name: "estate", app, state, config: structuredClone(config), history: [], restarts: 0, starts: 0, wakes: 0, createdAt: clock.now };
    m.history.push({ from: clock.now, to: null, state, config: structuredClone(config) });
    a.machines.set(id, m);
    return m;
  }
  static autostartOff(config: any): boolean {
    return (config?.services ?? []).every((s: any) => s.autostart === false);
  }

  // --- platform events (not API calls) ---
  /** An inbound request through the Fly proxy (a scanner, the customer, a health look). */
  proxyHit(app: string): string | null {
    const m = this.machineByApp(app);
    if (!m) return null;
    if (m.state === "stopped" && (m.config?.services ?? []).some((s: any) => s.autostart !== false)) {
      m.wakes += 1;
      this.setMachine(m, { state: "started" });
      this.log(`PROXY WAKE ${m.id}`);
    }
    return m.state;
  }
  /** Fly stops the machine on its own (host maintenance, OOM, ...). */
  platformStop(app: string) {
    const m = this.machineByApp(app);
    if (m && m.state === "started") {
      this.setMachine(m, { state: "stopped" });
      this.log(`PLATFORM STOP ${m.id}`);
    }
  }

  // --- the fetch shim ---
  fetch = async (input: any, init?: any): Promise<Response> => {
    const url = String(input);
    if (!clock.ioAllowed()) return NEVER;
    const inv = clock.current();
    const signal: AbortSignal | undefined = init?.signal;
    const method = (init?.method ?? "GET").toUpperCase();
    let plan: { latency: number; run: () => Response | Promise<Response> };
    try {
      plan = this.route(url, method, init);
    } catch (e) {
      return Promise.reject(e);
    }
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
        if (!inv?.dead) reject(err);
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      // The request is applied at its own time whether or not the caller still waits.
      clock.scheduleDetached(plan.latency, () => {
        Promise.resolve()
          .then(plan.run)
          .then(
            (res) => {
              if (settled || inv?.dead) return;
              settled = true;
              resolve(res);
            },
            (err) => {
              if (settled || inv?.dead) return;
              settled = true;
              reject(err);
            },
          );
      });
    });
  };

  private json(b: unknown, status = 200): Response {
    return new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  }

  private route(url: string, method: string, init: any): { latency: number; run: () => Response | Promise<Response> } {
    // ---- Stripe
    let m = /^https:\/\/api\.stripe\.com\/v1\/subscriptions\/([^/?]+)/.exec(url);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const r = this.rng();
      if (r < this.stripeFaults.pTimeout) return { latency: 60_000, run: () => this.json({ error: { message: "late" } }, 504) };
      if (r < this.stripeFaults.pTimeout + this.stripeFaults.p429) return { latency: this.lat(), run: () => this.json({ error: { message: "rate limited" } }, 429) };
      return {
        latency: this.stripeFaults.slowMs || this.lat(),
        run: () => {
          const s = this.subs.get(id);
          if (!s) return this.json({ error: { message: "No such subscription" } }, 404);
          return this.json(stripeObject(s));
        },
      };
    }
    // ---- estate origin (through the Fly proxy)
    m = /^https:\/\/([a-z0-9-]+)\.fly\.dev(\/[^?]*)?/.exec(url);
    if (m) {
      const app = m[1];
      const path = m[2] ?? "/";
      return {
        latency: this.lat(),
        run: () => {
          this.originHits += 1;
          const st = this.proxyHit(app);
          if (st !== "started") throw new TypeError("fetch failed");
          return this.json(healthBody(path));
        },
      };
    }
    // ---- Fly GraphQL
    if (url === "https://api.fly.io/graphql") {
      const body = JSON.parse(init?.body ?? "{}");
      const q: string = body.query ?? "";
      const vars = body.variables ?? {};
      return this.flyCall("gql", () => {
        if (q.includes("sharedIpAddress ipAddresses")) {
          const a = this.apps.get(vars.name);
          if (!a) return this.json({ errors: [{ message: "Could not find App" }] }, 200);
          return this.json({ data: { app: { sharedIpAddress: a.shared, ipAddresses: { nodes: a.ips } } } });
        }
        if (q.includes("allocateIpAddress")) {
          const a = this.app(vars.input.appId);
          if (vars.input.type === "shared_v4") {
            a.shared = "137.66.0.1";
            return this.json({ data: { allocateIpAddress: { ipAddress: null, app: { sharedIpAddress: a.shared } } } });
          }
          const ip = { address: "2a09::" + (a.ips.length + 1), type: vars.input.type };
          a.ips.push(ip);
          return this.json({ data: { allocateIpAddress: { ipAddress: { id: "ip", ...ip }, app: { sharedIpAddress: a.shared } } } });
        }
        if (q.includes("setSecrets")) {
          const a = this.app(vars.input.appId);
          for (const s of vars.input.secrets) a.secrets[s.key] = s.value;
          return this.json({ data: { setSecrets: { release: { id: "r", version: 1 } } } });
        }
        return this.json({ errors: [{ message: "unknown query" }] });
      }, "update");
    }
    // ---- Fly Machines REST
    m = /^https:\/\/api\.machines\.dev\/v1(\/[^?]*)(\?.*)?$/.exec(url);
    if (!m) throw new Error("model fetch: unrouted URL " + url.replace(/\?.*$/, ""));
    const path = m[1];
    const qs = new URLSearchParams((m[2] ?? "").replace(/^\?/, ""));
    const body = init?.body ? JSON.parse(init.body) : null;
    if (path === "/apps" && method === "POST") return this.flyCall("create_app", () => (this.app(body.app_name), this.json({ ok: true }, 201)), "update");
    let p = /^\/apps\/([^/]+)$/.exec(path);
    if (p) {
      const app = decodeURIComponent(p[1]);
      return this.flyCall("get_app", () => (this.apps.has(app) ? this.json({ name: app }) : this.json({ error: "not found" }, 404)), "read");
    }
    p = /^\/apps\/([^/]+)\/volumes$/.exec(path);
    if (p) {
      const app = decodeURIComponent(p[1]);
      if (method === "GET") return this.flyCall("list_volumes", () => (this.apps.has(app) ? this.json(this.app(app).volumes) : this.json({ error: "app not found" }, 404)), "read");
      return this.flyCall("create_volume", () => {
        const a = this.app(app);
        const v = { id: `vol_${app}_${a.volumes.length + 1}`, name: body.name };
        a.volumes.push(v);
        return this.json(v);
      }, "update");
    }
    p = /^\/apps\/([^/]+)\/machines$/.exec(path);
    if (p) {
      const app = decodeURIComponent(p[1]);
      if (method === "GET") return this.flyCall("list_machines", () => (this.apps.has(app) ? this.json([...this.app(app).machines.values()].filter((x) => x.state !== "destroyed").map((x) => ({ id: x.id, name: x.name, state: x.state, config: structuredClone(x.config) }))) : this.json({ error: "app not found" }, 404)), "read");
      return this.flyCall("create_machine", () => {
        const mm = this.addMachine(app, body.config, "started");
        this.log(`CREATE ${mm.id} in ${app}`);
        return this.json({ id: mm.id, name: mm.name, state: mm.state, config: mm.config });
      }, "update");
    }
    p = /^\/apps\/([^/]+)\/machines\/([^/]+)(\/stop|\/start|\/wait|\/exec)?$/.exec(path);
    if (p) {
      const app = decodeURIComponent(p[1]);
      const id = decodeURIComponent(p[2]);
      const sub = p[3];
      const get = () => {
        const mm = this.apps.get(app)?.machines.get(id);
        return mm && mm.state !== "destroyed" ? mm : null;
      };
      if (!sub && method === "GET") {
        return this.flyCall("get", () => {
          const mm = get();
          if (!mm) return this.json({ error: "not found" }, 404);
          if (this.faults.transient404 && this.rng() < this.faults.transient404) return this.json({ error: "not found" }, 404);
          let v: Version = mm.history[mm.history.length - 1];
          if (this.faults.pStale && this.rng() < this.faults.pStale) {
            const lo = clock.now - this.faults.staleWindowMs;
            const cands = mm.history.filter((h) => h.to === null || h.to >= lo);
            v = cands[Math.floor(this.rng() * cands.length)] ?? v;
          }
          return this.json({ id: mm.id, name: mm.name, state: v.state, config: structuredClone(v.config) });
        }, "read");
      }
      if (!sub && method === "POST") {
        const skip = Boolean(body?.skip_launch);
        return this.flyCall("update", () => {
          const mm = get();
          if (!mm) return this.json({ error: "not found" }, 404);
          const cfg = this.faults.updateIgnored ? mm.config : body.config;
          let state = mm.state;
          if (!skip) {
            if (mm.state === "started") mm.restarts += 1;
            state = "started";
          }
          this.setMachine(mm, { state, config: cfg });
          this.log(`UPDATE ${mm.id} autostart=${Net.autostartOff(cfg) ? "off" : "ON"} skip=${skip} -> ${mm.state}`);
          return this.json({ id: mm.id, state: mm.state, config: structuredClone(mm.config) });
        }, "machine_update");
      }
      if (sub === "/stop") {
        return this.flyCall("stop", () => {
          const mm = get();
          if (!mm) return this.json({ error: "not found" }, 404);
          if (!this.faults.stopIneffective && mm.state !== "stopped") this.setMachine(mm, { state: "stopped" });
          this.log(`STOP ${mm.id} -> ${mm.state}`);
          return this.json({ ok: true });
        }, "update");
      }
      if (sub === "/start") {
        return this.flyCall("start", () => {
          const mm = get();
          if (!mm) return this.json({ error: "not found" }, 404);
          if (mm.state === "started") return this.json({ error: "machine already started" }, 412);
          mm.starts += 1;
          this.setMachine(mm, { state: "started" });
          this.log(`START ${mm.id}`);
          return this.json({ ok: true });
        }, "update");
      }
      if (sub === "/wait") {
        const want = qs.get("state") ?? "stopped";
        const timeoutS = Number(qs.get("timeout") ?? 30);
        // the wait itself is modelled by polling the machine in virtual time
        const plan = this.flyCall("wait", () => this.json({ ok: true }), "read");
        return {
          latency: plan.latency,
          run: async () => {
            const first = await plan.run();
            if (first.status !== 200) return first;
            if (this.faults.waitLies) return this.json({ ok: true });
            const deadline = clock.now + timeoutS * 1000;
            for (;;) {
              const mm = get();
              if (!mm) return this.json({ error: "not found" }, 404);
              if (mm.state === want) return this.json({ ok: true });
              if (clock.now >= deadline) return this.json({ error: "deadline_exceeded" }, 408);
              await new Promise<void>((r) => clock.schedule(250, r));
            }
          },
        };
      }
      if (sub === "/exec") {
        return this.flyCall("exec", () => {
          const mm = get();
          if (!mm) return this.json({ error: "not found" }, 404);
          if (mm.state !== "started") return this.json({ error: "machine not started" }, 412);
          const out = { keys: { "ledger-sign": { pub: "pk", fingerprint: "fp-ledger" } }, manifests: [], roster_rows: 1, customer_row: false, token_id: "tok-" + id };
          return this.json({ exit_code: 0, stdout: JSON.stringify(out) + "\n", stderr: "" });
        }, "update");
      }
    }
    throw new Error("model fetch: unrouted Fly path " + method + " " + path);
  }

  /** Fault + latency decision for one Fly call. `kind` is read / update / machine_update. */
  private flyCall(op: string, apply: () => Response, kind: "read" | "update" | "machine_update"): { latency: number; run: () => Response } {
    const f = this.faults;
    let latency = this.lat();
    if (kind === "machine_update" && f.pSlowUpdate && this.rng() < f.pSlowUpdate) latency = f.slowUpdateMs;
    else if (f.pSlow && this.rng() < f.pSlow) latency = f.slowMs;
    const r = this.rng();
    let outcome: "ok" | "before" | "after" | "unreach" = "ok";
    if (r < f.pUnreachable) outcome = "unreach";
    else if (r < f.pUnreachable + f.p5xxBefore) outcome = "before";
    else if (kind !== "read" && r < f.pUnreachable + f.p5xxBefore + f.p5xxAfter) outcome = "after";
    const status = [500, 502, 503, 429][Math.floor(this.rng() * 4)];
    return {
      latency,
      run: () => {
        if (outcome === "unreach") {
          this.log(`${op} UNREACHABLE`);
          throw new TypeError("fetch failed");
        }
        if (outcome === "before") {
          this.log(`${op} -> ${status} (not applied)`);
          return this.json({ error: "could not reach https://api.machines.dev (Bearer fo1_LEAKME0123456789abcdef rejected)" }, status);
        }
        const res = apply();
        if (outcome === "after") {
          this.log(`${op} -> 502 (APPLIED)`);
          return this.json({ error: "upstream timeout https://api.machines.dev/v1/apps/x" }, 502);
        }
        return res;
      },
    };
  }
}

export function stripeObject(s: StripeSub) {
  return {
    id: s.id,
    object: "subscription",
    status: s.status,
    customer: s.customer,
    items: { data: [{ price: { id: s.price }, current_period_end: 1_900_000_000 }] },
    metadata: s.user_meta ? { user_id: s.user_meta } : {},
  };
}

function healthBody(path: string): any {
  if (path.startsWith("/ledger/health")) return { ok: true, appendable: true, signing: "on", require_signing: true, key_fingerprint: "fp-ledger", build_sha: "abc" };
  if (path.startsWith("/gateway/health")) return { ok: true, enforce: true, tool_check: true };
  if (path.startsWith("/attest/health")) return { ok: true, signing: "on" };
  return { ok: true };
}
