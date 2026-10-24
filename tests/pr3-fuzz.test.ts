import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelFly } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent, retryPendingSuspend } from "../src/lib/billing";
import { getEstate, queueEstate, readback, saveEstate, setEstateAnthropicKey } from "../src/lib/estates";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };
let user: User;
let fly: ModelFly;
const statuses: Record<string, string> = {};
const origDelay = readback.delayMs;
let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
function sub(id: string, status: string) {
  return { id, status, customer: "cus_1", items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] }, metadata: { user_id: user.id } };
}
const ev = (id: string, type: string, created: number, s: any) => ({ id, type, created, data: { object: s } });
const fetchImpl = (async (u: any) => {
  const id = String(u).split("/").pop()!;
  return new Response(JSON.stringify(sub(id, statuses[id] ?? "canceled")), { status: 200 });
}) as any;
const deps = () => ({ cfg: stripeConfig()!, fly: fly as any, fetchImpl });
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV);
  readback.delayMs = 2;
  user = await createUser("fz@example.com", "sufficiently-long-pass");
  fly = new ModelFly();
  for (const k of Object.keys(statuses)) delete statuses[k];
});
afterEach(() => {
  readback.delayMs = origDelay;
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV)]) delete process.env[k];
});

// Timeline at Stripe (event.created): B created active 200; A deleted 250; B updated 300 (status s1); optionally B deleted 400.
const SCEN = [
  { name: "A->B", bFinal: "active", extra: false },
  { name: "A->B->pastdue", bFinal: "past_due", extra: false },
  { name: "A->B->deleted", bFinal: "canceled", extra: true },
  { name: "A->B->unpaid", bFinal: "unpaid", extra: false },
];

describe("fuzz interleavings (with and without Fly faults: the wait times out, the start fails)", () => {
  for (const faults of [false, true])
  for (const sc of SCEN)
    for (let k = 0; k < (faults ? 8 : 12); k++)
      it(`${sc.name}${faults ? " +faults" : ""} #${k}`, async () => {
        seed = 1000 * (SCEN.indexOf(sc) + 1) + k;
        user.tier = "operator";
        user.billing = { customer_id: "cus_1", subscription_id: "sub_A", status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
        await saveUser(user);
        const e0 = await queueEstate(user);
        Object.assign(e0, { status: "ready", step: "done", machine_id: "m_1", volume_id: "vol_1", url: "https://x.fly.dev" });
        await saveEstate(e0);
        fly.machine("m_1");
        fly.stopDelay = Math.floor(rnd() * 40);
        fly.startDelay = Math.floor(rnd() * 20);
        fly.waitDelay = Math.floor(rnd() * 10);
        const timers: ReturnType<typeof setTimeout>[] = [];
        if (faults) {
          fly.waitNever = true;
          fly.failStart = true;
          timers.push(setTimeout(() => (fly.waitNever = false), 30 + Math.floor(rnd() * 60)));
          timers.push(setTimeout(() => (fly.failStart = false), 50 + Math.floor(rnd() * 80)));
        }
        statuses.sub_A = "canceled";
        statuses.sub_B = sc.bFinal;
        const events = [
          ev("b_new", "customer.subscription.created", 200, sub("sub_B", "active")),
          ev("a_del", "customer.subscription.deleted", 250, sub("sub_A", "canceled")),
          ev("b_upd", "customer.subscription.updated", 300, sub("sub_B", sc.bFinal)),
          ...(sc.extra ? [ev("b_del", "customer.subscription.deleted", 400, sub("sub_B", "canceled"))] : []),
          ev("a_old", "customer.subscription.created", 100, sub("sub_A", "active")),
        ];
        // duplicates + random order + random start delay; each delivery retried like Stripe until it succeeds
        const deliveries = [...events, ...events.filter(() => rnd() < 0.5)];
        deliveries.sort(() => rnd() - 0.5);
        const side: Promise<any>[] = [];
        const run = deliveries.map(async (d) => {
          await sleep(Math.floor(rnd() * 60));
          for (let i = 0; i < 20; i++) {
            try {
              await handleStripeEvent(d, deps());
              return;
            } catch {
              await sleep(80);
            }
          }
          throw new Error("never delivered " + d.id);
        });
        side.push((async () => { await sleep(Math.floor(rnd() * 80)); try { await retryPendingSuspend(user.id, fly as any, new Date()); } catch {} })());
        side.push((async () => { await sleep(Math.floor(rnd() * 80)); try { const e = (await getEstate(user.id))!; await setEstateAnthropicKey(e, fly as any, "sk-ant-" + "a".repeat(40)); } catch {} })());
        await Promise.all([...run, ...side]);
        timers.forEach(clearTimeout);
        fly.waitNever = false;
        fly.failStart = false;
        // settle: tick retries until nothing pending
        for (let i = 0; i < 3; i++) { try { await retryPendingSuspend(user.id, fly as any, new Date(Date.now() + 3_600_000)); } catch {} }
        const e = (await getEstate(user.id))!;
        const u = (await getUserById(user.id))!;
        const granting = sc.bFinal === "active" || sc.bFinal === "past_due";
        const obs = { estate: e.status, pending: !!e.suspend_pending, sub: u.billing?.subscription_id, billingStatus: u.billing?.status, machine: fly.machine("m_1").state, autostartOff: fly.autostartOff("m_1"), tier: u.tier };
        if (granting) expect(obs, JSON.stringify(obs)).toMatchObject({ estate: "ready", pending: false, machine: "started", autostartOff: false, sub: "sub_B", tier: "operator" });
        else expect(obs, JSON.stringify(obs)).toMatchObject({ estate: "suspended", pending: false, machine: "stopped", autostartOff: true, tier: "sandbox" });
        expect(fly.ping("m_1")).toBe(granting ? "started" : "stopped");
      }, 30000);
});
