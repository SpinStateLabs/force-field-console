// Review #29 r5: B1 (every provisioning driver obeys the paid rule at ONE choke point, advanceEstate, plus the two
// routes), M2 (the hand-over's suspension survives a crash), L1 (paid past_due never releases a test hold), and the tick
// guard cases that fail if the stopped-machine start (line ~49) or the reconcile branch (line ~86) loses its own guard.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import estateHandler from "../netlify/functions/estate.mts";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { ModelFly, machinesApiHandler } from "./model-fly";
import { freshStore, type MemStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent } from "../src/lib/billing";
import { advanceEstate, getEstate, queueEstate, readback, saveEstate, type Estate } from "../src/lib/estates";
import { runWorker } from "../src/lib/worker";

const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };
let store: MemStore;
let user: User;
const origDelay = readback.delayMs;
/** Every request to Fly's API is recorded and refused: a parked record must cause none. */
let flyCalls: string[];

const paid = (id: string) => store.setJSON("paid_subscriptions/" + id, { customer: "cus_1", first_paid_invoice: "in_" + id, at: "2026-11-01T00:00:00Z" });
async function billing(subId: string, status: string) {
  user.tier = "operator";
  user.billing = { customer_id: "cus_1", subscription_id: subId, status, price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
  await saveUser(user);
}
async function record(over: Partial<Estate>) {
  const e = await queueEstate(user);
  Object.assign(e, over);
  await saveEstate(e);
  return (await getEstate(user.id))!;
}
/** A Fly client double that records every method called on it. */
function recordingFly() {
  const calls: string[] = [];
  const fly = new Proxy({}, { get: (_t, p) => (p === "then" ? undefined : vi.fn(async () => { calls.push(String(p)); throw new Error("fly refused in test"); })) }) as any;
  return { fly, calls };
}
async function post(path: string) {
  const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
  return estateHandler(new Request("http://portal.test" + path, { method: "POST", headers: { cookie } }), ctx);
}
const sub = (id: string, status: string) => ({ id, status, customer: "cus_1", items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] }, metadata: { user_id: user.id } });
const ev = (id: string, type: string, created: number, s: any, livemode = true) => ({ id, type, created, livemode, data: { object: s } });

beforeEach(async () => {
  store = freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV);
  delete process.env.URL; // no background kick: the tick and the retry route fall back to a direct advanceEstate
  readback.delayMs = 3;
  user = await createUser("gate@example.com", "sufficiently-long-pass");
  flyCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any) => {
    flyCalls.push(String(url));
    return new Response(JSON.stringify({ error: "refused in test" }), { status: 500, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  readback.delayMs = origDelay;
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV)]) delete process.env[k];
});

