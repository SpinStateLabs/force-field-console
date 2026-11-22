// Owner decision (Don, 2026-11-22T02:39Z): a trial gets its dedicated estate at FIRST PAYMENT, not at trial start; the
// trial runs on the open-source install. Safety condition: a trialing account with no estate record must NOT be routed
// to the shared sandbox (it has no account-level tenant isolation); it is refused with the trial status, the days left
// and the open-source install link, and no estate URL, key or token.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import gateway from "../netlify/functions/gateway.mts";
import me from "../netlify/functions/me.mts";
import { freshStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { issueKey } from "../src/lib/keys";
import { issueSession, sessionCookie } from "../src/lib/session";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent } from "../src/lib/billing";
import { getEstate } from "../src/lib/estates";
import { PRICE_BOOK } from "../src/lib/pricebook";

const ctx = {} as any;
const ENV = {
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov",
  FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789",
  ESTATE_URL: "https://sandbox.example", ESTATE_SHARED_SECRET: "sandbox-secret",
};
const INSTALL = "https://github.com/SpinStateLabs/Force-Field#install-the-marketplace";
const DAY = 86_400;

let user: User;
let fetches: string[];
let seq = 0;
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, ENV);
  user = await createUser("trial@example.com", "sufficiently-long-pass");
  fetches = [];
  vi.stubGlobal("fetch", async (input: any) => {
    fetches.push(String(typeof input === "string" ? input : input.url));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

/** The subscription as Stripe knows it now (the invoice.paid handler reads it live). */
let liveSub: any = null;
function subEvent(status: string, opts: { livemode?: boolean; periodEnd?: number; type?: string } = {}) {
  seq += 1;
  const object = {
    id: "sub_t", status, customer: "cus_t", metadata: { user_id: user.id },
    items: { data: [{ price: { id: "price_sov" }, quantity: 3, current_period_end: opts.periodEnd ?? Math.floor(Date.now() / 1000) + 12 * DAY }] },
  };
  liveSub = object;
  return {
    id: "evt_t" + seq,
    livemode: opts.livemode ?? true,
    type: opts.type ?? "customer.subscription.updated",
    created: 1_790_000_000 + seq,
    data: { object },
  };
}
/** F2: Stripe's invoice.paid for sub_t (amount in cents). */
function invoicePaid(amount: number, opts: { livemode?: boolean; customer?: any; price?: string | null; subscription?: string } = {}) {
  seq += 1;
  const price = opts.price === undefined ? "price_sov" : opts.price;
  return {
    id: "evt_i" + seq,
    livemode: opts.livemode ?? true,
    type: "invoice.paid",
    created: 1_790_000_000 + seq,
    data: {
      object: {
        id: "in_" + seq, object: "invoice", customer: opts.customer ?? "cus_t", subscription: opts.subscription ?? "sub_t", amount_paid: amount,
        lines: { data: price ? [{ price: { id: price } }] : [] },
      },
    },
  };
}
const stripeLive = async (url: string) => {
  const u = new URL(url);
  if (u.pathname === "/v1/subscriptions/sub_t" && liveSub) return new Response(JSON.stringify(liveSub), { status: 200, headers: { "content-type": "application/json" } });
  if (u.pathname === "/v1/subscriptions") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify({ error: { message: "no such object" } }), { status: 404, headers: { "content-type": "application/json" } });
};
const apply = (ev: any) => handleStripeEvent(ev, { cfg: stripeConfig()!, fly: null, fetchImpl: stripeLive as any });
/** A paying subscription: active, and the first invoice paid with an amount. */
async function activePaid(opts: { livemode?: boolean } = {}) {
  await apply(subEvent("active", opts));
  await apply(invoicePaid(7200, opts));
}

describe("webhook: the estate starts at first payment", () => {
  it("a trialing grant sets the tier but queues NO estate (live mode, Fly configured)", async () => {
    await apply(subEvent("trialing"));
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("sovereign");
    expect(u.billing?.status).toBe("trialing");
    expect(await getEstate(user.id)).toBeNull();
  });

  it("a trialing grant in test mode queues no estate either (not even a held one)", async () => {
    await apply(subEvent("trialing", { livemode: false }));
    expect(await getEstate(user.id)).toBeNull();
  });

  it("trialing -> active + a paid invoice queues the dedicated estate once; replays keep the same record", async () => {
    await apply(subEvent("trialing"));
    await activePaid();
    const first = (await getEstate(user.id))!;
    expect(first.status).toBe("provisioning");
    await apply(subEvent("active"));
    await apply(subEvent("active"));
    const again = (await getEstate(user.id))!;
    expect(again.created_at).toBe(first.created_at);
    expect(again.app).toBe(first.app);
  });

  it("a trial that ends without payment has nothing to tear down", async () => {
    await apply(subEvent("trialing"));
    await apply(subEvent("canceled", { type: "customer.subscription.deleted" }));
    expect((await getUserById(user.id))!.tier).toBe("sandbox");
    expect(await getEstate(user.id)).toBeNull();
  });
});

// Review #29 B2 (don.reviewer, HIGH): the estate is created on "active" ONLY. A trial whose first payment FAILS goes
// trialing -> past_due (granting) and must NOT get an estate; an account that already paid keeps its estate on past_due.
describe("review #29 B2: a NEW estate only on active", () => {
  for (const status of ["past_due", "incomplete", "unpaid"]) {
    it(`trialing -> ${status}: no estate (no payment was ever made)`, async () => {
      await apply(subEvent("trialing"));
      await apply(subEvent(status));
      expect(await getEstate(user.id)).toBeNull();
    });
  }

  it("past_due without ever being active, in test mode: no estate either (not even a held one)", async () => {
    await apply(subEvent("trialing", { livemode: false }));
    await apply(subEvent("past_due", { livemode: false }));
    expect(await getEstate(user.id)).toBeNull();
  });

  it("trialing -> past_due: the gateway refuses (estate_not_ready) and never routes to the shared sandbox", async () => {
    await apply(subEvent("trialing"));
    await apply(subEvent("past_due"));
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("sovereign"); // past_due still grants the tier (Stripe's retry window)
    const key = (await issueKey(u, "k")).plaintext;
    const r = await gateway(new Request("http://portal.test/api/v1/registry/agents", { headers: { "x-api-key": key } }), ctx);
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.error.code).toBe("estate_not_ready");
    expect(body.error.reason).toBe("not_queued");
    expect(fetches).toEqual([]);
  });

  it("trialing -> active queues exactly once: a later replay keeps the first record's created_at", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-12-01T00:00:00Z"));
      await apply(subEvent("trialing"));
      await activePaid();
      const created = (await getEstate(user.id))!.created_at;
      vi.setSystemTime(new Date("2026-12-01T00:05:00Z")); // a re-created record would carry this later time
      await apply(subEvent("active"));
      await apply(invoicePaid(7200)); // a later paid invoice
      expect((await getEstate(user.id))!.created_at).toBe(created);
    } finally {
      vi.useRealTimers();
    }
  });

  it("active -> past_due -> active keeps ONE estate (no second record)", async () => {
    await activePaid();
    const first = (await getEstate(user.id))!;
    await apply(subEvent("past_due"));
    expect((await getEstate(user.id))!.created_at).toBe(first.created_at);
    await apply(subEvent("active"));
    const again = (await getEstate(user.id))!;
    expect(again.created_at).toBe(first.created_at);
    expect(again.app).toBe(first.app);
  });

  it("an account that was active and goes past_due keeps its existing estate (no teardown here)", async () => {
    await activePaid();
    const e = (await getEstate(user.id))!;
    await apply(subEvent("past_due"));
    const after = (await getEstate(user.id))!;
    expect(after.status).toBe(e.status);
    expect(after.suspend_pending ?? null).toBeNull();
    expect((await getUserById(user.id))!.tier).toBe("sovereign");
  });
});

