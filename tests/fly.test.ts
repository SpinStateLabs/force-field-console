import { describe, it, expect, afterEach } from "vitest";
import { FlyClient, FlyError, GRAPHQL_API, MACHINES_API, estateMachineConfig, estateOrigin, flyConfig } from "../src/lib/fly";

const CFG = { token: "fo1_test", org: "personal", image: "registry.fly.io/force-field-sandbox:test", region: "yyz", memory_mb: 2048 };

type Call = { url: string; init: any; body: any };

function fakeFetch(route: (url: string, body: any) => { status: number; body?: unknown } | undefined) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, init, body });
    const r = route(url, body) ?? { status: 404, body: { error: "not found" } };
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

describe("FlyClient request shapes", () => {
  it("creates an app in the org with a bearer token", async () => {
    const f = fakeFetch((url) => (url === MACHINES_API + "/apps" ? { status: 201, body: { id: "x", created_at: "t" } } : undefined));
    const c = new FlyClient(CFG, f.fetchImpl);
    await c.createApp("ff-est-abc");
    expect(f.calls[0].init.method).toBe("POST");
    expect(f.calls[0].init.headers.authorization).toBe("Bearer fo1_test");
    expect(f.calls[0].body).toEqual({ app_name: "ff-est-abc", org_slug: "personal" });
  });

  it("treats an already-existing app as success, and a missing one as failure", async () => {
    const f = fakeFetch((url) => {
      if (url === MACHINES_API + "/apps") return { status: 422, body: { error: "name taken" } };
      if (url === MACHINES_API + "/apps/ff-est-abc") return { status: 200, body: { name: "ff-est-abc" } };
      return undefined;
    });
    await expect(new FlyClient(CFG, f.fetchImpl).createApp("ff-est-abc")).resolves.toBeUndefined();
    const g = fakeFetch((url) => (url === MACHINES_API + "/apps" ? { status: 422, body: { error: "bad" } } : undefined));
    await expect(new FlyClient(CFG, g.fetchImpl).createApp("ff-est-abc")).rejects.toBeInstanceOf(FlyError);
  });

  it("lists the org's app names (positive control of a 404): complete list only, else FlyError", async () => {
    const list = (body: unknown, status = 200) => fakeFetch((url) => (url === MACHINES_API + "/apps?org_slug=personal" ? { status, body } : undefined));
    const ok = list({ total_apps: 2, apps: [{ name: "ff-est-a", status: "deployed" }, { name: "force-field-sandbox" }] });
    expect(await new FlyClient(CFG, ok.fetchImpl).listAppNames(8000)).toEqual(["ff-est-a", "force-field-sandbox"]);
    expect(ok.calls[0].init.method).toBe("GET");
    expect(ok.calls[0].init.headers.authorization).toBe("Bearer fo1_test");
    expect(await new FlyClient(CFG, list({ total_apps: 0, apps: [] }).fetchImpl).listAppNames()).toEqual([]);
    for (const [label, f] of [
      ["partial list", list({ total_apps: 3, apps: [{ name: "a" }, { name: "b" }] })],
      ["no apps array", list({ total_apps: 0 })],
      ["a nameless app", list({ total_apps: 1, apps: [{ id: "x" }] })],
      ["no total", list({ apps: [{ name: "a" }] })],
      ["HTTP 403", list({ error: "forbidden" }, 403)],
      ["HTTP 404 (token cannot see the org)", list({ error: "not found" }, 404)],
    ] as const) {
      await expect(new FlyClient(CFG, f.fetchImpl).listAppNames(), label).rejects.toBeInstanceOf(FlyError);
    }
  });

  it("allocates IPs and sets secrets over GraphQL with the documented inputs", async () => {
    // Payload shapes as Fly's schema actually answers them (introspected and checked
    // against the sandbox on 2026-09-14): a SHARED v4 comes back on app.sharedIpAddress
    // with ipAddress null, and is absent from app.ipAddresses; a dedicated v6 is an
    // IPAddress node. The first live rehearsal failed on exactly this.
    const f = fakeFetch((url, body) => {
      if (url !== GRAPHQL_API) return undefined;
      const q = String(body.query);
      if (q.includes("allocateIpAddress")) {
        if (body.variables?.input?.type === "shared_v4") return { status: 200, body: { data: { allocateIpAddress: { ipAddress: null, app: { sharedIpAddress: "66.1.2.3" } } } } };
        return { status: 200, body: { data: { allocateIpAddress: { ipAddress: { id: "ip1", address: "2a09::1", type: "v6" }, app: { sharedIpAddress: "66.1.2.3" } } } } };
      }
      if (q.includes("setSecrets")) return { status: 200, body: { data: { setSecrets: { release: { id: "r", version: 2 } } } } };
      return { status: 200, body: { data: { app: { sharedIpAddress: "66.1.2.3", ipAddresses: { nodes: [{ address: "::1", type: "v6" }] } } } } };
    });
    const c = new FlyClient(CFG, f.fetchImpl);
    expect(await c.allocateIp("ff-est-abc", "shared_v4")).toBe("66.1.2.3");
    expect(f.calls[0].body.variables).toEqual({ input: { appId: "ff-est-abc", type: "shared_v4" } });
    expect(String(f.calls[0].body.query)).toContain("sharedIpAddress");
    expect(await c.allocateIp("ff-est-abc", "v6")).toBe("2a09::1");
    await c.setSecrets("ff-est-abc", { FIELD_SHARED_SECRET: "s3cret", B: "2" });
    expect(f.calls[2].body.variables).toEqual({ input: { appId: "ff-est-abc", secrets: [{ key: "FIELD_SHARED_SECRET", value: "s3cret" }, { key: "B", value: "2" }] } });
    expect(await c.listIps("ff-est-abc")).toEqual([
      { address: "66.1.2.3", type: "shared_v4" },
      { address: "::1", type: "v6" },
    ]);
  });

  it("reports no address when a shared v4 allocation answers without one", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { data: { allocateIpAddress: { ipAddress: null, app: { sharedIpAddress: null } } } } }));
    await expect(new FlyClient(CFG, f.fetchImpl).allocateIp("ff-est-abc", "shared_v4")).rejects.toMatchObject({ message: expect.stringContaining("returned no address") });
  });

  it("never passes the app's shared v4 off as the result of a dedicated v6 allocation", async () => {
    // The shared v4 is already on the app by the time v6 is allocated; a v6 answer with no node is a failure, not that address.
    const f = fakeFetch(() => ({ status: 200, body: { data: { allocateIpAddress: { ipAddress: null, app: { sharedIpAddress: "66.1.2.3" } } } } }));
    await expect(new FlyClient(CFG, f.fetchImpl).allocateIp("ff-est-abc", "v6")).rejects.toMatchObject({ message: expect.stringContaining("allocateIpAddress(v6)") });
  });

  it("surfaces GraphQL errors as FlyError", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { errors: [{ message: "Could not find App" }] } }));
    await expect(new FlyClient(CFG, f.fetchImpl).allocateIp("ff-est-nope", "v6")).rejects.toMatchObject({ message: expect.stringContaining("Could not find App") });
  });

  it("creates a volume in the configured region", async () => {
    const f = fakeFetch((url) => (url.endsWith("/apps/ff-est-abc/volumes") ? { status: 200, body: { id: "vol_1", name: "ff_data" } } : undefined));
    const c = new FlyClient(CFG, f.fetchImpl);
    expect(await c.createVolume("ff-est-abc", "ff_data", 1)).toEqual({ id: "vol_1" });
    expect(f.calls[0].body).toMatchObject({ name: "ff_data", region: "yyz", size_gb: 1, encrypted: true });
  });

  it("creates, reads, updates and execs a machine", async () => {
    const f = fakeFetch((url, body) => {
      if (url.endsWith("/machines") && body) return { status: 200, body: { id: "m1", name: body.name, config: body.config } };
      if (url.endsWith("/machines/m1") && !body) return { status: 200, body: { id: "m1", state: "started", config: { image: "i" } } };
      if (url.endsWith("/machines/m1") && body) return { status: 200, body: { id: "m1", instance_id: "new" } };
      if (url.endsWith("/machines/m1/exec")) return { status: 200, body: { exit_code: 0, stdout: "{\"ok\":1}\n", stderr: "" } };
      if (url.endsWith("/machines/gone")) return { status: 404, body: { error: "not found" } };
      return undefined;
    });
    const c = new FlyClient(CFG, f.fetchImpl);
    const cfg = estateMachineConfig(CFG, "vol_1", "boot", "signer");
    const m = await c.createMachine("ff-est-abc", "estate", cfg);
    expect(m.id).toBe("m1");
    expect(f.calls[0].body).toMatchObject({ name: "estate", region: "yyz", config: { image: CFG.image } });
    expect((await c.getMachine("ff-est-abc", "m1"))?.state).toBe("started");
    expect(await c.getMachine("ff-est-abc", "gone")).toBeNull();
    await c.updateMachine("ff-est-abc", "m1", cfg);
    expect(f.calls[3].body.config.image).toBe(CFG.image);
    const r = await c.exec("ff-est-abc", "m1", ["sh", "-c", "echo"], 15);
    expect(f.calls[4].body).toEqual({ command: ["sh", "-c", "echo"], timeout: 15 });
    expect(r).toEqual({ exit_code: 0, stdout: "{\"ok\":1}\n", stderr: "" });
  });
});

