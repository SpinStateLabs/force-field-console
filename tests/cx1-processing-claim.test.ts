// CX1 (group processing-claim-acked-200): a delivery that dies after claiming an event leaves the claim
// "processing" (a killed function runs no finally). A redelivery inside STALE_CLAIM_MS must NOT be answered
// 2xx: Stripe treats any 2xx as delivered and stops retrying, so the event (a cancel, or a grant) would be lost.
// Only a "done" record is acknowledged as a duplicate.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import handler from "../netlify/functions/billing.mts";
import { freshStore } from "./helpers";
import { createUser, getUserById, type User } from "../src/lib/users";
import { signPayload } from "../src/lib/stripe";
import { STALE_CLAIM_MS, alreadyProcessed, claimEvent } from "../src/lib/billing";

const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };

function sub(userId: string) {
  return {
    id: "sub_1",
    status: "active",
    customer: "cus_1",
    items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] },
    metadata: { user_id: userId },
  };
}

describe("CX1: an in-flight 'processing' claim is not acknowledged like a 'done' one", () => {
  let user: User;
  let post: () => Promise<Response>;
  const EVT = "evt_cx1";
  const TYPE = "customer.subscription.updated";

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, STRIPE_ENV);
    user = await createUser("cx1@example.com", "sufficiently-long-pass");
    const raw = JSON.stringify({ id: EVT, type: TYPE, data: { object: sub(user.id) } });
    const sig = signPayload(raw, "whsec_test", Math.floor(Date.now() / 1000));
    post = () => handler(new Request("http://portal.test/api/billing/webhook", { method: "POST", headers: { "stripe-signature": sig }, body: raw }), ctx);
  });

  afterEach(() => {
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  });

  it("a redelivery while the claim is still 'processing' (first delivery killed after claiming) is answered non-2xx, not 200 duplicate", async () => {
    // The first delivery was killed right after its create-only claim: the record stays "processing".
    expect(await claimEvent(EVT, TYPE, new Date(Date.now() - 30_000))).toBe(true);

    const retry = await post();
    expect(retry.status).toBeGreaterThanOrEqual(300); // Stripe must keep retrying
    const body = await retry.json();
    expect(body.duplicate).toBeUndefined();
    expect(body.error?.code).toBe("event_in_progress");
    expect((await getUserById(user.id))!.tier).toBe("sandbox"); // nothing applied by this answer
    // the in-flight claim is left alone (not released, not taken over) while fresh
    expect(await alreadyProcessed(EVT)).toBe(true);
  });

  it("Stripe's later retry, once the dead claim is stale, takes it over and applies the event; then a redelivery is 200 duplicate", async () => {
    expect(await claimEvent(EVT, TYPE, new Date(Date.now() - STALE_CLAIM_MS - 60_000))).toBe(true);

    const retry = await post();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ received: true, handled: true });
    expect((await getUserById(user.id))!.tier).toBe("operator");

    const dup = await post();
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ received: true, duplicate: true });
  });
});
