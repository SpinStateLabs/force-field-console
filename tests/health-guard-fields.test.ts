// /api/health exposes, as presence/booleans only, what an outside reader needs to know that the Stripe test-mode guard
// (PR 21) is deployed and how it is set: stripe_mode ("test" | "live" | null, from the secret key's PREFIX only, never
// the key) and test_mode_provisioning (the opt-in STRIPE_TEST_MODE_PROVISIONING is exactly "true"). The fields' presence
// plus version 0.2.3 mark a deployment that carries the guard.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import healthHandler, { PORTAL_VERSION } from "../netlify/functions/health.mts";
import { freshStore } from "./helpers";

const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const KEYS = [...Object.keys(STRIPE_ENV), "STRIPE_TEST_MODE_PROVISIONING"];

async function health() {
  const res = await healthHandler(new Request("http://portal.test/api/health"), ctx);
  return { text: await res.clone().text(), body: await res.json() };
}

beforeEach(() => {
  freshStore();
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("health exposes the test-mode guard state", () => {
  it("version is 0.2.3 (the first version that carries the guard)", async () => {
    expect(PORTAL_VERSION).toBe("0.2.3");
    expect((await health()).body.version).toBe("0.2.3");
  });

  it("billing not configured: stripe_mode null, test_mode_provisioning false", async () => {
    const { body } = await health();
    expect(body.stripe_mode).toBeNull();
    expect(body.test_mode_provisioning).toBe(false);
  });

  it("an sk_test_ key reports stripe_mode test; the key itself never appears", async () => {
    Object.assign(process.env, STRIPE_ENV, { STRIPE_SECRET_KEY: "sk_test_SECRETVALUE123" });
    const { body, text } = await health();
    expect(body.stripe_mode).toBe("test");
    expect(text).not.toContain("SECRETVALUE123");
    expect(text).not.toContain("sk_test_");
  });

  it("sk_live_ and rk_live_ keys report live; rk_test_ reports test", async () => {
    for (const [key, mode] of [["sk_live_A", "live"], ["rk_live_B", "live"], ["rk_test_C", "test"]] as const) {
      Object.assign(process.env, STRIPE_ENV, { STRIPE_SECRET_KEY: key });
      expect((await health()).body.stripe_mode).toBe(mode);
    }
  });

  it("a key with an unknown prefix reports null (unknown), not a guess", async () => {
    Object.assign(process.env, STRIPE_ENV, { STRIPE_SECRET_KEY: "weird_key" });
    expect((await health()).body.stripe_mode).toBeNull();
  });

  it("the prefix must start the key and end in an underscore (review H1)", async () => {
    for (const key of [" sk_test_x", "sk_test", "xsk_live_y", "sk_testx_y"]) {
      Object.assign(process.env, STRIPE_ENV, { STRIPE_SECRET_KEY: key });
      expect((await health()).body.stripe_mode).toBeNull();
    }
  });

  it("test_mode_provisioning is true only for the exact opt-in value", async () => {
    Object.assign(process.env, STRIPE_ENV);
    for (const [v, want] of [["true", true], ["TRUE", false], ["1", false], ["", false]] as const) {
      process.env.STRIPE_TEST_MODE_PROVISIONING = v;
      expect((await health()).body.test_mode_provisioning).toBe(want);
    }
  });
});
