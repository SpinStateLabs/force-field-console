// The tick does not spend its budget on records the paid rule parks (review #29 full verdict, LOW 1), and does not kick a
// renewal for an owner who may not run the estate (LOW 3); the worker refuses such a renewal too.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { ModelFly, machinesApiHandler } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, saveUser, type User } from "../src/lib/users";
import { queueEstate, saveEstate } from "../src/lib/estates";
import { runWorker } from "../src/lib/worker";

const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };

let fly: ModelFly;
let st: any;

beforeEach(() => {
  st = freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV);
  fly = new ModelFly();
});
afterEach(() => {
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV)]) delete process.env[k];
});

async function owner(email: string, status: string, paid: boolean): Promise<User> {
  const u = await createUser(email, "sufficiently-long-pass");
  const sub = "sub_" + email.split("@")[0];
  u.tier = "operator";
  u.billing = { customer_id: "cus_1", subscription_id: sub, status, price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" } as any;
  await saveUser(u);
  if (paid) await st.setJSON("paid_subscriptions/" + sub, { customer: "cus_1", first_paid_invoice: "in_1", at: "2026-11-01T00:00:00Z" });
  return u;
}

async function tick() {
  const api = machinesApiHandler(fly);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => (await api(String(url), init)) ?? new Response("", { status: 404 })) as any;
  try {
    return await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("tick budget and renewals under the paid rule", () => {
  it("a parked record (owner trialing, never paid) is skipped: no worker kick and no direct advance", async () => {
    const u = await owner("parked@example.com", "trialing", false);
    const e = await queueEstate(u);
    e.status = "provisioning";
    await saveEstate(e);
    const body = await tick();
    expect(body.pending).toBe(1);
    expect(body.outcomes.parked).toBe(1);
    expect(Object.keys(body.outcomes).filter((k) => k === "kicked" || k.startsWith("direct_"))).toEqual([]);
  });

  it("a record whose owner may run an estate is still driven", async () => {
    const u = await owner("runs@example.com", "active", true);
    const e = await queueEstate(u);
    e.status = "provisioning";
    await saveEstate(e);
    const body = await tick();
    expect(body.outcomes.parked ?? 0).toBe(0);
    expect(Object.keys(body.outcomes).some((k) => k === "kicked" || k.startsWith("direct_"))).toBe(true);
  });

  async function readyWith(email: string, status: string, machineState: string) {
    const u = await owner(email, status, true);
    const e = await queueEstate(u);
    const mid = "m_" + email.split("@")[0];
    Object.assign(e, { status: "ready", step: "done", machine_id: mid, volume_id: "vol_1", url: `https://${e.app}.fly.dev`, self_agents: {} });
    await saveEstate(e);
    fly.machine(mid, { state: machineState });
    return u;
  }

  it("renewals: an eligible owner is kicked; an ineligible owner is skipped only while the machine is stopped", async () => {
    await readyWith("ok@example.com", "active", "started");
    await readyWith("dunning@example.com", "past_due", "started"); // running in dunning: still renews
    await readyWith("asleep@example.com", "past_due", "stopped"); // stopped and ineligible: skipped
    const body = await tick();
    expect(body.renewals_due).toBe(3);
    expect(body.outcomes.renew_skipped_ineligible).toBe(1);
    expect((body.outcomes.renew_kicked ?? 0) + (body.outcomes.renew_kick_failed ?? 0)).toBe(2);
  });

  it("the worker refuses a renewal only for an ineligible owner whose machine is not running", async () => {
    const stopped = await readyWith("stale@example.com", "past_due", "stopped");
    const calls: string[] = [];
    const rec: any = new Proxy(fly, { get: (target: any, name) => {
      const v = target[name];
      return typeof v === "function" ? (...args: any[]) => { calls.push(String(name)); return v.apply(target, args); } : v;
    } });
    const r1 = await runWorker(stopped.id, "renew", rec);
    expect(r1.last).toBe("renew_skipped_ineligible");
    expect(calls).toEqual(["getMachine"]); // a read only: no exec, no secret, no machine write
    const running = await readyWith("awake@example.com", "past_due", "started");
    const r2 = await runWorker(running.id, "renew", rec);
    expect(r2.last).not.toBe("renew_skipped_ineligible");
  });

  it("one record whose owner lookup throws is counted and skipped; the tick goes on (pending and renewals)", async () => {
    const bad = await owner("broken@example.com", "active", true);
    const eb = await queueEstate(bad);
    eb.status = "provisioning";
    await saveEstate(eb);
    const good = await owner("fine@example.com", "active", true);
    const eg = await queueEstate(good);
    eg.status = "provisioning";
    await saveEstate(eg);
    const badR = await readyWith("brokenready@example.com", "active", "started");
    const okR = await readyWith("fineready@example.com", "active", "started");
    const realGet = st.get.bind(st);
    st.get = async (k: string, o: any) => {
      if (k === "uid/" + bad.id || k === "uid/" + badR.id) throw new Error("store unavailable for this key");
      return realGet(k, o);
    };
    const body = await tick();
    expect(body.ok).toBe(true);
    expect(body.outcomes.eligibility_failed).toBe(1);
    expect(body.outcomes.renew_check_failed).toBe(1);
    expect(Object.keys(body.outcomes).some((k) => k === "kicked" || k.startsWith("direct_"))).toBe(true); // the good record
    expect((body.outcomes.renew_kicked ?? 0) + (body.outcomes.renew_kick_failed ?? 0)).toBe(1); // the good renewal
    void okR;
  });
});
