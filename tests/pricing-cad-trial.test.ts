// Pricing decided by Don (2026-11-10, DOSSIER.md line ~689; confirmed for code 2026-11-21 via the controller):
// Operator CAD 49/month, tier 2 CAD 249/month, 60 days free. Billing from day 61 only on a continuation step:
// Checkout does not require a card during the trial, and a trial that ends with no payment method CANCELS
// (Stripe trial_settings.end_behavior.missing_payment_method = cancel), so nobody is charged without acting.
// The trial is for a customer's FIRST subscription only (no Stripe customer on record yet).
// Display label of tier 2 stays "Estate" here (Don, 2026-11-20); the deck's "Team" is an open naming question.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import handler from "../netlify/functions/billing.mts";
import { freshStore } from "./helpers";
import { createUser, saveUser, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { createCheckoutSession } from "../src/lib/stripe";
import { PRICE_CURRENCY, TIERS, TRIAL_DAYS } from "../src/lib/tiers";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const CFG = { secret_key: "sk_test_x", webhook_secret: "whsec_test", prices: { operator: "price_op", sovereign: "price_sov" } };
const ok = () => new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }), { status: 200, headers: { "content-type": "application/json" } });

describe("tier prices are CAD with a 60-day trial", () => {
  it("TIERS carries CAD monthly prices 0 / 49 / 249 and no USD field", () => {
    expect(PRICE_CURRENCY).toBe("CAD");
    expect(TRIAL_DAYS).toBe(60);
    expect(TIERS.sandbox.price_cad_month).toBe(0);
    expect(TIERS.operator.price_cad_month).toBe(49);
    expect(TIERS.sovereign.price_cad_month).toBe(249);
    for (const t of Object.values(TIERS)) expect("price_usd_month" in t).toBe(false);
  });
});

describe("createCheckoutSession trial parameters", () => {
  async function body(trial_days?: number) {
    let b = "";
    await createCheckoutSession(CFG, { user_id: "u1", email: "a@b.co", tier: "operator", success_url: "s", cancel_url: "c", trial_days }, async (_u: string, init?: any) => {
      b = String(init.body);
      return ok();
    });
    return new URLSearchParams(b);
  }

  it("a trial sends 60 days, no card required, and cancel when the trial ends without a payment method", async () => {
    const p = await body(60);
    expect(p.get("subscription_data[trial_period_days]")).toBe("60");
    expect(p.get("payment_method_collection")).toBe("if_required");
    expect(p.get("subscription_data[trial_settings][end_behavior][missing_payment_method]")).toBe("cancel");
  });

  it("no trial: none of the trial parameters are sent (card collected as before)", async () => {
    for (const d of [undefined, 0]) {
      const p = await body(d);
      expect(p.get("subscription_data[trial_period_days]")).toBeNull();
      expect(p.get("payment_method_collection")).toBeNull();
      expect(p.get("subscription_data[trial_settings][end_behavior][missing_payment_method]")).toBeNull();
    }
  });
});

describe("checkout endpoint: the trial is for a first subscription only", () => {
  let user: User;
  let seen = "";
  const realFetch = globalThis.fetch;
  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, STRIPE_ENV);
    user = await createUser("trial@example.com", "sufficiently-long-pass");
    seen = "";
    globalThis.fetch = (async (_u: any, init?: any) => {
      seen = String(init?.body ?? "");
      return ok();
    }) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  });
  const checkout = async (u: User) => {
    const cookie = sessionCookie(await issueSession(u.id)).split(";")[0];
    const r = await handler(new Request("http://portal.test/api/billing/checkout", { method: "POST", headers: { cookie }, body: JSON.stringify({ tier: "operator" }) }), ctx);
    expect(r.status).toBe(200);
    return new URLSearchParams(seen);
  };

  it("a new customer gets the 60-day trial", async () => {
    expect((await checkout(user)).get("subscription_data[trial_period_days]")).toBe("60");
  });

  it("a returning customer (a Stripe customer on record) gets no second trial", async () => {
    user.billing = { customer_id: "cus_9", subscription_id: "sub_old", status: "canceled", price_id: "price_op", tier: "sandbox", current_period_end: null, updated_at: "t" };
    await saveUser(user);
    const p = await checkout(user);
    expect(p.get("customer")).toBe("cus_9");
    expect(p.get("subscription_data[trial_period_days]")).toBeNull();
  });
});

describe("display copy says CAD and the trial", () => {
  it("landing page: CA$49 and CA$249 per month, 60 days free, no bare $49/$249", () => {
    const html = read("public/index.html");
    expect(html).toMatch(/<h3 class="tier-name">Operator<\/h3>\s*<p class="tier-price">CA\$49<span class="per">\/mo<\/span><\/p>/);
    expect(html).toMatch(/<h3 class="tier-name">Estate<\/h3>\s*<p class="tier-price">CA\$249<span class="per">\/mo<\/span><\/p>/);
    expect(html).toContain("60 days free");
    expect(html).not.toMatch(/[^A]\$49\b|[^A]\$249\b/);
  });

  it("dashboard buttons say CA$", () => {
    expect(read("public/app.html")).toContain("Upgrade to Operator (CA$49/mo)");
    expect(read("public/app.html")).toContain("Upgrade to Estate (CA$249/mo)");
    expect(read("public/app.js")).toContain('upSov.textContent = "Upgrade to Estate (CA$249/mo)";');
    for (const f of ["public/app.html", "public/app.js"]) expect(read(f)).not.toMatch(/\(\$(49|249)\/mo\)/);
  });

  it("README tier table is in CAD and states the trial", () => {
    const md = read("README.md");
    expect(md).toContain("| Tier | Requests/min | Requests/day | Price (CAD/mo) | Estate |");
    expect(md).not.toContain("Price (USD/mo)");
    expect(md).toMatch(/60 days free/);
  });
});
