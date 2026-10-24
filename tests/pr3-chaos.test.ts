import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import tickHandler from "../netlify/functions/estate-tick.mts";
import healthHandler from "../netlify/functions/health.mts";
import { ModelFly, machinesApiHandler } from "./model-fly";
import { FlyError } from "../src/lib/fly";
import { freshStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent, isGrantingUser, retryPendingSuspend } from "../src/lib/billing";
import { getEstate, listEstates, queueEstate, readback, saveEstate, setEstateAnthropicKey } from "../src/lib/estates";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };
let user: User;
let fly: Flaky;
const statuses: Record<string, string> = {};
const origDelay = readback.delayMs;
let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

class Flaky extends ModelFly {
  flaky = 0; // probability a call fails with 5xx/429
  private maybe() {
    if (this.flaky > 0 && rnd() < this.flaky) throw new FlyError(pick([503, 429, 500]), "flaky " + Math.floor(rnd() * 1e6));
  }
  async getMachine(a: string, id: string) { this.maybe(); return super.getMachine(a, id); }
  async updateMachine(a: string, id: string, c: any, o: any = {}) { this.maybe(); return super.updateMachine(a, id, c, o); }
  async stopMachine(a: string, id: string) { this.maybe(); return super.stopMachine(a, id); }
  async startMachine(a: string, id: string) { this.maybe(); return super.startMachine(a, id); }
  async waitMachine(a: string, id: string, s: string) { this.maybe(); return super.waitMachine(a, id, s); }
}

let stripeFault = 0;
function sub(id: string, status: string) {
  return { id, status, customer: "cus_1", items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] }, metadata: { user_id: user.id } };
}
const ev = (id: string, type: string, created: number, s: any) => ({ id, type, created, data: { object: s } });
const fetchImpl = (async (u: any) => {
  if (stripeFault > 0 && rnd() < stripeFault) {
    if (rnd() < 0.5) throw new Error("timeout");
    return new Response("{}", { status: 429 });
  }
  const id = String(u).split("/").pop()!;
  return new Response(JSON.stringify(sub(id, statuses[id] ?? "canceled")), { status: 200 });
}) as any;
const deps = () => ({ cfg: stripeConfig()!, fly: fly as any, fetchImpl });

async function tick() {
  const api = machinesApiHandler(fly);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (/^https:\/\/api\.machines\.dev\/v1\/apps\/[^/]+$/.test(u)) return new Response(JSON.stringify({ name: "a" }), { status: 200 });
    if (/ledger\/health/.test(u)) return new Response(JSON.stringify({ ok: true, appendable: true }), { status: 200 });
    return (await api(u, init)) ?? new Response("", { status: 404 });
  }) as any;
  try {
    return await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
  } finally {
    globalThis.fetch = realFetch;
  }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV);
  readback.delayMs = 2;
  user = await createUser("fz@example.com", "sufficiently-long-pass");
  fly = new Flaky();
  stripeFault = 0;
  for (const k of Object.keys(statuses)) delete statuses[k];
});
afterEach(() => {
  vi.useRealTimers();
  readback.delayMs = origDelay;
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV)]) delete process.env[k];
});

