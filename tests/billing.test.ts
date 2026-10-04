import { describe, it, expect, beforeEach, afterEach } from "vitest";
import handler from "../netlify/functions/billing.mts";
import { freshStore } from "./helpers";
import { createUser, getUserById, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { signPayload, stripeConfig } from "../src/lib/stripe";
import { STALE_CLAIM_MS, alreadyProcessed, claimEvent, handleStripeEvent, markProcessed } from "../src/lib/billing";
import { getEstate, queueEstate, saveEstate } from "../src/lib/estates";

const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sub(over: Partial<any> = {}, userId?: string) {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] },
    metadata: userId ? { user_id: userId } : {},
    ...over,
  };
}

class StopFly {
  calls: string[] = [];
  async stopMachine(app: string, id: string) { this.calls.push(`stop ${app} ${id}`); }
  async startMachine(app: string, id: string) { this.calls.push(`start ${app} ${id}`); }
}

async function cookieFor(user: User): Promise<string> {
  return sessionCookie(await issueSession(user.id)).split(";")[0];
}

describe("stripe webhook state transitions", () => {
  let user: User;

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, STRIPE_ENV);
    user = await createUser("pay@example.com", "sufficiently-long-pass");
  });

  afterEach(() => {
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
    delete process.env.FLY_API_TOKEN;
  });

  it("checkout.session.completed upgrades the user, mirrors billing, and queues an estate", async () => {
    const fetchImpl = async (url: string) =>
      url.endsWith("/v1/subscriptions/sub_1") ? jsonResponse(200, sub()) : jsonResponse(404, { error: { message: "no" } });
    const r = await handleStripeEvent(
      { id: "evt_1", type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_1", customer: "cus_1", client_reference_id: user.id } } },
      { cfg: stripeConfig()!, fly: null, fetchImpl },
    );
    expect(r.handled).toBe(true);
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("operator");
    expect(u.billing).toMatchObject({ customer_id: "cus_1", subscription_id: "sub_1", status: "active", price_id: "price_op", tier: "operator" });
    expect(u.billing!.current_period_end).toBe(new Date(1_800_000_000 * 1000).toISOString());
    const e = await getEstate(user.id);
    expect(e?.status).toBe("pending_manual"); // no Fly config in this test
    expect(e?.grantor).toBe("pay@example.com");
  });

  it("ignores non-subscription checkouts and sessions without a portal user", async () => {
    const r1 = await handleStripeEvent({ id: "e", type: "checkout.session.completed", data: { object: { mode: "payment" } } }, { cfg: stripeConfig()!, fly: null });
    expect(r1.handled).toBe(false);
    const r2 = await handleStripeEvent(
      { id: "e", type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_1", client_reference_id: "nobody" } } },
      { cfg: stripeConfig()!, fly: null },
    );
    expect(r2.handled).toBe(false);
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
  });

  it("an unknown price never grants a paid tier", async () => {
    const r = await handleStripeEvent(
      { id: "e", type: "customer.subscription.updated", data: { object: sub({ items: { data: [{ price: { id: "price_mystery" } }] } }, user.id) } },
      { cfg: stripeConfig()!, fly: null },
    );
    expect(r.handled).toBe(true);
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
  });

  it("subscription.deleted drops the tier to sandbox and suspends a ready estate (machine stopped, data kept)", async () => {
    user.tier = "operator";
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.machine_id = "m_1";
    e.url = `https://${e.app}.fly.dev`;
    await saveEstate(e);
    const fly = new StopFly();
    const r = await handleStripeEvent(
      { id: "e", type: "customer.subscription.deleted", data: { object: sub({ status: "canceled" }, user.id) } },
      { cfg: stripeConfig()!, fly: fly as any },
    );
    expect(r.handled).toBe(true);
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
    expect((await getEstate(user.id))!.status).toBe("suspended");
    expect(fly.calls).toEqual([`stop ${e.app} m_1`]);

    // reactivation resumes it
    await handleStripeEvent(
      { id: "e2", type: "customer.subscription.updated", data: { object: sub({ status: "active" }, user.id) } },
      { cfg: stripeConfig()!, fly: fly as any },
    );
    expect((await getUserById(user.id))!.tier).toBe("operator");
    expect((await getEstate(user.id))!.status).toBe("ready");
    expect(fly.calls[1]).toBe(`start ${e.app} m_1`);
  });

  it("past_due keeps the tier (Stripe's retry window); unpaid drops it", async () => {
    await handleStripeEvent({ id: "a", type: "customer.subscription.updated", data: { object: sub({ status: "past_due" }, user.id) } }, { cfg: stripeConfig()!, fly: null });
    expect((await getUserById(user.id))!.tier).toBe("operator");
    await handleStripeEvent({ id: "b", type: "customer.subscription.updated", data: { object: sub({ status: "unpaid" }, user.id) } }, { cfg: stripeConfig()!, fly: null });
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
  });

  it("finds the user by the customer pointer when the subscription carries no metadata", async () => {
    await handleStripeEvent({ id: "a", type: "customer.subscription.created", data: { object: sub({}, user.id) } }, { cfg: stripeConfig()!, fly: null });
    const r = await handleStripeEvent(
      { id: "b", type: "customer.subscription.updated", data: { object: sub({ items: { data: [{ price: { id: "price_sov" } }] } }) } },
      { cfg: stripeConfig()!, fly: null },
    );
    expect(r.handled).toBe(true);
    expect((await getUserById(user.id))!.tier).toBe("sovereign");
  });
});

