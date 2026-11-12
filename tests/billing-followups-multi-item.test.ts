// Billing audit L3 (review of PR 15): a subscription is mapped to a tier by the item whose price is a configured portal
// price, not by items[0]. Several distinct tiers on one subscription are ambiguous (unmatched price), never a guess.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { freshStore } from "./helpers";
import { createUser, getUserById, type User } from "../src/lib/users";
import { handleStripeEvent } from "../src/lib/billing";
import { stripeConfig, subscriptionPriceId, tierForPrice } from "../src/lib/stripe";

const ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const items = (...ids: string[]) => ({ data: ids.map((id) => ({ price: { id }, current_period_end: 1_800_000_000 })) });
const sub = (ids: string[], userId: string) => ({ id: "sub_1", status: "active", customer: "cus_1", items: items(...ids), metadata: { user_id: userId } });

let user: User;
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, ENV);
  spy = vi.spyOn(console, "error").mockImplementation(() => {});
  user = await createUser("mi@example.com", "sufficiently-long-pass");
});
afterEach(() => {
  spy.mockRestore();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

describe("subscriptionPriceId with a config", () => {
  const cfg = () => stripeConfig()!;
  it("picks the item whose price maps to a tier, wherever it sits", () => {
    expect(subscriptionPriceId({ id: "s", status: "active", customer: "c", items: items("price_addon", "price_sov") }, cfg())).toBe("price_sov");
  });
  it("no item maps: the first item's id (the unmatched price that is alerted)", () => {
    expect(subscriptionPriceId({ id: "s", status: "active", customer: "c", items: items("price_x", "price_y") }, cfg())).toBe("price_x");
  });
  it("items of two different tiers are ambiguous: null (maps to no tier)", () => {
    const p = subscriptionPriceId({ id: "s", status: "active", customer: "c", items: items("price_op", "price_sov") }, cfg());
    expect(p).toBeNull();
    expect(tierForPrice(cfg(), p)).toBeNull();
  });
  it("the same tier twice is one tier", () => {
    expect(subscriptionPriceId({ id: "s", status: "active", customer: "c", items: items("price_op", "price_op") }, cfg())).toBe("price_op");
  });
  it("without a config the first item is returned (unchanged)", () => {
    expect(subscriptionPriceId({ id: "s", status: "active", customer: "c", items: items("price_addon", "price_sov") })).toBe("price_addon");
  });
});

describe("the webhook maps a multi-item subscription by its configured price", () => {
  const deps = () => ({ cfg: stripeConfig()!, fly: null });
  it("an add-on item listed first does not stop the paid tier being granted", async () => {
    const r = await handleStripeEvent({ id: "evt_1", type: "customer.subscription.created", created: 10, data: { object: sub(["price_addon", "price_op"], user.id) } }, deps());
    expect(r.handled).toBe(true);
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("operator");
    expect(u.billing).toMatchObject({ price_id: "price_op", tier: "operator" });
    expect(u.billing!.price_unmatched).toBeUndefined();
  });
  it("two different tiers on one subscription grant nothing and are flagged as an unmatched price", async () => {
    await handleStripeEvent({ id: "evt_2", type: "customer.subscription.created", created: 10, data: { object: sub(["price_op", "price_sov"], user.id) } }, deps());
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("sandbox");
    expect(u.billing!.price_unmatched).toBe(true);
  });
});
