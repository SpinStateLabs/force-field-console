// Price book rev 4 (Don, 2026-11-21 "Adopt all four"), changes 1 and 2 only. Changes 3 (trials run on the shared
// Sandbox) and 4 (Operator has no dedicated estate) are HELD on a data-isolation question (the shared estate has no
// account tenancy): see tasks/progress/console-rev4-shared-sandbox-design-2026-11-21.md.
//  1. Operator's pool is 5 agents PER SEAT (1 seat = 5, 2 seats = 10).
//  2. At most ONE top-up pack per seat (and at most max_packs): a pool can at most double for Estate. The packs endpoint
//     refuses more packs than seats; a seat reduction (made in the Stripe portal, which this code cannot refuse) caps
//     the counted packs at the seats and is flagged packs_over_seats.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import handler from "../netlify/functions/billing.mts";
import { freshStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent } from "../src/lib/billing";
import { PRICE_BOOK, agentPool, maxPacksFor } from "../src/lib/pricebook";

const ctx = {} as any;
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov",
  STRIPE_PRICE_PACK: "price_pack", STRIPE_PRICE_PACK_ANNUAL: "price_pack_y",
};
const item = (id: string, price: string, quantity: number) => ({ id, price: { id: price }, quantity, current_period_end: 1_900_000_000 });

let user: User;
let errors: string[];
const realError = console.error;
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, STRIPE_ENV);
  user = await createUser("rev4@example.com", "sufficiently-long-pass");
  errors = [];
  console.error = (...a: any[]) => void errors.push(a.map(String).join(" "));
});
afterEach(() => {
  console.error = realError;
  for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
});

describe("change 1: Operator pool is 5 agents per seat", () => {
  it("config and pool", () => {
    expect(PRICE_BOOK.tiers.operator).toMatchObject({ agents_base: 0, agents_per_seat: 5 });
    expect(agentPool("operator", 1, 0)).toBe(5);
    expect(agentPool("operator", 2, 0)).toBe(10);
  });

  it("landing copy says per seat", () => {
    const html = readFileSync(join(__dirname, "..", "public/index.html"), "utf8");
    expect(html).toContain("1 to 2 seats &middot; 5 governed agents per seat");
    expect(html).not.toContain("up to 5 governed agents");
  });
});

describe("change 2: at most one pack per seat", () => {
  it("config and the cap", () => {
    expect(PRICE_BOOK.pack.max_per_seat).toBe(1);
    expect(maxPacksFor(3)).toBe(3);
    expect(maxPacksFor(80)).toBe(PRICE_BOOK.pack.max_packs);
    expect(maxPacksFor(0)).toBe(0);
  });

  it("the pool counts at most one pack per seat (Estate can at most double)", () => {
    expect(agentPool("sovereign", 3, 3)).toBe(120);
    expect(agentPool("sovereign", 3, 5)).toBe(120);
    expect(agentPool("operator", 2, 2)).toBe(50);
    expect(agentPool("operator", 1, 2)).toBe(25);
  });

  async function subscribedLive(seats: number, packs: number) {
    const sub = { id: "sub_1", status: "active", customer: "cus_1", items: { data: [item("si_seat", "price_sov", seats), ...(packs ? [item("si_pack", "price_pack", packs)] : [])] }, metadata: { user_id: user.id } };
    user.tier = "sovereign";
    user.billing = { customer_id: "cus_1", subscription_id: "sub_1", status: "active", price_id: "price_sov", tier: "sovereign", current_period_end: null, updated_at: "t" };
    await saveUser(user);
    const writes: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const method = String(init?.method ?? "GET").toUpperCase();
      if (method !== "GET") writes.push(method + " " + new URL(String(input)).pathname);
      return new Response(JSON.stringify(method === "GET" ? sub : { id: "si_x" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
    return { writes, restore: () => void (globalThis.fetch = realFetch) };
  }
  const post = async (b: unknown) => {
    const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
    return handler(new Request("http://portal.test/api/billing/packs", { method: "POST", headers: { cookie }, body: JSON.stringify(b) }), ctx);
  };

  it("the packs endpoint refuses more packs than seats (409 packs_over_seats, no write)", async () => {
    const s = await subscribedLive(3, 0);
    try {
      const r = await post({ packs: 4 });
      expect(r.status).toBe(409);
      const e = (await r.json()).error;
      expect(e.code).toBe("packs_over_seats");
      expect(e.max_packs).toBe(3);
      expect(s.writes).toEqual([]);
    } finally {
      s.restore();
    }
  });

  it("packs equal to seats are allowed", async () => {
    const s = await subscribedLive(3, 0);
    try {
      expect((await post({ packs: 3 })).status).toBe(200);
      expect(s.writes).toEqual(["POST /v1/subscription_items"]);
    } finally {
      s.restore();
    }
  });

  it("lowering packs is always allowed, even when packs exceed seats", async () => {
    const s = await subscribedLive(3, 5);
    try {
      expect((await post({ packs: 4 })).status).toBe(200);
    } finally {
      s.restore();
    }
  });

  it("webhook: seats lowered below packs caps the pool, flags packs_over_seats and alerts once", async () => {
    const sub = { id: "sub_9", status: "active", customer: "cus_9", items: { data: [item("si_seat", "price_sov", 3), item("si_pack", "price_pack", 5)] }, metadata: { user_id: user.id } };
    const ev = (id: string, created: number) => ({ id, livemode: true, type: "customer.subscription.updated", created, data: { object: sub } });
    await handleStripeEvent(ev("e1", 10), { cfg: stripeConfig()!, fly: null });
    const u = (await getUserById(user.id))!;
    expect(u.billing).toMatchObject({ seats: 3, packs: 5, agent_pool: 120, packs_over_seats: true });
    await handleStripeEvent(ev("e2", 20), { cfg: stripeConfig()!, fly: null });
    expect(errors.filter((l) => l.startsWith("ALERT packs_over_seats"))).toHaveLength(1);
  });

  it("webhook: packs within seats are not flagged", async () => {
    const sub = { id: "sub_8", status: "active", customer: "cus_8", items: { data: [item("si_seat", "price_sov", 4), item("si_pack", "price_pack", 4)] }, metadata: { user_id: user.id } };
    await handleStripeEvent({ id: "e3", livemode: true, type: "customer.subscription.updated", created: 10, data: { object: sub } }, { cfg: stripeConfig()!, fly: null });
    const u = (await getUserById(user.id))!;
    expect(u.billing).toMatchObject({ seats: 4, packs: 4, agent_pool: 160 });
    expect(u.billing!.packs_over_seats ?? false).toBe(false);
  });

  it("landing and dashboard copy say one pack per seat", () => {
    const html = readFileSync(join(__dirname, "..", "public/index.html"), "utf8");
    expect(html).toContain("Top-up packs: +20 agents for CA$12/mo, one per seat.");
    expect(readFileSync(join(__dirname, "..", "public/app.html"), "utf8")).toContain("one per seat");
  });
});
