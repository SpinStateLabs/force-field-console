// Price book rev 2 (controller 2026-11-21 21:08Z from Don's words of 21:01Z): per seat, CAD, 30-day trial on a first
// subscription, annual 10% off, Estate minimum 3 seats, Operator 1-2 seats, Enterprise contact-sales, +20-agent top-up
// packs as a second subscription item, free tier = the open-source install instructions. Every number lives in ONE
// config object (src/lib/pricebook.ts); the copy tests below fail when a page drifts from it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import handler from "../netlify/functions/billing.mts";
import { freshStore } from "./helpers";
import { createUser, getUserById, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { createCheckoutSession, sharedPriceIds, stripeConfig, subscriptionSeats, tierForPrice } from "../src/lib/stripe";
import { checkoutIdempotencyKey, handleStripeEvent } from "../src/lib/billing";
import { PRICE_BOOK, agentPool, annualSeatMonth, annualSeatYear, seatBounds } from "../src/lib/pricebook";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const MORE_ENV = { STRIPE_PRICE_OPERATOR_ANNUAL: "price_op_y", STRIPE_PRICE_SOVEREIGN_ANNUAL: "price_sov_y", STRIPE_PRICE_PACK: "price_pack", STRIPE_PRICE_PACK_ANNUAL: "price_pack_y" };
const KEYS = [...Object.keys(STRIPE_ENV), ...Object.keys(MORE_ENV), "STRIPE_PRICE_OPERATOR_ACCEPTED", "STRIPE_PRICE_SOVEREIGN_ACCEPTED"];
const ok = () => new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  freshStore();
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("price book (one config object)", () => {
  it("rev 2 values", () => {
    expect(PRICE_BOOK.currency).toBe("CAD");
    expect(PRICE_BOOK.trial_days).toBe(30);
    expect(PRICE_BOOK.annual_discount).toBe(0.1);
    expect(PRICE_BOOK.tiers.operator).toMatchObject({ seat_month: 24, min_seats: 1, max_seats: 2 });
    expect(PRICE_BOOK.tiers.sovereign).toMatchObject({ seat_month: 24, min_seats: 3, max_seats: null });
    expect(PRICE_BOOK.enterprise).toMatchObject({ seat_month: 48, min_seats: 25 });
    expect(PRICE_BOOK.pack).toMatchObject({ agents: 20, month: 12 });
  });

  it("annual is 10% off: 21.60 per seat per month, 259.20 per seat per year", () => {
    expect(annualSeatMonth(24)).toBe(21.6);
    expect(annualSeatYear(24)).toBe(259.2);
    expect(annualSeatMonth(48)).toBe(43.2);
    expect(annualSeatYear(48)).toBe(518.4);
    expect(annualSeatYear(12)).toBe(129.6);
  });

  it("seat bounds and the agent pool", () => {
    expect(seatBounds("operator")).toEqual({ min: 1, max: 2 });
    expect(seatBounds("sovereign")).toEqual({ min: 3, max: null });
    expect(agentPool("operator", 2, 0)).toBe(5);
    expect(agentPool("operator", 1, 1)).toBe(25);
    expect(agentPool("sovereign", 3, 0)).toBe(60);
    expect(agentPool("sovereign", 4, 2)).toBe(120);
  });
});

describe("configuration", () => {
  it("annual and pack prices are read; pack prices never map to a tier", () => {
    Object.assign(process.env, STRIPE_ENV, MORE_ENV);
    const cfg = stripeConfig()!;
    expect(cfg.annual).toEqual({ operator: "price_op_y", sovereign: "price_sov_y" });
    expect(cfg.pack).toEqual({ month: "price_pack", year: "price_pack_y" });
    expect(tierForPrice(cfg, "price_op_y")).toBe("operator");
    expect(tierForPrice(cfg, "price_sov_y")).toBe("sovereign");
    expect(tierForPrice(cfg, "price_pack")).toBeNull();
    expect(tierForPrice(cfg, "price_pack_y")).toBeNull();
  });

  it("a pack price that is also a tier price is a shared (refused) id", () => {
    Object.assign(process.env, STRIPE_ENV, MORE_ENV, { STRIPE_PRICE_PACK: "price_op" });
    const cfg = stripeConfig()!;
    expect(sharedPriceIds(cfg)).toContain("price_op");
    expect(tierForPrice(cfg, "price_op")).toBeNull();
  });
});

describe("createCheckoutSession", () => {
  async function body(args: Record<string, unknown>) {
    Object.assign(process.env, STRIPE_ENV, MORE_ENV);
    let b = "";
    await createCheckoutSession(stripeConfig()!, { user_id: "u1", email: "a@b.co", tier: "sovereign", success_url: "s", cancel_url: "c", ...args } as any, async (_u: string, init?: any) => {
      b = String(init.body);
      return ok();
    });
    return new URLSearchParams(b);
  }

  it("sends the seat count as the quantity of the per-seat price", async () => {
    const p = await body({ seats: 4 });
    expect(p.get("line_items[0][price]")).toBe("price_sov");
    expect(p.get("line_items[0][quantity]")).toBe("4");
  });

  it("year sells the per-seat annual price", async () => {
    expect((await body({ seats: 3, interval: "year" })).get("line_items[0][price]")).toBe("price_sov_y");
  });

  it("a 30-day trial sends no card up front and cancels without a payment method", async () => {
    const p = await body({ seats: 3, trial_days: 30 });
    expect(p.get("subscription_data[trial_period_days]")).toBe("30");
    expect(p.get("payment_method_collection")).toBe("if_required");
    expect(p.get("subscription_data[trial_settings][end_behavior][missing_payment_method]")).toBe("cancel");
  });
});

describe("checkout endpoint", () => {
  let user: User;
  const realFetch = globalThis.fetch;
  let seen: { body: string; key: string | null }[] = [];
  beforeEach(async () => {
    Object.assign(process.env, STRIPE_ENV, MORE_ENV);
    user = await createUser("seats@example.com", "sufficiently-long-pass");
    seen = [];
    globalThis.fetch = (async (_u: any, init?: any) => {
      seen.push({ body: String(init?.body ?? ""), key: init?.headers?.["idempotency-key"] ?? null });
      return ok();
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const post = async (b: unknown) => {
    const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
    return handler(new Request("http://portal.test/api/billing/checkout", { method: "POST", headers: { cookie }, body: JSON.stringify(b) }), ctx);
  };
  const sent = () => new URLSearchParams(seen[0].body);

  it("Estate below the 3-seat minimum is refused with 400 bad_seats; no session opened", async () => {
    for (const seats of [0, 1, 2, -3, 2.5, "3", null]) {
      const r = await post({ tier: "sovereign", seats });
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe("bad_seats");
    }
    expect(seen).toEqual([]);
  });

  it("Operator above 2 seats is refused", async () => {
    const r = await post({ tier: "operator", seats: 3 });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("bad_seats");
  });

  it("no seats given: the tier's minimum is bought", async () => {
    expect((await post({ tier: "sovereign" })).status).toBe(200);
    expect(sent().get("line_items[0][quantity]")).toBe("3");
  });

  it("a first subscription gets the 30-day trial", async () => {
    expect((await post({ tier: "sovereign", seats: 5 })).status).toBe(200);
    expect(sent().get("line_items[0][quantity]")).toBe("5");
    expect(sent().get("subscription_data[trial_period_days]")).toBe("30");
  });

  it("interval year sells the annual price; an unknown interval is 400 bad_interval", async () => {
    expect((await post({ tier: "operator", seats: 2, interval: "year" })).status).toBe(200);
    expect(sent().get("line_items[0][price]")).toBe("price_op_y");
    const r = await post({ tier: "operator", interval: "week" });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe("bad_interval");
  });

  it("year without an annual price configured is 501 annual_not_configured", async () => {
    delete process.env.STRIPE_PRICE_SOVEREIGN_ANNUAL;
    const r = await post({ tier: "sovereign", interval: "year" });
    expect(r.status).toBe(501);
    expect((await r.json()).error.code).toBe("annual_not_configured");
  });

  it("the idempotency key covers seats and interval (a retry never replays another quantity or price)", async () => {
    const now = new Date();
    const k = (s: number, i: "month" | "year") => checkoutIdempotencyKey(user.id, "sovereign", null, now, i, s);
    expect(k(3, "month")).not.toBe(k(4, "month"));
    expect(k(3, "month")).not.toBe(k(3, "year"));
    expect((await post({ tier: "sovereign", seats: 4 })).status).toBe(200);
    expect(seen[0].key).toBe(checkoutIdempotencyKey(user.id, "sovereign", null, new Date(), "month", 4));
  });
});

describe("webhook records seats, packs and the agent pool", () => {
  const item = (price: string, quantity: number) => ({ price: { id: price }, quantity, current_period_end: 1_900_000_000 });
  async function apply(items: any[], email: string) {
    Object.assign(process.env, STRIPE_ENV, MORE_ENV);
    const user = await createUser(email, "sufficiently-long-pass");
    const sub = { id: "sub_s", status: "active", customer: "cus_s", items: { data: items }, metadata: { user_id: user.id } };
    await handleStripeEvent({ id: "evt_" + email, livemode: true, type: "customer.subscription.created", created: 10, data: { object: sub } }, { cfg: stripeConfig()!, fly: null });
    return (await getUserById(user.id))!;
  }

  it("Estate with 4 seats and 2 packs: tier sovereign, seats 4, packs 2, pool 120", async () => {
    const u = await apply([item("price_pack", 2), item("price_sov", 4)], "w1@example.com");
    expect(u.tier).toBe("sovereign");
    expect(u.billing).toMatchObject({ seats: 4, packs: 2, agent_pool: 120 });
    expect(u.billing!.seats_below_minimum ?? false).toBe(false);
  });

  it("annual Estate at 3 seats with an annual pack", async () => {
    const u = await apply([item("price_sov_y", 3), item("price_pack_y", 1)], "w2@example.com");
    expect(u.billing).toMatchObject({ seats: 3, packs: 1, agent_pool: 80 });
  });

  it("below the minimum (e.g. lowered in the portal) keeps the tier but is flagged", async () => {
    const u = await apply([item("price_sov", 2)], "w3@example.com");
    expect(u.tier).toBe("sovereign");
    expect(u.billing).toMatchObject({ seats: 2, seats_below_minimum: true });
  });

  it("subscriptionSeats reads the tier item's quantity (absent quantity = 1)", () => {
    Object.assign(process.env, STRIPE_ENV, MORE_ENV);
    const cfg = stripeConfig()!;
    expect(subscriptionSeats({ id: "s", status: "active", customer: "c", items: { data: [item("price_pack", 5), item("price_op", 2)] } } as any, cfg)).toEqual({ seats: 2, packs: 5 });
    expect(subscriptionSeats({ id: "s", status: "active", customer: "c", items: { data: [{ price: { id: "price_op" } }] } } as any, cfg)).toEqual({ seats: 1, packs: 0 });
  });
});

describe("copy matches the price book", () => {
  it("landing: free column links to the open-source install; per-seat prices, minimums, trial and annual", () => {
    const html = read("public/index.html");
    expect(html).toContain(`href="${PRICE_BOOK.free.install_url}"`);
    expect(html).not.toContain("Start on Sandbox");
    expect(html).toMatch(/<h3 class="tier-name">Operator<\/h3>\s*<p class="tier-price">CA\$24<span class="per">\/seat\/mo<\/span><\/p>/);
    expect(html).toMatch(/<h3 class="tier-name">Estate<\/h3>\s*<p class="tier-price">CA\$24<span class="per">\/seat\/mo<\/span><\/p>/);
    expect(html).toMatch(/<h3 class="tier-name">Enterprise<\/h3>\s*<p class="tier-price">CA\$48<span class="per">\/seat\/mo<\/span><\/p>/);
    expect(html).toContain("minimum 3 seats (CA$72/mo)");
    expect(html).toContain("minimum 25 seats");
    expect(html).toContain("30 days free");
    expect(html).toContain("10% off when paid annually");
    expect(html).toContain("+20 agents for CA$12/mo");
    expect(html).not.toMatch(/\$49\b|\$249\b|60 days/);
  });

  it("dashboard: seat count, annual toggle, per-seat buttons; the checkout sends seats and interval", () => {
    const html = read("public/app.html");
    expect(html).toContain('<input id="seat-count" type="number" min="1" step="1" value="3">');
    expect(html).toContain('<input id="annual-billing" type="checkbox">');
    expect(html).toContain("Upgrade to Operator (CA$24/seat/mo, 1-2 seats)");
    expect(html).toContain("Upgrade to Estate (CA$24/seat/mo, min 3 seats)");
    const js = read("public/app.js");
    expect(js).toContain('seats: Number($("seat-count").value)');
    expect(js).toContain('interval: $("annual-billing").checked ? "year" : "month"');
    expect(js).toContain('upSov.textContent = "Upgrade to Estate (CA$24/seat/mo, min 3 seats)";');
  });

  it("README states the per-seat model and the new variables", () => {
    const md = read("README.md");
    expect(md).toContain("| Tier | Requests/min | Requests/day | Price (CAD per seat per month) | Seats | Estate |");
    for (const v of ["STRIPE_PRICE_OPERATOR_ANNUAL", "STRIPE_PRICE_SOVEREIGN_ANNUAL", "STRIPE_PRICE_PACK", "STRIPE_PRICE_PACK_ANNUAL"]) expect(md).toContain("`" + v + "`");
    expect(md).toContain("src/lib/pricebook.ts");
  });
});
