// CX6 (known gap G2): two non-cancel events of ONE subscription with the same `created` second cannot be
// ordered by the high-water mark, so before this fix they applied in arrival order. Minimal repro from the
// lifecycle model (tests/model/counterexamples.test.ts on test/lifecycle-model): a ready estate, sub_1 goes
// paused and then active 400 ms later (same second), Stripe delivers them reversed. The tie must be resolved
// from the subscription's LIVE state at Stripe, not from whichever payload arrived last.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelFly } from "./model-fly";
import { freshStore, MemStore } from "./helpers";
import { setStoreForTesting } from "../src/lib/store";
import { createUser, getUserById, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent } from "../src/lib/billing";
import { getEstate, queueEstate, saveEstate } from "../src/lib/estates";

const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };

function sub(status: string, userId: string, price = "price_op", customer = "cus_1") {
  return {
    id: "sub_1",
    status,
    customer,
    items: { data: [{ price: { id: price }, current_period_end: 1_800_000_000 }] },
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

// Review round 1 (PL-PR6-R1-01/03/04). A tie resolved from the live subscription whose apply then fails
// AFTER the mark CAS (any transient Blobs error, or a killed function and a stale-claim takeover) is
// redelivered by Stripe with the SAME event id. The mark then carries that id, and the redelivery must
// still be resolved from the live subscription, never from its payload.
class FlakyStore extends MemStore {
  failOncePrefix: string | null = null;
  async setJSON(key: string, value: any): Promise<void> {
    if (this.failOncePrefix && key.startsWith(this.failOncePrefix)) {
      this.failOncePrefix = null;
      throw new Error("blobs: transient 503 (simulated)");
    }
    return super.setJSON(key, value);
  }
}

describe("CX6 review round 1: retries, mark contents, live-object checks", () => {
  let user: User;
  let fly: CountingFly;
  let store: FlakyStore;
  let live: { status: string; price?: string; customer?: string };
  let stripeGets: string[];
  const fetchImpl = (async (url: any) => {
    const u = String(url);
    stripeGets.push(u);
    if (u.endsWith("/v1/subscriptions/sub_1")) return new Response(JSON.stringify(sub(live.status, user.id, live.price, live.customer)), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }) as any;
  const ev = (id: string, created: number, status: string, price = "price_op") => ({ id, type: "customer.subscription.updated", created, data: { object: sub(status, user.id, price) } });
  const deps = () => ({ cfg: stripeConfig()!, fly: fly as any, fetchImpl });
  const mark = async () => store.get("stripe_subs/sub_1", { type: "json" });

  beforeEach(async () => {
    store = new FlakyStore();
    setStoreForTesting(store);
    process.env.SESSION_SECRET = "test-secret-0123456789";
    Object.assign(process.env, STRIPE_ENV);
    stripeGets = [];
    user = await createUser("retry@example.com", "sufficiently-long-pass");
    user.tier = "operator";
    const e = await queueEstate(user);
    e.status = "ready";
    e.step = "done";
    e.machine_id = "m_1";
    e.volume_id = "vol_1";
    e.url = `https://${e.app}.fly.dev`;
    await saveEstate(e);
    fly = new CountingFly();
    fly.machine("m_1");
  });
  afterEach(() => {
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  });

  it("paying direction: tie resolved live=active, apply fails after the mark, the redelivery keeps the customer running", async () => {
    live = { status: "active" };
    await handleStripeEvent(ev("e_active", 1000, "active"), deps());
    store.failOncePrefix = "stripe_customers/"; // the write right after saveUser inside applySubscription
    await expect(handleStripeEvent(ev("e_paused", 1000, "paused"), deps())).rejects.toThrow(/transient 503/);
    expect(stripeGets.length).toBe(1);
    expect(await mark()).toMatchObject({ created: 1000, status: "active", event_id: "e_paused" });
    // Stripe redelivers the same event id with Blobs healthy again
    await handleStripeEvent(ev("e_paused", 1000, "paused"), deps());
    const u = (await getUserById(user.id))!;
    const e = (await getEstate(user.id))!;
    expect(u.tier).toBe("operator");
    expect(u.billing?.status).toBe("active");
    expect(e.status).not.toBe("suspended");
    expect(e.suspend_pending ?? null).toBeNull();
    expect(fly.calls).toEqual([]);
    expect(stripeGets.length).toBe(2); // the redelivery re-read the live subscription
  });

  it("cancel direction: tie resolved live=incomplete_expired, apply fails after the mark, the redelivery does not resume", async () => {
    live = { status: "incomplete_expired" };
    await handleStripeEvent(ev("e_expired", 1000, "incomplete_expired"), deps());
    expect((await getEstate(user.id))!.status).toBe("suspended");
    store.failOncePrefix = "stripe_customers/";
    await expect(handleStripeEvent(ev("e_active", 1000, "active"), deps())).rejects.toThrow(/transient 503/);
    expect(stripeGets.length).toBe(1);
    await handleStripeEvent(ev("e_active", 1000, "active"), deps());
    const u = (await getUserById(user.id))!;
    const e = (await getEstate(user.id))!;
    expect(u.tier).toBe("sandbox");
    expect(u.billing?.status).toBe("incomplete_expired");
    expect(e.status).toBe("suspended");
    expect(e.resume_pending ?? null).toBeNull();
    expect(fly.calls.filter((c) => c.startsWith("start"))).toEqual([]);
  });

  it("same status, different price: the redelivery of a live-resolved tie applies the live price, not the payload's", async () => {
    // Live and payload statuses agree, so only the mark's tie flag tells the redelivery its payload was not applied.
    live = { status: "active", price: "price_op" };
    await handleStripeEvent(ev("e_op", 1000, "active", "price_op"), deps());
    store.failOncePrefix = "stripe_customers/";
    await expect(handleStripeEvent(ev("e_sov", 1000, "active", "price_sov"), deps())).rejects.toThrow(/transient 503/);
    await handleStripeEvent(ev("e_sov", 1000, "active", "price_sov"), deps());
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("operator");
    expect(stripeGets.length).toBe(2);
  });

  it("a resolved tie records the LIVE status in the mark and in the handled note", async () => {
    live = { status: "active" };
    await handleStripeEvent(ev("e_active", 1000, "active"), deps());
    const out = await handleStripeEvent(ev("e_paused", 1000, "paused"), deps());
    expect(await mark()).toEqual({ created: 1000, status: "active", event_id: "e_paused", tie: true });
    expect(out.handled).toBe(true);
    expect(out.note).toBe("customer.subscription.updated; status active; tier operator");
  });

  it("an untied event writes a plain mark and makes no live read", async () => {
    live = { status: "active" };
    await handleStripeEvent(ev("e_active", 1000, "active"), deps());
    expect(await mark()).toEqual({ created: 1000, status: "active", event_id: "e_active" });
    await handleStripeEvent(ev("e_later", 1001, "active"), deps());
    expect(await mark()).toEqual({ created: 1001, status: "active", event_id: "e_later" });
    expect(stripeGets).toEqual([]);
  });

  it("checkout.session.completed tying with a subscription event makes no second read (the checkout object is already live)", async () => {
    live = { status: "active" };
    await handleStripeEvent({ id: "e_created", type: "customer.subscription.created", created: 1000, data: { object: sub("active", user.id) } }, deps());
    expect(stripeGets).toEqual([]);
    const out = await handleStripeEvent(
      { id: "e_checkout", type: "checkout.session.completed", created: 1000, data: { object: { mode: "subscription", subscription: "sub_1", client_reference_id: user.id } } },
      deps(),
    );
    expect(out.handled).toBe(true);
    expect(stripeGets.length).toBe(1); // the handler's own read only, no tie read
    expect(await mark()).toEqual({ created: 1000, status: "active", event_id: "e_checkout" });
  });

  it("a live read that returns another customer's subscription throws and changes nothing", async () => {
    live = { status: "paused", customer: "cus_other" };
    await handleStripeEvent(ev("e_active", 1000, "active"), deps());
    await expect(handleStripeEvent(ev("e_paused", 1000, "paused"), deps())).rejects.toThrow(/does not match/);
    expect(stripeGets.length).toBe(1);
    expect(await mark()).toEqual({ created: 1000, status: "active", event_id: "e_active" });
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("operator");
    expect(u.billing?.status).toBe("active");
    expect((await getEstate(user.id))!.status).toBe("ready");
    expect(fly.calls).toEqual([]);
  });

  // Review round 2 (PL-PR6-R2-02). The status clause of the tie test: a mark WITHOUT the tie flag whose
  // recorded status differs from the redelivered payload of the same event id (no writer in this code
  // produces one today; a hand-repaired mark or an older writer could). The payload was not what was
  // applied, so the redelivery must be resolved from the live subscription, never from its payload.
  it("a plain mark whose status differs from the same event's redelivered payload re-resolves from live", async () => {
    live = { status: "active" };
    await handleStripeEvent(ev("e_active", 1000, "active"), deps());
    await store.setJSON("stripe_subs/sub_1", { created: 1000, status: "active", event_id: "e_paused" });
    await handleStripeEvent(ev("e_paused", 1000, "paused"), deps());
    const u = (await getUserById(user.id))!;
    const e = (await getEstate(user.id))!;
    expect(u.tier).toBe("operator");
    expect(u.billing?.status).toBe("active");
    expect(e.status).not.toBe("suspended");
    expect(e.suspend_pending ?? null).toBeNull();
    expect(fly.calls).toEqual([]);
    expect(stripeGets.length).toBe(1);
    expect(await mark()).toEqual({ created: 1000, status: "active", event_id: "e_paused", tie: true });
  });
});