describe("gateway: a paid account with no estate is never routed to the shared sandbox", () => {
  const call = async () => {
    const key = (await issueKey((await getUserById(user.id))!, "k")).plaintext;
    return gateway(new Request("http://portal.test/api/v1/registry/agents", { headers: { "x-api-key": key } }), ctx);
  };

  it("trialing: 403 trial_no_estate with the days left and the open-source install link; nothing proxied", async () => {
    await apply(subEvent("trialing", { periodEnd: Math.floor(Date.now() / 1000) + 12 * DAY + 60 }));
    const r = await call();
    expect(r.status).toBe(403);
    const text = await r.text();
    const body = JSON.parse(text);
    expect(body.error.code).toBe("trial_no_estate");
    expect(body.error.install_url).toBe(INSTALL);
    expect(body.error.days_left).toBe(12);
    expect(fetches).toEqual([]);
    expect(text).not.toMatch(/sandbox\.example|sandbox-secret|fly\.dev|x-field-auth/);
  });

  // Controller safety condition (2026-11-22): ONE rule. Only an account with NO paid tier reaches the shared sandbox; a
  // paid account gets its own READY estate or a refusal, in every not-ready state. One test per state.
  async function paidActive() {
    user.tier = "operator";
    user.billing = { customer_id: "c", subscription_id: "s", status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
    await saveUser(user);
  }
  async function expectRefusedNoLeak(status: number, code: string, reason?: string) {
    const r = await call();
    expect(r.status).toBe(status);
    const text = await r.text();
    const body = JSON.parse(text);
    expect(body.error.code).toBe(code);
    if (reason) expect(body.error.reason).toBe(reason);
    expect(fetches).toEqual([]); // nothing reached ESTATE_URL (or any estate)
    expect(text).not.toMatch(/sandbox\.example|sandbox-secret|fly\.dev|x-field-auth|master-0123456789/);
  }

  it("paid, no estate record yet (webhook lag): 503 estate_not_ready (not_queued)", async () => {
    await paidActive();
    await expectRefusedNoLeak(503, "estate_not_ready", "not_queued");
  });

  it("paid, estate pending_manual (provisioning not configured): 503 estate_not_ready (pending_manual)", async () => {
    await paidActive();
    const { queueEstate } = await import("../src/lib/estates");
    delete process.env.FLY_API_TOKEN;
    const e = await queueEstate((await getUserById(user.id))!);
    expect(e.status).toBe("pending_manual");
    process.env.FLY_API_TOKEN = "fo1_test";
    await expectRefusedNoLeak(503, "estate_not_ready", "pending_manual");
  });

  it("paid, estate held by a Stripe test-mode grant: 503 estate_not_ready (test_hold)", async () => {
    await activePaid({ livemode: false });
    expect((await getEstate(user.id))!.test_hold).toBe(true);
    await expectRefusedNoLeak(503, "estate_not_ready", "test_hold");
  });

  it("paid, estate provisioning: still refused (503 estate_provisioning, unchanged)", async () => {
    await activePaid();
    expect((await getEstate(user.id))!.status).toBe("provisioning");
    await expectRefusedNoLeak(503, "estate_provisioning");
  });

  it("F2: active but nothing paid yet (zero-amount invoice): 503 estate_not_ready (awaiting_first_payment)", async () => {
    await apply(subEvent("active"));
    await apply(invoicePaid(0));
    expect(await getEstate(user.id)).toBeNull();
    await expectRefusedNoLeak(503, "estate_not_ready", "awaiting_first_payment");
  });

  it("a sandbox account is still routed to the shared sandbox (unchanged)", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(fetches).toEqual(["https://sandbox.example/registry/agents"]);
  });
});

