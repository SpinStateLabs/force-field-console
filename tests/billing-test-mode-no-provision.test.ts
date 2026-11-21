// A Stripe TEST-mode event must never cause Fly spend (G6 finding, 2026-11-21): the deployed portal had Stripe test
// keys AND Fly provisioning configured, so one test checkout would have created a real, billed Fly estate.
//  - livemode false, Fly configured: the tier is granted, the estate is queued as pending_manual with test_hold, no
//    Fly call is made by the webhook, and neither the tick nor advanceEstate promotes it.
//  - livemode true: unchanged (provisioning).
//  - STRIPE_TEST_MODE_PROVISIONING === "true" (exact) opts test mode in; any other value does not.
//  - livemode missing or not a boolean: fail closed (held), even with the opt-in.
//  - a test-mode grant never resumes or starts an existing estate's machine (webhook and tick).
//  - a later live-mode grant releases the hold and provisioning proceeds.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { freshStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent, retryPendingSuspend } from "../src/lib/billing";
import { advanceEstate, autoRetryFailedEstate, getEstate, queueEstate, saveEstate } from "../src/lib/estates";

const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };
const OPT_IN = "STRIPE_TEST_MODE_PROVISIONING";

let user: User;
let errSpy: ReturnType<typeof vi.spyOn>;
let fetchSpy: ReturnType<typeof vi.fn>;
let seq = 0;

/** A Fly client double that records every call; any call at all is a failure in the held cases. */
function recordingFly() {
  const calls: string[] = [];
  const handler: ProxyHandler<any> = {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      return vi.fn(async () => {
        calls.push(String(prop));
        return { id: "x", state: "stopped" };
      });
    },
  };
  return { fly: new Proxy({}, handler) as any, calls };
}

function subEvent(livemode: unknown, over: Record<string, unknown> = {}) {
  seq += 1;
  const ev: any = {
    id: "evt_" + seq,
    type: "customer.subscription.created",
    created: 1_790_000_000 + seq,
    data: {
      object: {
        id: "sub_1",
        status: "active",
        customer: "cus_1",
        items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] },
        metadata: { user_id: user.id },
        ...over,
      },
    },
  };
  if (livemode !== undefined) ev.livemode = livemode;
  return ev;
}

async function apply(livemode: unknown, over: Record<string, unknown> = {}) {
  const { fly, calls } = recordingFly();
  const out = await handleStripeEvent(subEvent(livemode, over), { cfg: stripeConfig()!, fly });
  return { out, calls };
}

beforeEach(async () => {
  freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV);
  delete process.env[OPT_IN];
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: "m_1", state: "stopped" }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchSpy);
  user = await createUser("tm@example.com", "sufficiently-long-pass");
});
afterEach(() => {
  errSpy.mockRestore();
  vi.unstubAllGlobals();
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV), OPT_IN]) delete process.env[k];
});

describe("test-mode grant with Fly configured: no provisioning", () => {
  it("livemode false grants the tier but holds the estate as pending_manual with test_hold, no Fly call", async () => {
    const { out, calls } = await apply(false);
    expect(out.handled).toBe(true);
    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("operator");
    expect(u.billing?.test_mode).toBe(true);
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("pending_manual");
    expect(e.test_hold).toBe(true);
    expect(calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("advanceEstate does not promote a test-held estate even though Fly is configured", async () => {
    await apply(false);
    const { fly, calls } = recordingFly();
    const r = await advanceEstate((await getEstate(user.id))!, fly);
    expect(r.outcome).toBe("idle");
    expect((await getEstate(user.id))!.status).toBe("pending_manual");
    expect(calls).toEqual([]);
  });

  it("the scheduled tick makes no Fly request for a test-held estate", async () => {
    await apply(false);
    await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await getEstate(user.id))!.status).toBe("pending_manual");
  });
});

describe("live mode is unchanged", () => {
  it("livemode true queues automatic provisioning", async () => {
    const { calls } = await apply(true);
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("provisioning");
    expect(e.test_hold ?? false).toBe(false);
    expect((await getUserById(user.id))!.billing?.test_mode ?? false).toBe(false);
    expect(calls).toEqual([]); // the webhook itself never provisions inline
  });
});

describe("explicit opt-in", () => {
  it(`${OPT_IN}="true" lets a test-mode grant provision`, async () => {
    process.env[OPT_IN] = "true";
    await apply(false);
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("provisioning");
    expect(e.test_hold ?? false).toBe(false);
  });

  for (const v of ["1", "yes", "TRUE", " true", "on", ""]) {
    it(`${OPT_IN}=${JSON.stringify(v)} is not an opt-in`, async () => {
      process.env[OPT_IN] = v;
      await apply(false);
      expect((await getEstate(user.id))!.status).toBe("pending_manual");
    });
  }
});

describe("missing or non-boolean livemode fails closed", () => {
  for (const v of [undefined, null, "true", "false", 1, 0, {}]) {
    it(`livemode ${JSON.stringify(v) ?? "missing"} holds the estate, even with the opt-in`, async () => {
      process.env[OPT_IN] = "true";
      const { calls } = await apply(v);
      const e = (await getEstate(user.id))!;
      expect(e.status).toBe("pending_manual");
      expect(e.test_hold).toBe(true);
      expect(calls).toEqual([]);
    });
  }
});

describe("a test-mode grant never starts an existing estate's machine", () => {
  async function suspendedEstate() {
    user.tier = "sandbox";
    await saveUser(user);
    const e = await queueEstate(user);
    Object.assign(e, { status: "suspended", machine_id: "m_1", step: "done", suspended_from: "ready", suspended_at: new Date().toISOString() });
    await saveEstate(e);
  }

  it("webhook: a suspended estate is not marked resume_pending and stays suspended", async () => {
    await suspendedEstate();
    const { calls } = await apply(false);
    const e = (await getEstate(user.id))!;
    expect(e.status).toBe("suspended");
    expect(e.resume_pending ?? null).toBeNull();
    expect(calls).toEqual([]);
  });

  it("tick reconcile: retryPendingSuspend does not resume a test-mode user's estate", async () => {
    await suspendedEstate();
    await apply(false);
    const e = (await getEstate(user.id))!;
    e.resume_pending = { since: new Date().toISOString(), attempts: 0, last_error: "", next_retry_at: null, failed: false };
    await saveEstate(e);
    const { fly, calls } = recordingFly();
    await retryPendingSuspend(user.id, fly);
    expect(calls).toEqual([]);
    expect((await getEstate(user.id))!.status).toBe("suspended");
  });

  it("tick: a test-mode user's stopped ready estate is never queued to start (no Fly write)", async () => {
    const e = await queueEstate(user);
    Object.assign(e, { status: "ready", machine_id: "m_1", step: "done" });
    await saveEstate(e);
    await apply(false);
    await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }));
    // The tick's existing READ-only look at a ready estate (checkEstateHealth: GET app, GET machine) is unchanged and
    // costs nothing; what must not happen is a write to the Fly API (start, update, create) or a queued resume.
    const flyWrites = fetchSpy.mock.calls
      .filter((c: any[]) => /api\.machines\.dev|api\.fly\.io/.test(String(c[0])))
      .filter((c: any[]) => String(c[1]?.method ?? "GET").toUpperCase() !== "GET");
    expect(flyWrites).toEqual([]);
    expect((await getEstate(user.id))!.resume_pending ?? null).toBeNull();
  });
});