describe("billing endpoints", () => {
  let user: User;

  beforeEach(async () => {
    freshStore();
    user = await createUser("pay@example.com", "sufficiently-long-pass");
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  });

  afterEach(() => {
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
    delete process.env.URL;
  });

  it("answers 501 billing_not_configured everywhere until Stripe is configured", async () => {
    const cookie = await cookieFor(user);
    const c = await handler(new Request("http://portal.test/api/billing/checkout", { method: "POST", headers: { cookie }, body: JSON.stringify({ tier: "operator" }) }), ctx);
    expect(c.status).toBe(501);
    expect((await c.json()).error.code).toBe("billing_not_configured");
    const w = await handler(new Request("http://portal.test/api/billing/webhook", { method: "POST", body: "{}" }), ctx);
    expect(w.status).toBe(501);
    const p = await handler(new Request("http://portal.test/api/billing/portal", { method: "POST", headers: { cookie } }), ctx);
    expect(p.status).toBe(501);
  });

  it("requires a session for checkout and portal, and POST everywhere", async () => {
    Object.assign(process.env, STRIPE_ENV);
    const c = await handler(new Request("http://portal.test/api/billing/checkout", { method: "POST", body: "{}" }), ctx);
    expect(c.status).toBe(401);
    const g = await handler(new Request("http://portal.test/api/billing/checkout"), ctx);
    expect(g.status).toBe(405);
  });

  it("webhook: rejects a bad signature, applies a good one once, and acknowledges the redelivery", async () => {
    Object.assign(process.env, STRIPE_ENV);
    const raw = JSON.stringify({ id: "evt_42", type: "customer.subscription.updated", data: { object: sub({}, user.id) } });
    const bad = await handler(new Request("http://portal.test/api/billing/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=00" }, body: raw }), ctx);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("bad_signature");
    expect((await getUserById(user.id))!.tier).toBe("sandbox");

    const sig = signPayload(raw, "whsec_test", Math.floor(Date.now() / 1000));
    const ok = await handler(new Request("http://portal.test/api/billing/webhook", { method: "POST", headers: { "stripe-signature": sig }, body: raw }), ctx);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ received: true, handled: true });
    expect((await getUserById(user.id))!.tier).toBe("operator");
    expect(await alreadyProcessed("evt_42")).toBe(true);

    const again = await handler(new Request("http://portal.test/api/billing/webhook", { method: "POST", headers: { "stripe-signature": sig }, body: raw }), ctx);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
  });

  it("webhook: the event id is CLAIMED before handling (create-only write); a failed handling releases it so Stripe's retry applies", async () => {
    Object.assign(process.env, STRIPE_ENV);
    const raw = JSON.stringify({ id: "evt_77", type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_1", customer: "cus_1", client_reference_id: user.id } } });
    const sig = signPayload(raw, "whsec_test", Math.floor(Date.now() / 1000));
    const post = () => handler(new Request("http://portal.test/api/billing/webhook", { method: "POST", headers: { "stripe-signature": sig }, body: raw }), ctx);
    const realFetch = globalThis.fetch;
    let stripeUp = false;
    globalThis.fetch = (async (url: any) =>
      stripeUp && String(url).endsWith("/v1/subscriptions/sub_1") ? jsonResponse(200, sub()) : jsonResponse(500, { error: { message: "stripe down" } })) as any;
    try {
      const failed = await post();
      expect(failed.status).toBe(500);
      expect(await alreadyProcessed("evt_77")).toBe(false); // the claim was released
      expect((await getUserById(user.id))!.tier).toBe("sandbox");

      stripeUp = true;
      const retry = await post();
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ received: true, handled: true });
      expect((await getUserById(user.id))!.tier).toBe("operator");
      expect(await alreadyProcessed("evt_77")).toBe(true);

      const dup = await post();
      expect(await dup.json()).toEqual({ received: true, duplicate: true });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("webhook claims: a fresh 'processing' claim blocks; a stale one (older than 10 min) is taken over; a 'done' record never is", async () => {
    const fresh = new Date();
    expect(await claimEvent("evt_a", "t", fresh)).toBe(true);
    expect(await claimEvent("evt_a", "t", new Date(fresh.getTime() + 60_000))).toBe(false);
    expect(await claimEvent("evt_a", "t", new Date(fresh.getTime() + STALE_CLAIM_MS + 1000))).toBe(true);
    await markProcessed("evt_a", "t", fresh);
    expect(await claimEvent("evt_a", "t", new Date(fresh.getTime() + 24 * 3600_000))).toBe(false);
    expect(await alreadyProcessed("evt_a")).toBe(true);
  });

  it("checkout: validates the tier, refuses a second subscription, and returns Stripe's URL", async () => {
    Object.assign(process.env, STRIPE_ENV);
    process.env.URL = "https://force-field-console.netlify.app";
    const cookie = await cookieFor(user);
    const bad = await handler(new Request("http://portal.test/api/billing/checkout", { method: "POST", headers: { cookie }, body: JSON.stringify({ tier: "gold" }) }), ctx);
    expect(bad.status).toBe(400);

    let seen = "";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      seen = String(init?.body ?? "");
      return jsonResponse(200, { id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
    }) as any;
    try {
      const ok = await handler(new Request("http://portal.test/api/billing/checkout", { method: "POST", headers: { cookie }, body: JSON.stringify({ tier: "operator" }) }), ctx);
      expect(ok.status).toBe(200);
      expect((await ok.json()).url).toBe("https://checkout.stripe.com/c/cs_1");
      const p = new URLSearchParams(seen);
      expect(p.get("success_url")).toBe("https://force-field-console.netlify.app/app.html?checkout=success");
      expect(p.get("client_reference_id")).toBe(user.id);
    } finally {
      globalThis.fetch = realFetch;
    }

    user.billing = { customer_id: "cus_1", subscription_id: "sub_1", status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
    const { saveUser } = await import("../src/lib/users");
    await saveUser(user);
    const dup = await handler(new Request("http://portal.test/api/billing/checkout", { method: "POST", headers: { cookie }, body: JSON.stringify({ tier: "sovereign" }) }), ctx);
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("already_subscribed");
  });

  it("portal: 404 without a billing account", async () => {
    Object.assign(process.env, STRIPE_ENV);
    const cookie = await cookieFor(user);
    const r = await handler(new Request("http://portal.test/api/billing/portal", { method: "POST", headers: { cookie } }), ctx);
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("no_billing_account");
  });
});