describe("/api/me shows the trial", () => {
  it("trialing: trial {ends_at, days_left, install_url}; no estate", async () => {
    const end = Math.floor(Date.now() / 1000) + 5 * DAY + 60;
    await apply(subEvent("trialing", { periodEnd: end }));
    const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
    const body = await (await me(new Request("http://portal.test/api/me", { headers: { cookie } }), ctx)).json();
    expect(body.estate).toBeNull();
    expect(body.trial).toEqual({ ends_at: new Date(end * 1000).toISOString(), days_left: 5, install_url: INSTALL });
  });

  it("not trialing: trial is null", async () => {
    const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
    const body = await (await me(new Request("http://portal.test/api/me", { headers: { cookie } }), ctx)).json();
    expect(body.trial).toBeNull();
  });
});

describe("copy", () => {
  it("the price book's install link is the one the trial shows", () => {
    expect(PRICE_BOOK.free.install_url).toBe(INSTALL);
  });

  it("landing and dashboard say the hosted estate starts with the first payment", () => {
    const html = readFileSync(join(__dirname, "..", "public/index.html"), "utf8");
    expect(html).toContain("Your hosted dedicated estate starts with the first payment; the trial runs on the open-source install.");
    const js = readFileSync(join(__dirname, "..", "public/app.js"), "utf8");
    expect(js).toContain("me.trial");
    expect(js).toContain("Your hosted dedicated estate starts with the first payment.");
  });
});