describe("a later live-mode grant releases the hold", () => {
  it("test hold, then a livemode true event: the estate provisions", async () => {
    await apply(false);
    expect((await getEstate(user.id))!.test_hold).toBe(true);
    await apply(true, { status: "active" });
    const e = (await getEstate(user.id))!;
    expect(e.test_hold ?? false).toBe(false);
    expect((await getUserById(user.id))!.billing?.test_mode ?? false).toBe(false);
    const { fly } = recordingFly();
    const r = await advanceEstate(e, fly);
    expect((await getEstate(user.id))!.status).toBe("provisioning");
    expect(r.outcome).not.toBe("idle");
  });
});

// Review r1 (2026-11-21) C1-C3.
describe("r1 C1: a held grant also holds an estate that already exists and is not ready", () => {
  for (const status of ["provisioning", "pending_manual", "error"] as const) {
    it(`an existing ${status} estate gets test_hold and is never advanced or auto-retried`, async () => {
      const e = await queueEstate(user);
      Object.assign(e, { status, provision_retry: status === "error" ? { count: 0, next_retry_at: new Date(0).toISOString() } : null, attempts: status === "error" ? 99 : 0 });
      await saveEstate(e);
      const { calls } = await apply(false);
      const held = (await getEstate(user.id))!;
      expect(held.test_hold).toBe(true);
      expect(calls).toEqual([]);
      const { fly, calls: advCalls } = recordingFly();
      const r = await advanceEstate(held, fly);
      expect(r.outcome).toBe("idle");
      expect(advCalls).toEqual([]);
      expect(await autoRetryFailedEstate((await getEstate(user.id))!, new Date())).toBe(false);
    });
  }

  it("an existing ready estate is NOT marked held (it is already running; maintenance is unchanged)", async () => {
    const e = await queueEstate(user);
    Object.assign(e, { status: "ready", machine_id: "m_1", step: "done" });
    await saveEstate(e);
    await apply(false);
    expect((await getEstate(user.id))!.test_hold ?? false).toBe(false);
  });
});

describe("r1 C2: a stale whole-record write never brings a released hold back", () => {
  it("held copy read, live grant releases the hold, stale copy saved: the hold stays released", async () => {
    await apply(false);
    const stale = (await getEstate(user.id))!;
    expect(stale.test_hold).toBe(true);
    await apply(true);
    expect((await getEstate(user.id))!.test_hold ?? false).toBe(false);
    stale.log = [...stale.log, { at: new Date().toISOString(), step: "x", note: "stale writer" }];
    await saveEstate(stale);
    expect((await getEstate(user.id))!.test_hold ?? false).toBe(false);
  });

  it("the tick does not count or kick a worker for a held estate", async () => {
    await apply(false);
    process.env.URL = "https://portal.test";
    try {
      const body = await (await tickHandler(new Request("http://portal.test/tick", { method: "POST", body: "{}" }))).json();
      expect(body.pending).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.URL;
    }
  });
});

describe("r1 C3: a pending suspension is still retried for a held user", () => {
  it("retryPendingSuspend stops the machine of a held user's estate with suspend_pending", async () => {
    const e = await queueEstate(user);
    Object.assign(e, { status: "ready", machine_id: "m_1", step: "done" });
    await saveEstate(e);
    await apply(false);
    const cur = (await getEstate(user.id))!;
    cur.suspend_pending = { reason: "test", since: new Date().toISOString(), attempts: 1, last_error: "machine stop failed", next_retry_at: null, failed: false };
    await saveEstate(cur);
    const { fly, calls } = recordingFly();
    const r = await retryPendingSuspend(user.id, fly);
    // Before the fix the held user's pending suspension was answered "cleared" with no Fly call at all. Now it goes
    // through suspendEstate (the generic double cannot model a full stop, so the outcome may stay "pending" for the
    // next retry); what matters: the suspend path ran, and nothing was started.
    expect(["suspended", "pending"]).toContain(r.outcome);
    expect(calls).toContain("getMachine");
    expect(calls.some((c) => /start/i.test(c))).toBe(false);
  });
});
