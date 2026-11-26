import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import handler from "../netlify/functions/gateway.mts";
import { freshStore } from "./helpers";
import { createUser, type User } from "../src/lib/users";
import { issueKey, revokeKey } from "../src/lib/keys";
import { TIERS } from "../src/lib/tiers";

const ctx = {} as any; // Netlify Context — unused by the gateway in tests

// Normalizes however the gateway chose to invoke fetch (url string, URL, or Request).
function captureCall(input: any, init?: any): { url: string; headers: Headers } {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const headers = new Headers(
    init?.headers ?? (typeof input === "object" && input?.headers ? input.headers : undefined)
  );
  return { url, headers };
}

describe("gateway", () => {
  let user: User;
  let plaintext: string;
  let hash: string;

  beforeEach(async () => {
    freshStore();
    delete process.env.ESTATE_URL;
    delete process.env.ESTATE_SHARED_SECRET;
    user = await createUser("gateway@example.com", "sufficiently-long-pass");
    const issued = await issueKey(user, "gateway-test");
    plaintext = issued.plaintext;
    hash = issued.ref.hash;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.ESTATE_URL;
    delete process.env.ESTATE_SHARED_SECRET;
  });

  it("401 missing_key when no x-api-key header is sent", async () => {
    const res = await handler(new Request("http://portal.test/api/v1/registry/agents"), ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("missing_key");
  });

  it("401 unknown_key for a key that was never issued", async () => {
    const res = await handler(
      new Request("http://portal.test/api/v1/registry/agents", {
        headers: { "x-api-key": "ff_live_" + "0".repeat(40) },
      }),
      ctx
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unknown_key");
  });

  it("403 revoked_key for a revoked key", async () => {
    await revokeKey(user, hash);
    const res = await handler(
      new Request("http://portal.test/api/v1/registry/agents", {
        headers: { "x-api-key": plaintext },
      }),
      ctx
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("revoked_key");
  });

  it("503 estate_not_attached when ESTATE_URL is unset", async () => {
    const res = await handler(
      new Request("http://portal.test/api/v1/registry/agents", {
        headers: { "x-api-key": plaintext },
      }),
      ctx
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("estate_not_attached");
  });

  it("proxies to ESTATE_URL with stripped path, estate headers, and no client credentials", async () => {
    process.env.ESTATE_URL = "https://estate.test";
    process.env.ESTATE_SHARED_SECRET = "shared-secret-test";

    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init?: any) => {
        calls.push(captureCall(input, init));
        return new Response(JSON.stringify({ upstream: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );

    const res = await handler(
      new Request("http://portal.test/api/v1/registry/agents?limit=5", {
        headers: {
          "x-api-key": plaintext,
          accept: "application/json",
          cookie: "ff_session=must-not-cross",
          authorization: "Bearer must-not-cross",
          // The agent's identity for the estate's enforcing gateway: must pass through.
          "x-field-agent-id": "invoice-bot",
          "x-field-token": "tok-123",
          "x-field-action": "draft invoice",
          "x-force-preset": "audit",
          // A caller may not impersonate the perimeter or another tenant.
          "x-field-auth": "spoofed-secret",
          "x-ff-tenant": "someone-else",
        },
      }),
      ctx
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ upstream: true });

    expect(calls).toHaveLength(1);
    // /api/v1 stripped; search preserved.
    expect(calls[0].url).toBe("https://estate.test/registry/agents?limit=5");
    expect(calls[0].headers.get("x-field-auth")).toBe("shared-secret-test");
    expect(calls[0].headers.get("x-ff-tenant")).toBe(user.id);
    expect(calls[0].headers.get("x-field-agent-id")).toBe("invoice-bot");
    expect(calls[0].headers.get("x-field-token")).toBe("tok-123");
    expect(calls[0].headers.get("x-field-action")).toBe("draft invoice");
    expect(calls[0].headers.get("x-force-preset")).toBe("audit");
    // Client credentials must never cross the proxy boundary.
    expect(calls[0].headers.get("cookie")).toBeNull();
    expect(calls[0].headers.get("authorization")).toBeNull();
    expect(calls[0].headers.get("x-api-key")).toBeNull();
  });

  it("429 with Retry-After once the minute budget is exhausted", async () => {
    process.env.ESTATE_URL = "https://estate.test";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    );
    // Pin Date only, so the whole burst lands in one minute window without
    // touching real timers (the gateway's AbortSignal.timeout needs those).
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.UTC(2026, 7, 1, 6, 0, 15)) });

    const mk = () =>
      new Request("http://portal.test/api/v1/ledger/entries", {
        headers: { "x-api-key": plaintext },
      });

    for (let i = 0; i < TIERS.sandbox.rpm; i++) {
      const res = await handler(mk(), ctx);
      expect(res.status).toBe(200);
    }

    const blocked = await handler(mk(), ctx);
    expect(blocked.status).toBe(429);
    const retryAfter = blocked.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