// Review #29 F2 (roley.reviewer; controller ruling): the trigger is a PAID INVOICE (amount_paid > 0), not the status.
describe("review #29 F2: the estate starts at the first PAID invoice", () => {
  it("trialing -> active with a zero-amount invoice (100% coupon): no estate", async () => {
    await apply(subEvent("trialing"));
    await apply(subEvent("active"));
    await apply(invoicePaid(0));
    expect(await getEstate(user.id)).toBeNull();
    expect((await getUserById(user.id))!.billing?.first_payment_pending).toBe(true);
  });

  it("first invoice paid with an amount: exactly one estate; first_payment_pending cleared", async () => {
    await apply(subEvent("trialing"));
    await apply(subEvent("active"));
    expect(await getEstate(user.id)).toBeNull();
    await apply(invoicePaid(7200));
    expect((await getEstate(user.id))!.status).toBe("provisioning");
    expect((await getUserById(user.id))!.billing?.first_payment_pending ?? false).toBe(false);
  });

  it("order does not matter: invoice.paid first, then the active subscription event, gives the estate", async () => {
    liveSub = { id: "sub_t", status: "active", customer: "cus_t", metadata: { user_id: user.id }, items: { data: [{ price: { id: "price_sov" }, quantity: 3 }] } };
    await apply(invoicePaid(7200));
    expect(await getEstate(user.id)).toBeNull(); // the account is not granted yet
    await apply(subEvent("active"));
    expect((await getEstate(user.id))!.status).toBe("provisioning");
  });

  it("a replayed invoice.paid and a later paid invoice never create a second estate", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-12-02T00:00:00Z"));
      await apply(subEvent("active"));
      const first = invoicePaid(7200);
      await apply(first);
      const created = (await getEstate(user.id))!.created_at;
      vi.setSystemTime(new Date("2026-12-02T00:10:00Z"));
      await apply(first); // replay of the same event
      await apply(invoicePaid(7200)); // next month's invoice
      expect((await getEstate(user.id))!.created_at).toBe(created);
    } finally {
      vi.useRealTimers();
    }
  });

  it("active alone (no invoice.paid at all): no estate", async () => {
    await apply(subEvent("active"));
    expect(await getEstate(user.id)).toBeNull();
  });

  it("invoice.paid with amount 0: acknowledged (not an error), no paid record, no estate", async () => {
    await apply(subEvent("active"));
    const r = await apply(invoicePaid(0));
    expect(r.handled).toBe(false);
    const { isPaidSubscription } = await import("../src/lib/billing");
    expect(await isPaidSubscription("sub_t")).toBe(false);
    expect(await getEstate(user.id)).toBeNull();
  });

  it("A1: a paid invoice whose portal user cannot be resolved yet is NOT dropped: paid record + unmatched ALERT, no estate", async () => {
    liveSub = { id: "sub_t", status: "active", customer: "cus_stranger", metadata: {}, items: { data: [{ price: { id: "price_sov" }, quantity: 3 }] } };
    const ev = invoicePaid(7200, { customer: "cus_stranger" });
    const r = await apply(ev);
    expect(r.handled).toBe(false);
    const { isPaidSubscription } = await import("../src/lib/billing");
    expect(await isPaidSubscription("sub_t")).toBe(true); // the payment is kept (per subscription)
    const { portalStore } = await import("../src/lib/store");
    expect(await (await portalStore()).get("ops/unmatched_events/" + ev.id, { type: "json" })).toBeTruthy();
    expect(await getEstate(user.id)).toBeNull();
  });

  it("A1: invoice.paid first for a subscription without metadata, then the user resolves: the estate is queued", async () => {
    // sub_t is paid before the portal knows the customer; a later subscription event (with the user) finds the record
    liveSub = { id: "sub_t", status: "active", customer: "cus_t", metadata: {}, items: { data: [{ price: { id: "price_sov" }, quantity: 3 }] } };
    await apply(invoicePaid(7200));
    expect(await getEstate(user.id)).toBeNull();
    await apply(subEvent("active"));
    expect((await getEstate(user.id))!.status).toBe("provisioning");
  });

  it("the webhook endpoint answers 200 to both (Stripe must not retry them)", async () => {
    const { signPayload } = await import("../src/lib/stripe");
    const billing = (await import("../netlify/functions/billing.mts")).default;
    for (const ev of [invoicePaid(0), invoicePaid(7200, { customer: "cus_stranger" })]) {
      liveSub = { id: "sub_t", status: "active", customer: ev.data.object.customer, metadata: {}, items: { data: [{ price: { id: "price_sov" }, quantity: 3 }] } };
      vi.stubGlobal("fetch", stripeLive as any);
      const raw = JSON.stringify(ev);
      const sig = signPayload(raw, "whsec_test", Math.floor(Date.now() / 1000));
      const res = await billing(new Request("http://portal.test/api/billing/webhook", { method: "POST", headers: { "stripe-signature": sig }, body: raw }), ctx);
      expect(res.status).toBe(200);
    }
    expect(await getEstate(user.id)).toBeNull();
  });
});

