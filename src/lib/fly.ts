// Force-Field Console — Fly.io client for dedicated-estate provisioning.
//
// Machines API (https://api.machines.dev/v1) for apps, volumes, machines and
// in-machine exec; the GraphQL API (https://api.fly.io/graphql) for the two
// things the Machines API does not do — allocating public IPs and setting app
// secrets. Everything goes through an injectable fetch so tests never touch
// the network.
//
// Provisioning is CONFIGURED only when all of these are set:
//   FLY_API_TOKEN      an org-scoped token (Don's placement; never in the repo)
//   FLY_ORG_SLUG       the organization that owns the estates
//   FLY_ESTATE_IMAGE   registry.fly.io/<app>:<label> — a smoked estate image
//   ESTATE_SECRET_MASTER  the HMAC master from which each estate's shared
//                      secret is derived (so no per-estate secret is stored)
// Optional: FLY_REGION (default yyz), FLY_ESTATE_MEMORY_MB (default 2048).

import { env } from "./store";

export const MACHINES_API = "https://api.machines.dev/v1";
export const GRAPHQL_API = "https://api.fly.io/graphql";

export type FlyConfig = {
  token: string;
  org: string;
  image: string;
  region: string;
  memory_mb: number;
};

export function flyConfig(): FlyConfig | null {
  const token = env("FLY_API_TOKEN");
  const org = env("FLY_ORG_SLUG");
  const image = env("FLY_ESTATE_IMAGE");
  const master = env("ESTATE_SECRET_MASTER");
  if (!token || !org || !image || !master) return null;
  const mem = Number(env("FLY_ESTATE_MEMORY_MB") ?? 2048);
  return {
    token,
    org,
    image,
    region: env("FLY_REGION") || "yyz",
    memory_mb: Number.isFinite(mem) && mem >= 1024 ? mem : 2048,
  };
}

export class FlyError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: any,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type MachineConfig = {
  image: string;
  env?: Record<string, string>;
  services?: any[];
  checks?: Record<string, any>;
  mounts?: { volume: string; path: string; name?: string }[];
  guest?: { cpu_kind: string; cpus: number; memory_mb: number };
  restart?: { policy: "no" | "always" | "on-failure"; max_retries?: number };
  metadata?: Record<string, string>;
};

export type Machine = {
  id: string;
  name?: string;
  state?: string;
  region?: string;
  instance_id?: string;
  config?: MachineConfig;
  checks?: { name?: string; status?: string; output?: string }[];
};

export type ExecResult = { exit_code: number; stdout: string; stderr: string };

