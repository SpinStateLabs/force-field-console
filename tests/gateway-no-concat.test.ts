// Rule: no outbound URL in the gateway is built by string concatenation of a base and a path. Every upstream URL (the
// forwarded request and the agent-pool gate's own registry reads) comes from upstreamTarget (src/lib/upstream.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import handler from "../netlify/functions/gateway.mts";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { issueKey } from "../src/lib/keys";

const SRC = readFileSync(join(__dirname, "..", "netlify/functions/gateway.mts"), "utf-8");
const ctx = {} as any;

describe("gateway source: no string-built upstream URL", () => {
  it("has no concatenation of a base with a request path", () => {
    expect(SRC).not.toMatch(/base\s*\+\s*url\.pathname/);
    expect(SRC).not.toMatch(/base\s*\+\s*path/);
    expect(SRC).not.toMatch(/estateUrl\s*\+/);
    expect(SRC).not.toMatch(/const\s+base\s*=/);
  });

  it("builds every fetched URL through upstreamTarget, and every fetch refuses to follow redirects", () => {
    const calls = [...SRC.matchAll(/\bfetch\(/g)].map((m) => m.index!);
    expect(calls.length).toBe(2); // the forwarded request and the pool gate's registry read
    expect(SRC.match(/upstreamTarget\(/g)?.length).toBe(2);
    for (const at of calls) {
      const close = SRC.indexOf("});", at) >= 0 ? SRC.indexOf("})", at) : SRC.length;
      expect(SRC.slice(at, close + 2), SRC.slice(at, at + 60)).toMatch(/redirect:\s*"manual"/);
    }
  });
});

describe("gateway behaviour: the measured shapes still never reach another host", () => {
  let user: User;
  let key: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    freshStore();
    process.env.ESTATE_URL = "https://sandbox.example";
    process.env.ESTATE_SHARED_SECRET = "sandbox-secret";
    user = await createUser("noconcat@example.com", "sufficiently-long-pass");
    key = (await issueKey(user, "t")).plaintext;
    fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.ESTATE_URL;
    delete process.env.ESTATE_SHARED_SECRET;
  });

  it.each(["/api/v1/%2e%2e/xx@other.example/p", "/api/v1/%2e%2e/xx.other.example/p", "/api/v1/x/%2e%2e/%2e%2e/yy:9/p", "/api/v1//other.example/x"])(
    "%s is refused and nothing is sent",
    async (p) => {
      const req = { url: "https://force-field-console.netlify.app" + p, method: "GET", headers: new Headers({ "x-api-key": key }), arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Request;
      const res = await handler(req, ctx);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
