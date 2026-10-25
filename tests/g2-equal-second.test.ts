// CX6 (known gap G2): two non-cancel events of ONE subscription with the same `created` second cannot be
// ordered by the high-water mark, so before this fix they applied in arrival order. Minimal repro from the
// lifecycle model (tests/model/counterexamples.test.ts on test/lifecycle-model): a ready estate, sub_1 goes
// paused and then active 400 ms later (same second), Stripe delivers them reversed. The tie must be resolved
// from the subscription's LIVE state at Stripe, not from whichever payload arrived last.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelFly } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, getUserById, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent } from "../src/lib/billing";
import { getEstate, queueEstate, saveEstate } from "../src/lib/estates";

const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };

function sub(status: string, userId: string) {
  return {
    id: "sub_1",
    status,
    customer: "cus_1",
    items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] },
    metadata: { user_id: userId },
  };
}

class CountingFly extends ModelFly {
  calls: string[] = [];
  async stopMachine(app: string, id: string) { this.calls.push(`stop ${id}`); await super.stopMachine(app, id); }
  async startMachine(app: string, id: string) { this.calls.push(`start ${id}`); await super.startMachine(app, id); }
}

describe("CX6 g2-equal-second: same-second non-cancel events resolve to Stripe's live state", () => {
  let user: User;
  let fly: CountingFly;
  let live: string;
  let stripeGets: string[];
  const fetchImpl = (async (url: any) => {
    const u = String(url);
    stripeGets.push(u);
    if (u.endsWith("/v1/subscriptions/sub_1")) return new Response(JSON.stringify(sub(live, user.id)), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }) as any;
  const ev = (id: string, created: number, status: string) => ({ id, type: "customer.subscription.updated", created, data: { object: sub(status, user.id) } });

  beforeEach(async () => {
    freshStore();
    Object.assign(process.env, STRIPE_ENV);
    stripeGets = [];
    user = await createUser("tie@example.com", "sufficiently-long-pass");
    user.tier = "operator";
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.machine_id = "m_1";
    e.volume_id = "vol_1";
    e.url = `https://${e.app}.fly.dev`;
    await saveEstate(e);
    fly = new CountingFly();
    fly.machine("m_1"); // started, autostart on
  });
  afterEach(() => {
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  });

  it("paused then active in one second, delivered reversed: the paying customer stays running", async () => {
    live = "active"; // Stripe's current state: the later of the two transitions
    const deps = { cfg: stripeConfig()!, fly: fly as any, fetchImpl };
    await handleStripeEvent(ev("e_active", 1000, "active"), deps);
    await handleStripeEvent(ev("e_paused", 1000, "paused"), deps);

    const u = (await getUserById(user.id))!;
    const e = (await getEstate(user.id))!;
    expect(u.tier).toBe("operator");
    expect(u.billing?.status).toBe("active");
    expect(e.status).not.toBe("suspended");
    expect(e.suspend_pending ?? null).toBeNull();
    expect(fly.calls).toEqual([]); // never stopped
    expect(stripeGets.length).toBe(1); // exactly one live read, for the tie
  });

  it("active then incomplete_expired in one second, delivered reversed: a non-granting customer is not resumed", async () => {
    live = "incomplete_expired";
    const deps = { cfg: stripeConfig()!, fly: fly as any, fetchImpl };
    await handleStripeEvent(ev("e_expired", 1000, "incomplete_expired"), deps);
    expect((await getEstate(user.id))!.status).toBe("suspended");
    await handleStripeEvent(ev("e_active", 1000, "active"), deps);

    const u = (await getUserById(user.id))!;
    const e = (await getEstate(user.id))!;
    expect(u.tier).toBe("sandbox");
    expect(u.billing?.status).toBe("incomplete_expired");
    expect(e.status).toBe("suspended");
    expect(e.resume_pending ?? null).toBeNull();
    expect(fly.calls.filter((c) => c.startsWith("start"))).toEqual([]);
  });

  it("the tie read failing (Stripe down) changes nothing and is retryable", async () => {
    live = "active";
    const deps = { cfg: stripeConfig()!, fly: fly as any, fetchImpl };
    await handleStripeEvent(ev("e_active", 1000, "active"), deps);
    const failing = (async () => new Response("{}", { status: 503 })) as any;
    await expect(handleStripeEvent(ev("e_paused", 1000, "paused"), { ...deps, fetchImpl: failing })).rejects.toThrow();
    expect((await getUserById(user.id))!.tier).toBe("operator");
    expect((await getEstate(user.id))!.status).toBe("ready");
    expect(fly.calls).toEqual([]);
    // the redelivery, with Stripe reachable again, resolves to the live state
    await handleStripeEvent(ev("e_paused", 1000, "paused"), deps);
    expect((await getUserById(user.id))!.tier).toBe("operator");
    expect(fly.calls).toEqual([]);
  });
});