describe("B1: no provisioning driver touches Fly for an account that may not run an estate", () => {
  it("legacy TRIALING provisioning record: POST /api/estate/advance is refused (409 estate_parked), no Fly call", async () => {
    await billing("sub_T", "trialing");
    await record({ status: "provisioning" });
    const r = await post("/api/estate/advance");
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("estate_parked");
    expect(flyCalls).toEqual([]);
    expect((await getEstate(user.id))!.status).toBe("provisioning");
  });

  it("PAID but past_due with an errored estate: POST /api/estate/retry is refused (409 estate_parked), still error, no Fly call", async () => {
    await paid("sub_P");
    await billing("sub_P", "past_due");
    await record({ status: "error", error: "boom" });
    const r = await post("/api/estate/retry");
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("estate_parked");
    expect((await getEstate(user.id))!.status).toBe("error");
    expect(flyCalls).toEqual([]);
  });

  it("the background worker (session or internal token) provisions nothing for it", async () => {
    await billing("sub_T", "trialing");
    await record({ status: "provisioning" });
    const { fly, calls } = recordingFly();
    const out = await runWorker(user.id, "advance", fly, { budgetMs: 2000, sleepMs: 1, sleep: async () => {} });
    expect(calls).toEqual([]);
    expect(out.status).toBe("provisioning");
  });

  it("the tick's pending list provisions nothing for it (pending_manual is not promoted either)", async () => {
    await billing("sub_T", "trialing");
    await record({ status: "pending_manual" });
    const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
    expect(flyCalls.filter((u) => u.includes("machines.dev"))).toEqual([]);
    // LOW 1 (review #29 full verdict): the tick now skips a parked record before kicking a worker or advancing it.
    expect(body.outcomes.parked).toBe(1);
    expect(body.outcomes.direct_idle ?? 0).toBe(0);
    expect((await getEstate(user.id))!.status).toBe("pending_manual");
  });

  it("advanceEstate itself (the choke point) answers idle with the fixed parked note", async () => {
    await billing("sub_U", "active"); // active but never paid
    const e = await record({ status: "provisioning" });
    const { fly, calls } = recordingFly();
    const r = await advanceEstate(e, fly);
    expect(r.outcome).toBe("idle");
    expect(r.note).toMatch(/^parked: /);
    expect(calls).toEqual([]);
  });

  it("control: active AND paid is provisioned (the worker reaches Fly)", async () => {
    await paid("sub_P");
    await billing("sub_P", "active");
    await record({ status: "provisioning" });
    const { fly, calls } = recordingFly();
    await runWorker(user.id, "advance", fly, { budgetMs: 500, sleepMs: 1, sleep: async () => {} });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("M2: the hand-over's suspension survives a crash (redelivery still suspends)", () => {
  /** Make the store throw ONCE on the first write to a key with `prefix`. */
  function failOnce(prefix: string) {
    const s: any = store;
    let armed = true;
    for (const m of ["setJSON", "setJSONIfMatch", "setJSONIfNew"]) {
      const orig = s[m].bind(s);
      s[m] = async (k: string, ...rest: any[]) => {
        if (armed && k.startsWith(prefix)) { armed = false; throw new Error("injected crash writing " + prefix); }
        return orig(k, ...rest);
      };
    }
  }
  async function setup(fly: ModelFly) {
    await paid("sub_A");
    await billing("sub_A", "active");
    await record({ status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: "https://x.fly.dev" });
    fly.machine("m_1");
    const subB = sub("sub_B", "trialing"); // remembered, never paid
    const fetchImpl = (async (url: string) => new Response(JSON.stringify(url.endsWith("/sub_B") ? subB : { error: {} }), { status: url.endsWith("/sub_B") ? 200 : 404 })) as any;
    const deps = { cfg: stripeConfig()!, fly: fly as any, fetchImpl };
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 150, subB), deps);
    return deps;
  }
  it.each(["estates/", "users/"])("a crash on the first %s write during the hand-over: the redelivered event leaves the estate suspended on sub_B", async (prefix) => {
    vi.unstubAllGlobals();
    const fly = new ModelFly();
    const deps = await setup(fly);
    failOnce(prefix);
    const del = ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled"));
    await expect(handleStripeEvent(del, deps)).rejects.toThrow(/injected crash/);
    await handleStripeEvent(del, deps); // Stripe redelivers the same event
    expect((await getUserById(user.id))!.billing).toMatchObject({ subscription_id: "sub_B", status: "trialing" });
    const e = (await getEstate(user.id))!;
    expect(e.status === "suspended" || Boolean(e.suspend_pending)).toBe(true);
  });
});

describe("L1: a paid past_due subscription never releases a test hold", () => {
  it("test-held record from a test-mode grant; then a LIVE past_due event on the paid subscription keeps the hold", async () => {
    vi.unstubAllGlobals();
    await paid("sub_A");
    const fly = new ModelFly();
    await handleStripeEvent(ev("a_new", "customer.subscription.created", 100, sub("sub_A", "active"), false), { cfg: stripeConfig()!, fly: fly as any });
    expect((await getEstate(user.id))!).toMatchObject({ status: "pending_manual", test_hold: true });
    await handleStripeEvent(ev("a_pd", "customer.subscription.updated", 200, sub("sub_A", "past_due")), { cfg: stripeConfig()!, fly: fly as any });
    const e = (await getEstate(user.id))!;
    expect(e.test_hold).toBe(true);
    expect(e.status).toBe("pending_manual");
  });
});

describe("tick guards, each on its own (the per-estate retry step would otherwise hide a lost guard)", () => {
  async function tick(fly: ModelFly) {
    const api = machinesApiHandler(fly);
    vi.stubGlobal("fetch", (async (url: any, init?: any) => {
      const u = String(url);
      if (/^https:\/\/api\.machines\.dev\/v1\/apps\/[^/]+$/.test(u)) return new Response(JSON.stringify({ name: "x", status: "deployed" }), { status: 200 });
      if (/\.fly\.dev\//.test(u)) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      return (await api(u, init)) ?? new Response("", { status: 404 });
    }) as any);
    return (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
  }
  it("stopped-machine start: ONE tick for an unpaid active account queues no resume (the guard on the start itself)", async () => {
    const fly = new ModelFly();
    await billing("sub_U", "active");
    await record({ status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: "https://x.fly.dev" });
    fly.machine("m_1").state = "stopped";
    const body = await tick(fly);
    expect(body.machine_stopped).toBe(0);
    expect((await getEstate(user.id))!.resume_pending ?? null).toBeNull();
  });
  it("reconcile: ONE tick for an unpaid trialing account with a suspended estate puts it in no retry work at all", async () => {
    const fly = new ModelFly();
    await billing("sub_T", "trialing");
    await record({ status: "suspended", step: "done", machine_id: "m_1", volume_id: "vol_1", url: "https://x.fly.dev", suspended_from: "ready", suspended_at: "2026-11-01T00:00:00Z" } as any);
    fly.machine("m_1").state = "stopped";
    const body = await tick(fly);
    expect(Object.keys(body.outcomes).filter((k) => /retry|resume/.test(k))).toEqual([]);
    expect((await getEstate(user.id))!.status).toBe("suspended");
  });
});
