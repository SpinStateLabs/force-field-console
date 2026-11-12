// Billing audit follow-ups (review of PR 15), H2 provisioning retry:
//  - retryEstate is conditional on the STORED status still being "error" (a race gives no extra retry)
//  - provision_retry is reset once an estate reaches ready
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { freshStore } from "./helpers";
import { createUser, saveUser, type User } from "../src/lib/users";
import { FlyError } from "../src/lib/fly";
import { MAX_ATTEMPTS, advanceEstate, autoRetryFailedEstate, getEstate, queueEstate, retryEstate, saveEstate } from "../src/lib/estates";

const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };

let user: User;
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, FLY_ENV);
  spy = vi.spyOn(console, "error").mockImplementation(() => {});
  user = await createUser("fu@example.com", "sufficiently-long-pass");
  user.tier = "operator";
  user.billing = { customer_id: "cus_1", subscription_id: "sub_1", status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
  await saveUser(user);
  await queueEstate(user);
});
afterEach(() => {
  spy.mockRestore();
  for (const k of Object.keys(FLY_ENV)) delete process.env[k];
});

const failingFly = () => ({ createApp: vi.fn(async () => { throw new FlyError(500, "boom"); }) }) as any;
async function exhaust(base: Date) {
  let e = (await getEstate(user.id))!;
  const fly = failingFly();
  for (let i = 0; i < MAX_ATTEMPTS; i++) e = (await advanceEstate(e, fly, { now: new Date(base.getTime() + i * 60_000) })).estate;
  return e;
}

describe("retryEstate is conditional on the stored status being error", () => {
  it("a stale copy cannot retry an estate the tick already auto-retried: 409, nothing overwritten, no extra retry", async () => {
    const e = await exhaust(new Date(Date.now() - 10 * 3_600_000));
    const stale = structuredClone(e);
    expect(await autoRetryFailedEstate(e, new Date())).toBe(true);
    const before = (await getEstate(user.id))!;
    expect(before.provision_retry!.count).toBe(1);
    await expect(retryEstate(stale)).rejects.toMatchObject({ status: 409, code: "not_failed" });
    const after = (await getEstate(user.id))!;
    expect(after.provision_retry).toEqual(before.provision_retry);
    expect(after.log).toEqual(before.log);
    expect(after.status).toBe("provisioning");
  });

  it("a manual retry of a genuinely failed estate still works", async () => {
    const e = await exhaust(new Date(Date.now() - 10 * 3_600_000));
    const r = await retryEstate(e);
    expect(r.status).toBe("provisioning");
    expect((await getEstate(user.id))!.provision_retry!.next_retry_at).toBeNull();
  });
});

describe("provision_retry is reset when provisioning succeeds", () => {
  const armedFetch = async (url: string) => {
    const body: Record<string, any> = {
      "/ledger/health": { signing: "on", require_signing: true, appendable: true, key_fingerprint: "fs" },
      "/gateway/health": { enforce: true, tool_check: true },
      "/attest/health": { signing: "on" },
    };
    const b = body[new URL(url).pathname];
    return b ? new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } }) : new Response("", { status: 503 });
  };

  it("wait_armed -> ready clears a leftover provision_retry", async () => {
    const e = (await getEstate(user.id))!;
    Object.assign(e, { step: "wait_armed", machine_id: "m_1", volume_id: "v_1", fingerprints: { "ledger-sign": "fs" }, provision_retry: { count: 2, next_retry_at: null } });
    await saveEstate(e);
    const r = await advanceEstate((await getEstate(user.id))!, {} as any, { fetchImpl: armedFetch as any });
    expect(r.estate.status).toBe("ready");
    expect((await getEstate(user.id))!.provision_retry ?? null).toBeNull();
  });

  it("step done -> ready clears a leftover provision_retry", async () => {
    const e = (await getEstate(user.id))!;
    Object.assign(e, { step: "done", provision_retry: { count: 1, next_retry_at: null } });
    await saveEstate(e);
    const r = await advanceEstate((await getEstate(user.id))!, {} as any);
    expect(r.estate.status).toBe("ready");
    expect((await getEstate(user.id))!.provision_retry ?? null).toBeNull();
  });
});