// Review #29 r3 (roley.reviewer, controller rulings Q1, Q3, Q4, X2) and the cheap recommended mutant killers.
describe("review #29 r3: paid means THIS subscription's invoice, on a configured price", () => {
  const notFound = async () => new Response(JSON.stringify({ error: { message: "No such subscription" } }), { status: 404, headers: { "content-type": "application/json" } });

  it("Q1: an invoice with an amount but no line on a configured price (another price or currency) creates nothing; 200", async () => {
    await apply(subEvent("active"));
    for (const price of ["price_other_usd", null]) {
      const r = await apply(invoicePaid(1, { price }));
      expect(r.handled).toBe(false);
    }
    const { isPaidSubscription } = await import("../src/lib/billing");
    expect(await isPaidSubscription("sub_t")).toBe(false);
    expect(await getEstate(user.id)).toBeNull();
  });

  it("Q3 / M14: a payment on an OLD subscription does not unlock a NEW one that goes active on a zero invoice", async () => {
    const { portalStore } = await import("../src/lib/store");
    await (await portalStore()).setJSON("paid_subscriptions/sub_old", { customer: "cus_t", first_paid_invoice: "in_old", at: "2026-10-01T00:00:00Z" });
    await apply(subEvent("active")); // sub_t, a new subscription
    await apply(invoicePaid(0));
    expect(await getEstate(user.id)).toBeNull();
  });

  it("Q4: a paid invoice for a subscription Stripe answers 404 for: unmatched + ALERT, 200, no record", async () => {
    const ev = invoicePaid(7200, { subscription: "sub_gone" });
    const r = await handleStripeEvent(ev, { cfg: stripeConfig()!, fly: null, fetchImpl: notFound as any });
    expect(r.handled).toBe(false);
    const { isPaidSubscription } = await import("../src/lib/billing");
    expect(await isPaidSubscription("sub_gone")).toBe(false);
    const { portalStore } = await import("../src/lib/store");
    expect(await (await portalStore()).get("ops/unmatched_events/" + ev.id, { type: "json" })).toBeTruthy();
  });

  it("X2: an ex-customer's SUSPENDED estate is not resumed on trialing -> past_due; it is on the new subscription's paid invoice", async () => {
    const { queueEstate, saveEstate } = await import("../src/lib/estates");
    const e = await queueEstate((await getUserById(user.id))!);
    Object.assign(e, { status: "suspended", machine_id: null, step: "done", suspended_from: "ready", suspended_at: new Date().toISOString() });
    await saveEstate(e);
    await apply(subEvent("trialing"));
    await apply(subEvent("past_due"));
    expect((await getEstate(user.id))!.status).toBe("suspended");
    await apply(subEvent("active"));
    expect((await getEstate(user.id))!.status).toBe("suspended"); // active alone is not a payment
    await apply(invoicePaid(7200));
    expect((await getEstate(user.id))!.status).not.toBe("suspended");
  });

  it("M2: paid but NOT active (past_due) creates no new estate", async () => {
    const { portalStore } = await import("../src/lib/store");
    await (await portalStore()).setJSON("paid_subscriptions/sub_t", { customer: "cus_t", first_paid_invoice: "in_x", at: "2026-11-01T00:00:00Z" });
    await apply(subEvent("past_due"));
    expect(await getEstate(user.id)).toBeNull();
  });

  it("M6: an invoice naming another customer than its subscription creates nothing", async () => {
    await apply(subEvent("active"));
    await apply(invoicePaid(7200, { customer: "cus_other" }));
    const { isPaidSubscription } = await import("../src/lib/billing");
    expect(await isPaidSubscription("sub_t")).toBe(false);
    expect(await getEstate(user.id)).toBeNull();
  });

  it("M8: the paid record is create-only (it keeps the FIRST paid invoice)", async () => {
    await apply(subEvent("active"));
    const first = invoicePaid(7200);
    await apply(first);
    await apply(invoicePaid(7200));
    const { portalStore } = await import("../src/lib/store");
    const rec: any = await (await portalStore()).get("paid_subscriptions/sub_t", { type: "json" });
    expect(rec.first_paid_invoice).toBe(first.data.object.id);
  });

  it("M16: an expanded customer object ({id}) is unwrapped", async () => {
    await apply(subEvent("active"));
    await apply(invoicePaid(7200, { customer: { id: "cus_t", object: "customer" } }));
    expect((await getEstate(user.id))!.status).toBe("provisioning");
  });

  it("M17: the customer match is exact (no case or space folding)", async () => {
    await apply(subEvent("active"));
    for (const customer of ["CUS_T", " cus_t", "cus_t "]) await apply(invoicePaid(7200, { customer }));
    expect(await getEstate(user.id)).toBeNull();
  });
});