export class FlyClient {
  constructor(
    private cfg: FlyConfig,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private async rest(method: string, path: string, body?: unknown, timeoutMs = 20000): Promise<{ status: number; body: any }> {
    let res: Response;
    try {
      res = await this.fetchImpl(MACHINES_API + path, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e: any) {
      throw new FlyError(0, `Fly Machines API unreachable (${e?.name ?? "error"}) for ${method} ${path}`);
    }
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  private async restOk(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<any> {
    const r = await this.rest(method, path, body, timeoutMs);
    if (r.status < 200 || r.status >= 300) {
      const detail = typeof r.body === "string" ? r.body : (r.body?.error ?? JSON.stringify(r.body));
      throw new FlyError(r.status, `Fly ${method} ${path} answered HTTP ${r.status}: ${String(detail).slice(0, 300)}`, r.body);
    }
    return r.body;
  }

  async gql(query: string, variables: Record<string, unknown>): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchImpl(GRAPHQL_API, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e: any) {
      throw new FlyError(0, `Fly GraphQL API unreachable (${e?.name ?? "error"})`);
    }
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FlyError(res.status, `Fly GraphQL answered non-JSON HTTP ${res.status}`);
    }
    if (!res.ok || (Array.isArray(parsed?.errors) && parsed.errors.length > 0)) {
      const msg = parsed?.errors?.map((e: any) => e?.message).filter(Boolean).join("; ") || `HTTP ${res.status}`;
      throw new FlyError(res.status, `Fly GraphQL error: ${String(msg).slice(0, 300)}`, parsed);
    }
    return parsed.data;
  }

  // --- apps ---------------------------------------------------------------

  async getApp(name: string, timeoutMs = 20000): Promise<any | null> {
    const r = await this.rest("GET", `/apps/${encodeURIComponent(name)}`, undefined, timeoutMs);
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new FlyError(r.status, `Fly GET app ${name} answered HTTP ${r.status}`, r.body);
    return r.body;
  }

  /** Create the app; an already-existing app of that name is treated as success. */
  async createApp(name: string): Promise<void> {
    const r = await this.rest("POST", "/apps", { app_name: name, org_slug: this.cfg.org });
    if (r.status >= 200 && r.status < 300) return;
    const existing = await this.getApp(name);
    if (existing) return;
    throw new FlyError(r.status, `Fly create app ${name} answered HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`, r.body);
  }

  async deleteApp(name: string): Promise<void> {
    const r = await this.rest("DELETE", `/apps/${encodeURIComponent(name)}?force=true`);
    if (r.status === 404) return;
    if (r.status < 200 || r.status >= 300) throw new FlyError(r.status, `Fly delete app ${name} answered HTTP ${r.status}`, r.body);
  }

  // --- IPs and secrets (GraphQL) -------------------------------------------

  /**
   * Public IPs of an app. A SHARED v4 is not an IPAddress node in Fly's schema:
   * it lives on `app.sharedIpAddress` (verified by introspection and against
   * the sandbox, 2026-09-14), so it is folded in here as type `shared_v4`.
   */
  async listIps(app: string): Promise<{ address: string; type: string }[]> {
    const data = await this.gql(
      `query($name: String!) { app(name: $name) { sharedIpAddress ipAddresses { nodes { address type } } } }`,
      { name: app },
    );
    const out: { address: string; type: string }[] = [];
    const shared = String(data?.app?.sharedIpAddress ?? "");
    if (shared) out.push({ address: shared, type: "shared_v4" });
    for (const n of data?.app?.ipAddresses?.nodes ?? []) out.push({ address: String(n.address), type: String(n.type) });
    return out;
  }

  /**
   * Allocate a public IP. For `shared_v4` the payload's `ipAddress` is null and
   * the address comes back on `app.sharedIpAddress` (the live rehearsal of
   * 2026-09-14 failed on exactly this); dedicated v4/v6 come back as `ipAddress`.
   */
  async allocateIp(app: string, type: "shared_v4" | "v4" | "v6"): Promise<string> {
    const data = await this.gql(
      `mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id address type } app { sharedIpAddress } } }`,
      { input: { appId: app, type } },
    );
    const dedicated = String(data?.allocateIpAddress?.ipAddress?.address ?? "");
    const shared = String(data?.allocateIpAddress?.app?.sharedIpAddress ?? "");
    // A dedicated allocation must answer with its own node: never substitute the
    // app's (already present) shared v4 for a missing v6 and call it a success.
    const address = type === "shared_v4" ? shared || dedicated : dedicated;
    if (!address) throw new FlyError(502, `Fly allocateIpAddress(${type}) for ${app} returned no address`, data);
    return address;
  }

  /** Set app secrets. They apply on the next machine update/launch (updateMachine). */
  async setSecrets(app: string, secrets: Record<string, string>): Promise<void> {
    const list = Object.entries(secrets).map(([key, value]) => ({ key, value }));
    if (list.length === 0) return;
    await this.gql(
      `mutation($input: SetSecretsInput!) { setSecrets(input: $input) { release { id version } } }`,
      { input: { appId: app, secrets: list } },
    );
  }

  // --- volumes --------------------------------------------------------------

  async listVolumes(app: string): Promise<{ id: string; name: string; region?: string; attached_machine_id?: string | null }[]> {
    const body = await this.restOk("GET", `/apps/${encodeURIComponent(app)}/volumes`);
    return Array.isArray(body) ? body : [];
  }

  async createVolume(app: string, name: string, size_gb: number): Promise<{ id: string }> {
    const body = await this.restOk("POST", `/apps/${encodeURIComponent(app)}/volumes`, {
      name,
      region: this.cfg.region,
      size_gb,
      encrypted: true,
      require_unique_zone: false,
    });
    if (!body?.id) throw new FlyError(502, "Fly create volume returned no id", body);
    return { id: String(body.id) };
  }

  // --- machines -------------------------------------------------------------

  async listMachines(app: string): Promise<Machine[]> {
    const body = await this.restOk("GET", `/apps/${encodeURIComponent(app)}/machines`);
    return Array.isArray(body) ? body : [];
  }

  async createMachine(app: string, name: string, config: MachineConfig): Promise<Machine> {
    const body = await this.restOk("POST", `/apps/${encodeURIComponent(app)}/machines`, {
      name,
      region: this.cfg.region,
      config,
    });
    if (!body?.id) throw new FlyError(502, "Fly create machine returned no id", body);
    return body as Machine;
  }

  async getMachine(app: string, id: string, timeoutMs = 20000): Promise<Machine | null> {
    const r = await this.rest("GET", `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`, undefined, timeoutMs);
    if (r.status === 404) return null;
    if (r.status < 200 || r.status >= 300) throw new FlyError(r.status, `Fly GET machine ${id} answered HTTP ${r.status}`, r.body);
    return r.body as Machine;
  }

  /** Replace the config (a full config is required); the machine restarts and picks up the current secrets. */
  async updateMachine(app: string, id: string, config: MachineConfig, opts: { skipLaunch?: boolean } = {}): Promise<Machine> {
    return (await this.restOk("POST", `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}`, {
      config,
      region: this.cfg.region,
      ...(opts.skipLaunch ? { skip_launch: true } : {}),
    })) as Machine;
  }

  async stopMachine(app: string, id: string): Promise<void> {
    await this.restOk("POST", `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/stop`);
  }

  async startMachine(app: string, id: string): Promise<void> {
    await this.restOk("POST", `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/start`);
  }

  async waitMachine(app: string, id: string, state: "started" | "stopped", timeoutS: number): Promise<boolean> {
    const r = await this.rest(
      "GET",
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/wait?state=${state}&timeout=${timeoutS}`,
      undefined,
      (timeoutS + 5) * 1000,
    );
    return r.status >= 200 && r.status < 300;
  }

  /** Run a command inside the machine (argv form — no shell parsing on the API side). */
  async exec(app: string, id: string, command: string[], timeoutS = 30): Promise<ExecResult> {
    const body = await this.restOk(
      "POST",
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(id)}/exec`,
      { command, timeout: timeoutS },
      (timeoutS + 10) * 1000,
    );
    return {
      exit_code: Number(body?.exit_code ?? -1),
      stdout: String(body?.stdout ?? ""),
      stderr: String(body?.stderr ?? ""),
    };
  }
}

/** The public origin of an estate app. */
export function estateOrigin(app: string): string {
  return `https://${app}.fly.dev`;
}

/**
 * The machine config for a customer estate. `posture` chooses the first boot
 * (observer: keys and self-agents are made here) or the armed state (every
 * Phase F switch on). Paths and 0/1 flags are not secrets; the true secrets
 * (shared secret, self-agent token ids, Anthropic key) are app secrets.
 */
export function estateMachineConfig(
  cfg: FlyConfig,
  volume_id: string,
  posture: "boot" | "armed",
  signer: string,
): MachineConfig {
  const env: Record<string, string> = {
    FIELD_DATA_DIR: "/data",
    FIELD_SENTINEL_MODE: "enforce",
    FIELD_LEDGER_RETENTION_DAYS: "2555",
    FIELD_LEDGER_ANCHOR_KEY: "/data/keys/ledger-anchor.pem",
    FIELD_DOA_ROSTER: "/data/doa-roster.yaml",
    // Owner roster for the lifecycle sweep (orphan findings escalate only; the
    // scheduler never auto-kills). Bootstrap writes it; the first tick is a day out.
    FIELD_LIFECYCLE_ROSTER: "/data/owners.csv",
    FORCE_GATEWAY_SENTINEL_TIMEOUT: "30",
  };
  if (posture === "armed") {
    Object.assign(env, {
      FIELD_LEDGER_SIGN_KEY: "/data/keys/ledger-sign.pem",
      FIELD_LEDGER_REQUIRE_SIGNING: "1",
      FIELD_ATTEST_SIGNER: signer,
      FIELD_ATTEST_SIGN_KEY: "/data/keys/attest-sign.pem",
      FORCE_GATEWAY_ENFORCE: "1",
      FORCE_GATEWAY_TOOL_CHECK: "1",
    });
  }
  const check = (path: string) => ({
    type: "http",
    port: 8080,
    path,
    method: "GET",
    interval: "30s",
    timeout: "5s",
    grace_period: "60s",
  });
  return {
    image: cfg.image,
    env,
    services: [
      {
        protocol: "tcp",
        internal_port: 8080,
        autostop: "off",
        autostart: true,
        min_machines_running: 1,
        ports: [
          { port: 80, handlers: ["http"], force_https: true },
          { port: 443, handlers: ["tls", "http"] },
        ],
      },
    ],
    checks: {
      registry: check("/registry/health"),
      ledger: check("/ledger/health"),
      sentinel: check("/sentinel/health"),
    },
    mounts: [{ volume: volume_id, path: "/data", name: "ff_data" }],
    guest: { cpu_kind: "shared", cpus: 1, memory_mb: cfg.memory_mb },
    restart: { policy: "always" },
    metadata: { "ff-portal": "estate" },
  };
}

/**
 * A copy of the config with every service's proxy autostart set. A suspended estate must not be
 * woken by an inbound request (Fly's proxy starts a stopped machine when autostart is on).
 */
export function withAutostart(config: MachineConfig, autostart: boolean): MachineConfig {
  return { ...config, services: (config.services ?? []).map((s) => ({ ...s, autostart })) };
}

/** A client when provisioning is configured, else null (the honest 501 path). */
export function flyClientOrNull(fetchImpl?: FetchLike): FlyClient | null {
  const cfg = flyConfig();
  return cfg ? new FlyClient(cfg, fetchImpl) : null;
}