// The full 320-case sweep takes ~2 minutes (RV_N=320). By default: the first 40 cases plus the seeds that
// once failed (stale reads in revive: 22, 51, 125, 139, 287).
const CASES = process.env.RV_N ? Array.from({ length: Number(process.env.RV_N) }, (_, i) => i) : [...new Set([...Array.from({ length: 40 }, (_, i) => i), 22, 51, 125, 139, 287])];
describe("chaos: random Stripe/Fly faults, stale reads, interleavings", () => {
  for (const k of CASES)
    it(`case ${k}`, async () => {
      seed = 7919 * (k + 3);
      const startA = pick(["active", "active", "past_due", "trialing"]);
      user.tier = "operator";
      user.billing = { customer_id: "cus_1", subscription_id: "sub_A", status: startA, price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
      await saveUser(user);
      const e0 = await queueEstate(user);
      Object.assign(e0, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: "https://x.fly.dev" });
      await saveEstate(e0);
      const app0 = e0.app;
      fly.machine("m_1");
      fly.stopDelay = Math.floor(rnd() * 30);
      fly.startDelay = Math.floor(rnd() * 20);
      fly.waitDelay = Math.floor(rnd() * 10);
      // fault windows
      const timers: ReturnType<typeof setTimeout>[] = [];
      const win = (f: () => void, g: () => void) => { if (rnd() < 0.6) { f(); timers.push(setTimeout(g, 20 + Math.floor(rnd() * 150))); } };
      win(() => (fly.waitNever = true), () => (fly.waitNever = false));
      win(() => (fly.failStart = true), () => (fly.failStart = false));
      win(() => (fly.flaky = 0.35), () => (fly.flaky = 0));
      win(() => (stripeFault = 0.4), () => (stripeFault = 0));
      if (rnd() < 0.3 && !process.env.RV_NOSTALE) fly.staleReads = 3;
      if (rnd() < 0.2) fly.updateDelay = 15;

      // timeline at Stripe
      const tl: any[] = [];
      let t = 100;
      const finals: Record<string, string> = { sub_A: startA };
      const statusPool = ["active", "past_due", "unpaid", "canceled", "trialing", "incomplete_expired"];
      const nOps = 2 + Math.floor(rnd() * 5);
      const subsUsed = ["sub_A"];
      for (let i = 0; i < nOps; i++) {
        t += 50;
        const which = rnd() < 0.35 ? "sub_B" : rnd() < 0.15 ? "sub_C" : "sub_A";
        const cur = finals[which];
        if (which !== "sub_A" && !subsUsed.includes(which)) {
          subsUsed.push(which);
          finals[which] = "active";
          tl.push(ev(`${which}_new_${i}`, "customer.subscription.created", t, sub(which, "active")));
          continue;
        }
        if (cur === "canceled" || cur === "incomplete_expired") continue; // terminal at Stripe
        const ns = pick(statusPool);
        finals[which] = ns;
        tl.push(ev(`${which}_u_${i}`, ns === "canceled" ? "customer.subscription.deleted" : "customer.subscription.updated", t, sub(which, ns)));
      }
      for (const [id, s] of Object.entries(finals)) statuses[id] = s;
      const expectGrant = Object.values(finals).some((s) => ["active", "trialing", "past_due"].includes(s));

      const deliveries = [...tl, ...tl.filter(() => rnd() < 0.5)];
      deliveries.sort(() => rnd() - 0.5);
      const side: Promise<any>[] = [];
      const run = deliveries.map(async (d) => {
        await sleep(Math.floor(rnd() * 80));
        for (let i = 0; i < 25; i++) {
          try { await handleStripeEvent(d, deps()); return; } catch { await sleep(60); }
        }
        throw new Error("never delivered " + d.id);
      });
      for (let i = 0; i < 2; i++) side.push((async () => { await sleep(Math.floor(rnd() * 120)); try { await tick(); } catch {} })());
      side.push((async () => { await sleep(Math.floor(rnd() * 120)); try { await retryPendingSuspend(user.id, fly as any, new Date()); } catch {} })());
      side.push((async () => { await sleep(Math.floor(rnd() * 120)); try { const e = (await getEstate(user.id))!; await setEstateAnthropicKey(e, fly as any, "sk-ant-" + "a".repeat(40)); } catch {} })());
      await Promise.all([...run, ...side]);
      timers.forEach(clearTimeout);
      fly.waitNever = false; fly.failStart = false; fly.flaky = 0; stripeFault = 0; fly.updateDelay = 0; fly.staleReads = 0;

      // quiesce: tick until stable (bounded), moving the clock past every backoff
      let last = "";
      let rounds = 0;
      for (; rounds < 30; rounds++) {
        vi.setSystemTime(new Date(Date.now() + 7 * 3_600_000));
        const body = await tick();
        const e = (await getEstate(user.id))!;
        const snap = JSON.stringify([e.status, !!e.suspend_pending, !!e.resume_pending, fly.machine("m_1").state, fly.autostartOff("m_1"), body.outcomes]);
        if (snap === last && !Object.keys(body.outcomes).some((o) => /retry|lock/.test(o))) break;
        last = snap;
      }
      const e = (await getEstate(user.id))!;
      const u = (await getUserById(user.id))!;
      const granting = isGrantingUser(u);
      const obs = { k, finals, estate: e.status, spend: !!e.suspend_pending, resume: !!e.resume_pending, sub: u.billing?.subscription_id, bst: u.billing?.status, tier: u.tier, machine: fly.machine("m_1").state, autoOff: fly.autostartOff("m_1"), rounds, err: e.error };
      if (process.env.RV_DBG && granting && obs.machine !== "started") console.log("DBG", JSON.stringify({obs, flog: fly.log, elog: e.log.map((l:any)=>l.at+" "+l.step+" "+l.note), deliveries: deliveries.map((d:any)=>d.id+"@"+d.created+":"+d.data.object.status)}, null, 1));
      expect(granting, "billing mirror vs Stripe truth " + JSON.stringify(obs)).toBe(expectGrant);
      if (granting) expect(obs, JSON.stringify(obs)).toMatchObject({ estate: "ready", spend: false, resume: false, machine: "started", tier: "operator" });
      else expect(obs, JSON.stringify(obs)).toMatchObject({ estate: "suspended", spend: false, machine: "stopped", autoOff: true, tier: "sandbox" });
      expect(fly.ping("m_1")).toBe(granting ? "started" : "stopped");
      const all = await listEstates();
      expect(all.length).toBe(1);
      expect(all[0].app).toBe(app0);
      expect(all[0].volume_id).toBe("vol_1");
      expect(fly.machines.size).toBe(1);
    }, 60000);
});