describe("estate machine config", () => {
  it("boots as an observer and arms every Phase F switch on update", () => {
    const boot = estateMachineConfig(CFG, "vol_1", "boot", "Signer X");
    expect(boot.image).toBe(CFG.image);
    expect(boot.env!.FIELD_SENTINEL_MODE).toBe("enforce");
    expect(boot.env!.FIELD_LEDGER_ANCHOR_KEY).toBe("/data/keys/ledger-anchor.pem");
    expect(boot.env!.FIELD_DOA_ROSTER).toBe("/data/doa-roster.yaml");
    expect(boot.env!.FIELD_LIFECYCLE_ROSTER).toBe("/data/owners.csv");
    expect(boot.env!.FORCE_GATEWAY_ENFORCE).toBeUndefined();
    expect(boot.env!.FIELD_LEDGER_SIGN_KEY).toBeUndefined();
    expect(boot.mounts).toEqual([{ volume: "vol_1", path: "/data", name: "ff_data" }]);
    expect(boot.guest).toEqual({ cpu_kind: "shared", cpus: 1, memory_mb: 2048 });
    expect(boot.services![0]).toMatchObject({ internal_port: 8080, autostop: "off", autostart: true, min_machines_running: 1 });
    expect(Object.keys(boot.checks!)).toEqual(["registry", "ledger", "sentinel"]);
    expect(boot.checks!.ledger).toMatchObject({ type: "http", port: 8080, path: "/ledger/health", interval: "30s", grace_period: "60s" });
    expect(boot.restart).toEqual({ policy: "always" });

    const armed = estateMachineConfig(CFG, "vol_1", "armed", "Signer X");
    expect(armed.env).toMatchObject({
      FIELD_LEDGER_SIGN_KEY: "/data/keys/ledger-sign.pem",
      FIELD_LEDGER_REQUIRE_SIGNING: "1",
      FIELD_ATTEST_SIGNER: "Signer X",
      FIELD_ATTEST_SIGN_KEY: "/data/keys/attest-sign.pem",
      FORCE_GATEWAY_ENFORCE: "1",
      FORCE_GATEWAY_TOOL_CHECK: "1",
    });
  });

  it("derives the public origin from the app name", () => {
    expect(estateOrigin("ff-est-abc")).toBe("https://ff-est-abc.fly.dev");
  });
});

describe("flyConfig", () => {
  const names = ["FLY_API_TOKEN", "FLY_ORG_SLUG", "FLY_ESTATE_IMAGE", "ESTATE_SECRET_MASTER", "FLY_REGION", "FLY_ESTATE_MEMORY_MB"];
  afterEach(() => {
    for (const n of names) delete process.env[n];
  });

  it("is null unless the token, org, image and secret master are all set", () => {
    expect(flyConfig()).toBeNull();
    process.env.FLY_API_TOKEN = "t";
    process.env.FLY_ORG_SLUG = "o";
    process.env.FLY_ESTATE_IMAGE = "i";
    expect(flyConfig()).toBeNull();
    process.env.ESTATE_SECRET_MASTER = "m";
    expect(flyConfig()).toEqual({ token: "t", org: "o", image: "i", region: "yyz", memory_mb: 2048 });
    process.env.FLY_REGION = "ord";
    process.env.FLY_ESTATE_MEMORY_MB = "4096";
    expect(flyConfig()).toMatchObject({ region: "ord", memory_mb: 4096 });
    process.env.FLY_ESTATE_MEMORY_MB = "12";
    expect(flyConfig()!.memory_mb).toBe(2048);
  });
});
