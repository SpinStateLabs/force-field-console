// Review #29 r6 C2: maintenance writes on a READY estate (image upgrade, Anthropic key, self-agent renewal) may update a
// RUNNING machine for any ready estate, but none may START a stopped machine unless the owner may run an estate
// (mayRunEstate: active AND this subscription paid). The write is staged with skip_launch and applies at the next
// permitted start; an image upgrade that cannot start the machine is deferred (no write, no failing poll).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import estateHandler from "../netlify/functions/estate.mts";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { ModelFly, machinesApiHandler } from "./model-fly";
import { freshStore, seedPaid, type MemStore } from "./helpers";
import { createUser, saveUser, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { SELF_AGENTS, UPGRADE_DEFER_MS, checkEstateHealth, getEstate, queueEstate, readback, saveEstate, setEstateAnthropicKey, updateMachineGuarded, upgradeEstateImage, type Estate } from "../src/lib/estates";
import { renewSelfAgents } from "../src/lib/renewal";

const ctx = {} as any;
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };
const KEY = "sk-ant-" + "a".repeat(40);
let store: MemStore;
let user: User;
let fly: ModelFly;
const origDelay = readback.delayMs;

async function billing(status: string, subId = "sub_P") {
  user.tier = "operator";
  user.billing = { customer_id: "cus_1", subscription_id: subId, status, price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
  await saveUser(user);
}
async function ready(state: "started" | "stopped"): Promise<Estate> {
  const e = await queueEstate(user);
  Object.assign(e, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev`, image: "registry.fly.io/x:old" });
  // fresh self-agent tokens: no renewal is due (a due renewal keeps the tick from kicking an upgrade)
  e.self_agents = Object.fromEntries(SELF_AGENTS.map((a) => [a.id, { provisioned_at: new Date().toISOString() }]));
  await saveEstate(e);
  fly.machine("m_1").state = state;
  return (await getEstate(user.id))!;
}
const updates = () => fly.log.filter((l) => l.startsWith("update "));
/** The real FlyClient over the model (the routes and the tick build their own client from FLY_* env). */
function stubFetch() {
  const api = machinesApiHandler(fly);
  vi.stubGlobal("fetch", (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes("api.fly.io/graphql")) return new Response(JSON.stringify({ data: { setSecrets: { release: null } } }), { status: 200, headers: { "content-type": "application/json" } });
    if (/^https:\/\/api\.machines\.dev\/v1\/apps\/[^/]+$/.test(u)) return new Response(JSON.stringify({ name: "x", status: "deployed" }), { status: 200 });
    if (/\.fly\.dev\//.test(u)) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    return (await api(u, init)) ?? new Response("", { status: 404 });
  }) as any);
}

beforeEach(async () => {
  store = freshStore();
  Object.assign(process.env, FLY_ENV);
  delete process.env.URL;
  readback.delayMs = 3;
  user = await createUser("start@example.com", "sufficiently-long-pass");
  fly = new ModelFly();
  await seedPaid("sub_P"); // the subscription HAS paid; the cases below differ by status
});
afterEach(() => {
  vi.unstubAllGlobals();
  readback.delayMs = origDelay;
  for (const k of Object.keys(FLY_ENV)) delete process.env[k];
});

describe("C2: no maintenance path starts a stopped machine for an owner who may not run an estate", () => {
  it("POST /api/estate/anthropic-key, stopped machine, past_due (paid) owner: key placed, machine NOT started (skip_launch)", async () => {
    await billing("past_due");
    await ready("stopped");
    stubFetch();
    const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
    const r = await estateHandler(new Request("http://portal.test/api/estate/anthropic-key", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ key: KEY }) }), ctx);
    expect(r.status).toBe(200);
    expect(fly.machine("m_1").state).toBe("stopped");
    expect(updates()).toEqual(["update m_1 autostart=true skip=true"]);
    expect((await getEstate(user.id))!.log.at(-1)!.note).toMatch(/stays stopped until our next permitted start or until Fly autostart wakes it on traffic/);
  });

  it("image upgrade (worker / tick), stopped machine, past_due owner: deferred, no Fly write, machine NOT started, no failed rollout", async () => {
    await billing("past_due");
    const e = await ready("stopped");
    const r = await upgradeEstateImage(e, fly as any, { polls: 1, sleepMs: 1, sleep: async () => {} });
    expect(r.outcome).toBe("unchanged");
    expect(updates()).toEqual([]);
    expect(fly.machine("m_1").state).toBe("stopped");
    const after = (await getEstate(user.id))!;
    expect(after.upgrade_failed_image ?? null).toBeNull();
    expect(after.upgrade_deferred).toMatchObject({ image: "registry.fly.io/x:new" });
    expect(after.image).toBe("registry.fly.io/x:old");
  });

  it("the tick does not keep re-kicking a deferred upgrade (it would block the rollout queue for every other estate)", async () => {
    await billing("past_due");
    const e = await ready("stopped");
    await upgradeEstateImage(e, fly as any, { polls: 1, sleepMs: 1, sleep: async () => {} });
    stubFetch();
    const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
    expect(body.drifted).toBe(0);
  });

  it("self-agent renewal, stopped machine, trialing owner: tokens staged, machine NOT started", async () => {
    await billing("trialing", "sub_T");
    const e = await ready("stopped");
    await renewSelfAgents(e, fly as any);
    expect(fly.machine("m_1").state).toBe("stopped");
    expect(updates()).toEqual(["update m_1 autostart=true skip=true"]);
  });

  it("control: RUNNING machine, past_due owner: maintenance still restarts it (it keeps running anyway)", async () => {
    await billing("past_due");
    const e = await ready("started");
    await setEstateAnthropicKey(e, fly as any, KEY);
    expect(updates()).toEqual(["update m_1 autostart=true skip=false"]);
    expect(fly.machine("m_1").state).toBe("started");
  });

  it("control: stopped machine, ACTIVE and paid owner: the update starts it as before", async () => {
    await billing("active");
    const e = await ready("stopped");
    await setEstateAnthropicKey(e, fly as any, KEY);
    expect(updates()).toEqual(["update m_1 autostart=true skip=false"]);
    expect(fly.machine("m_1").state).toBe("started");
  });
});

describe("r7: our own health probe never wakes an ineligible owner's stopped machine (F1); launched is honoured (F3)", () => {
  const ARMED = (url: string) => {
    const path = new URL(url).pathname;
    const body = path === "/ledger/health" ? { ok: true, signing: "on", require_signing: true, appendable: true } : path === "/gateway/health" ? { enforce: true, tool_check: true } : { signing: "on" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  it("health probe, stopped machine, past_due owner: no request to the estate origin, outcome stopped_owner_ineligible, nothing written", async () => {
    await billing("past_due");
    const e = await ready("stopped");
    (fly as any).getApp = async () => ({ name: e.app });
    const probes: string[] = [];
    const before = JSON.stringify(await getEstate(user.id));
    const h = await checkEstateHealth(e, fly as any, { fetchImpl: (async (u: string) => (probes.push(u), ARMED(u))) as any });
    expect(h).toBe("stopped_owner_ineligible");
    expect(probes).toEqual([]);
    expect(fly.machine("m_1").state).toBe("stopped");
    expect(JSON.stringify(await getEstate(user.id))).toBe(before);
  });

  it("control: the probe IS sent for an active, paid owner (and for a running machine of a past_due owner)", async () => {
    await billing("active");
    const e = await ready("stopped");
    (fly as any).getApp = async () => ({ name: e.app });
    const probes: string[] = [];
    await checkEstateHealth(e, fly as any, { fetchImpl: (async (u: string) => (probes.push(u), ARMED(u))) as any });
    expect(probes.length).toBe(1);
    await billing("past_due");
    fly.machine("m_1").state = "started";
    await checkEstateHealth((await getEstate(user.id))!, fly as any, { fetchImpl: (async (u: string) => (probes.push(u), ARMED(u))) as any });
    expect(probes.length).toBe(2);
  });

  it("the guard WITHOUT readCurrent (the arm path): stopped + ineligible owner => skip_launch, launched false; eligible => launched", async () => {
    await billing("trialing", "sub_T");
    const e = await ready("stopped");
    const r1 = await updateMachineGuarded(e, fly as any, () => ({ image: "img", services: [{ internal_port: 8080, autostart: true }] }) as any);
    expect(r1.launched).toBe(false);
    expect(fly.machine("m_1").state).toBe("stopped");
    await billing("active");
    const r2 = await updateMachineGuarded(e, fly as any, () => ({ image: "img", services: [{ internal_port: 8080, autostart: true }] }) as any);
    expect(r2.launched).toBe(true);
    expect(fly.machine("m_1").state).toBe("started");
    expect(updates()).toEqual(["update m_1 autostart=true skip=true", "update m_1 autostart=true skip=false"]);
  });

  it("F3: the machine stops between the upgrade's pre-check and the in-lock check: staged, NOT a failed rollout, no posture poll", async () => {
    await billing("past_due");
    const e = await ready("started");
    const real = fly.getMachine.bind(fly);
    let reads = 0;
    (fly as any).getMachine = async (app: string, id: string) => {
      reads += 1;
      if (reads === 2) fly.machine("m_1").state = "stopped"; // stops right after the pre-check saw it running
      return real(app, id);
    };
    const polls: string[] = [];
    const r = await upgradeEstateImage(e, fly as any, { polls: 2, sleepMs: 1, sleep: async () => {}, fetchImpl: (async (u: string) => (polls.push(u), ARMED(u))) as any });
    expect(r.outcome).toBe("unchanged");
    expect(polls).toEqual([]);
    const after = (await getEstate(user.id))!;
    expect(after.upgrade_failed_image ?? null).toBeNull();
    expect(after.upgrade_deferred).toMatchObject({ image: "registry.fly.io/x:new" });
    expect(fly.machine("m_1").state).toBe("stopped");
  });

  it("a deferral expires after UPGRADE_DEFER_MS: the tick counts the estate as drifted again, and a later successful upgrade clears the marker", async () => {
    await billing("past_due");
    const e = await ready("stopped");
    await upgradeEstateImage(e, fly as any, { polls: 1, sleepMs: 1, sleep: async () => {} });
    stubFetch();
    expect((await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json()).drifted).toBe(0);
    const old = (await getEstate(user.id))!;
    old.upgrade_deferred = { image: old.upgrade_deferred!.image, at: new Date(Date.now() - UPGRADE_DEFER_MS - 60_000).toISOString() };
    await saveEstate(old);
    expect((await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json()).drifted).toBe(1);
    vi.unstubAllGlobals();
    await billing("active"); // the owner pays again: the retried upgrade may start the machine
    const r = await upgradeEstateImage((await getEstate(user.id))!, fly as any, { polls: 2, sleepMs: 1, sleep: async () => {}, fetchImpl: ARMED as any });
    expect(r.outcome).toBe("upgraded");
    const done = (await getEstate(user.id))!;
    expect(done.upgrade_deferred ?? null).toBeNull();
    expect(done.image).toBe("registry.fly.io/x:new");
  });
});
