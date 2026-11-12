// Owner release of a suspended dedicated estate back to the shared sandbox (src/lib/release.ts,
// POST /api/estate/release): every refusal condition changes nothing, a release deletes the record
// behind an audit copy, a stale copy can never bring the record back, and the account's keys then
// route to the sandbox.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import estateHandler from "../netlify/functions/estate.mts";
import gatewayHandler from "../netlify/functions/gateway.mts";
import tickHandler from "../netlify/functions/estate-tick.mts";
import { freshStore, type MemStore } from "./helpers";
import { createUser, getUserById, saveUser, type Tier, type User } from "../src/lib/users";
import { issueKey } from "../src/lib/keys";
import { issueSession, sessionCookie } from "../src/lib/session";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent, retryPendingSuspend } from "../src/lib/billing";
import { FlyError } from "../src/lib/fly";
import { EstateError, estateKey, estateSecret, getEstate, newAppName, queueEstate, releasedEstateKey, saveEstate, type Estate } from "../src/lib/estates";
import { RELEASE_FLY_TIMEOUT_MS, RELEASE_QUIET_MS, billingBlocksRelease, releaseSuspendedEstate } from "../src/lib/release";

const ctx = {} as any;
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:y", ESTATE_SECRET_MASTER: "master-0123456789" };
const SANDBOX_ENV = { ESTATE_URL: "https://sandbox.example", ESTATE_SHARED_SECRET: "sandbox-secret" };
const QUEUED_AT = new Date("2026-10-01T00:00:00.000Z");
const NOW = new Date("2026-11-11T12:00:00.000Z");

let store: MemStore;
let user: User;

/** Fly stand-in for the one question the release asks: does this app exist? `apps[name]` may be an Error to throw. */
function fakeFly(apps: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const timeouts: unknown[] = [];
  const fly = {
    asked,
    timeouts,
    hook: null as null | (() => Promise<void>),
    async getApp(name: string, timeoutMs?: number) {
      asked.push(name);
      timeouts.push(timeoutMs);
      if (fly.hook) await fly.hook();
      const v = apps[name];
      if (v instanceof Error) throw v;
      return v ?? null;
    },
  };
  return fly;
}

async function setBilling(status: string | null, tier: Tier = "sandbox", extra: Record<string, unknown> = {}) {
  user.tier = tier;
  user.billing = status === null ? null : ({ customer_id: "cus_1", subscription_id: "sub_1", status, price_id: "price_op", tier, current_period_end: null, updated_at: "t", ...extra } as any);
  await saveUser(user);
}

/** A settled suspension as the webhook leaves it: status suspended, no pending flags, machine facts still on the record. */
async function suspendedEstate(over: Partial<Estate> = {}): Promise<Estate> {
  const e = await queueEstate(user, QUEUED_AT);
  Object.assign(e, { status: "suspended", step: "done", suspended_from: "ready", suspended_at: "2026-11-01T00:00:00.000Z", machine_id: "m_1", volume_id: "vol_1", url: `https://${e.app}.fly.dev` }, over);
  await store.setJSON(estateKey(user.id), e); // written raw: no merge rule between the test and the stored record
  return (await getEstate(user.id))!;
}

const markKey = () => "ops/config_write/" + user.id;
const auditKeys = async () => (await store.list({ prefix: "released_estates/" })).blobs.map((b) => b.key);

async function refusal(p: Promise<unknown>): Promise<[number, string]> {
  const err: any = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(EstateError);
  return [err.status, err.code];
}

/** A refusal changes nothing: the record is byte-identical, no audit copy exists, the config-write mark is kept. */
async function expectUntouched(before: Estate) {
  expect(await getEstate(user.id)).toEqual(before);
  expect(await auditKeys()).toEqual([]);
  expect(await store.get(markKey())).not.toBeNull();
}

beforeEach(async () => {
  store = freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV, SANDBOX_ENV);
  user = await createUser("release@example.com", "sufficiently-long-pass");
  await setBilling("canceled");
  await store.setJSON(markKey(), { at: "2026-11-01T00:00:00.000Z" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV), ...Object.keys(SANDBOX_ENV)]) delete process.env[k];
});

describe("releaseSuspendedEstate: success", () => {
  it("deletes the record behind an audit copy, drops the config-write mark, logs it and leaves the user alone", async () => {
    const e = await suspendedEstate();
    const fly = fakeFly();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const r = await releaseSuspendedEstate(user.id, fly as any, NOW);

    expect(r).toEqual({ released: true, app: e.app, audit_key: releasedEstateKey(user.id, e.created_at), released_at: NOW.toISOString() });
    expect(await getEstate(user.id)).toBeNull();
    expect(fly.asked).toEqual([e.app]); // Fly was asked, about this estate's app
    expect(fly.timeouts).toEqual([RELEASE_FLY_TIMEOUT_MS]); // with the short timeout: the user lock is held meanwhile
    expect(e.app).toBe(newAppName(user.id));

    const audit = await store.get(r.audit_key);
    expect(audit.estate).toEqual(e); // the whole old record
    expect(audit).toMatchObject({ released_at: NOW.toISOString(), released_by: user.id, fly_apps_checked: [e.app], billing: { tier: "sandbox", status: "canceled", subscription_id: "sub_1" } });
    expect(await auditKeys()).toEqual([r.audit_key]);
    // nothing secret in the audit copy: neither the master nor the estate's derived secret
    expect(JSON.stringify(audit)).not.toContain(FLY_ENV.ESTATE_SECRET_MASTER);
    expect(JSON.stringify(audit)).not.toContain(estateSecret(e.app));

    expect(await store.get(markKey())).toBeNull();
    expect(log.mock.calls.some((c) => c[0] === "estate released" && String(c[1]).includes(user.id) && String(c[1]).includes(r.audit_key))).toBe(true);

    const u = (await getUserById(user.id))!;
    expect(u.tier).toBe("sandbox");
    expect(u.billing?.status).toBe("canceled");
  });

  it("releases an account that never had a billing record", async () => {
    await setBilling(null);
    await suspendedEstate();
    await releaseSuspendedEstate(user.id, fakeFly() as any, NOW);
    expect(await getEstate(user.id)).toBeNull();
  });

  it("releases once the worker lease has ended and the record has been quiet for RELEASE_QUIET_MS exactly", async () => {
    await suspendedEstate({ worker_until: NOW.toISOString(), updated_at: new Date(NOW.getTime() - RELEASE_QUIET_MS).toISOString() });
    await releaseSuspendedEstate(user.id, fakeFly() as any, NOW);
    expect(await getEstate(user.id)).toBeNull();
  });

  it("asks Fly about the derived app name too when the record names another app", async () => {
    const e = await suspendedEstate({ app: "ff-est-0ddba11c" });
    const fly = fakeFly();
    await releaseSuspendedEstate(user.id, fly as any, NOW);
    expect(fly.asked).toEqual(["ff-est-0ddba11c", newAppName(user.id)]);
    expect(e.app).not.toBe(newAppName(user.id));
  });
});

describe("releaseSuspendedEstate: refusals change nothing", () => {
  it("404 when the account has no estate", async () => {
    const fly = fakeFly();
    expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([404, "no_estate"]);
    expect(fly.asked).toEqual([]);
    expect(await auditKeys()).toEqual([]);
  });

  for (const status of ["ready", "provisioning", "error", "pending_manual"] as const) {
    it(`409 when the estate is ${status}, not suspended`, async () => {
      const e = await suspendedEstate({ status, suspended_from: null, suspended_at: null });
      const fly = fakeFly();
      expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([409, "estate_not_suspended"]);
      expect(fly.asked).toEqual([]);
      await expectUntouched(e);
    });
  }

  it("409 while a suspension is still pending (the machine may be running)", async () => {
    const e = await suspendedEstate({ suspend_pending: { reason: "resume not confirmed", since: "t", attempts: 1, last_error: "machine stop failed", next_retry_at: null, failed: false } });
    expect(await refusal(releaseSuspendedEstate(user.id, fakeFly() as any, NOW))).toEqual([409, "suspend_pending"]);
    await expectUntouched(e);
  });

  it("409 while a resume is pending (a paying customer's machine is about to start)", async () => {
    const e = await suspendedEstate({ resume_pending: { since: "t", attempts: 0, last_error: "", next_retry_at: null, failed: false } });
    expect(await refusal(releaseSuspendedEstate(user.id, fakeFly() as any, NOW))).toEqual([409, "resume_pending"]);
    await expectUntouched(e);
  });

  it("409 while a background worker's lease has not ended (its Fly call may still land), without asking Fly", async () => {
    const e = await suspendedEstate({ worker_until: new Date(NOW.getTime() + 1).toISOString() });
    const fly = fakeFly();
    expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([409, "worker_active"]);
    expect(fly.asked).toEqual([]);
    await expectUntouched(e);
  });

  it("409 while the record was written less than RELEASE_QUIET_MS ago (a driver may be mid-step), without asking Fly", async () => {
    for (const updated_at of [new Date(NOW.getTime() - RELEASE_QUIET_MS + 1).toISOString(), new Date(NOW.getTime() + 60_000).toISOString(), "not a date"]) {
      const e = await suspendedEstate({ updated_at });
      const fly = fakeFly();
      expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([409, "estate_settling"]);
      expect(fly.asked).toEqual([]);
      await expectUntouched(e);
      await store.delete(estateKey(user.id));
    }
  });

  it("404 when the account record cannot be read: billing unknown is a refusal", async () => {
    const e = await suspendedEstate();
    await store.delete("uid/" + user.id);
    const fly = fakeFly();
    expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([404, "no_user"]);
    expect(fly.asked).toEqual([]);
    await expectUntouched(e);
  });

  for (const status of ["active", "trialing", "past_due"]) {
    it(`409 while the subscription is ${status} (a granting status), even on the sandbox tier`, async () => {
      await setBilling(status, "sandbox", { price_unmatched: true });
      const e = await suspendedEstate();
      const fly = fakeFly();
      expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([409, "billing_active"]);
      expect(fly.asked).toEqual([]);
      await expectUntouched(e);
    });
  }

  it("409 while the account is on a paid tier, whatever the mirrored status says", async () => {
    await setBilling("canceled", "operator");
    const e = await suspendedEstate();
    expect(await refusal(releaseSuspendedEstate(user.id, fakeFly() as any, NOW))).toEqual([409, "billing_active"]);
    await expectUntouched(e);
  });

  it("409 while another granting subscription of the customer is remembered", async () => {
    await setBilling("canceled", "sandbox", { other_subs: { sub_2: { status: "active", price_id: "price_op" } } });
    const e = await suspendedEstate();
    expect(await refusal(releaseSuspendedEstate(user.id, fakeFly() as any, NOW))).toEqual([409, "billing_active"]);
    await expectUntouched(e);
  });

  it("billingBlocksRelease allows only a sandbox account with nothing granting", async () => {
    const base = { ...user, tier: "sandbox" as Tier };
    expect(billingBlocksRelease({ ...base, billing: null })).toBeNull();
    expect(billingBlocksRelease({ ...base, billing: { status: "canceled" } as any })).toBeNull();
    expect(billingBlocksRelease({ ...base, billing: { status: "incomplete_expired", other_subs: {} } as any })).toBeNull();
    expect(billingBlocksRelease({ ...base, billing: { status: "active" } as any })).toMatch(/active/);
    expect(billingBlocksRelease({ ...base, tier: "sovereign", billing: null })).toMatch(/paid tier/);
  });

  it("501 when Fly cannot be asked at all (provisioning not configured)", async () => {
    const e = await suspendedEstate();
    expect(await refusal(releaseSuspendedEstate(user.id, null, NOW))).toEqual([501, "provisioning_not_configured"]);
    await expectUntouched(e);
  });

  it("409 when the estate's Fly app still exists", async () => {
    const e = await suspendedEstate();
    const fly = fakeFly({ [e.app]: { name: e.app } });
    expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([409, "fly_app_exists"]);
    expect(fly.asked).toEqual([e.app]);
    await expectUntouched(e);
  });

  it("409 when the record names another app but the derived app exists", async () => {
    const e = await suspendedEstate({ app: "ff-est-0ddba11c" });
    const fly = fakeFly({ [newAppName(user.id)]: { name: "x" } });
    expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([409, "fly_app_exists"]);
    await expectUntouched(e);
  });

  for (const [what, error] of [
    ["answers 500", new FlyError(500, "Fly GET app answered HTTP 500 (Bearer fo1_LEAKME)")],
    ["is unreachable", new FlyError(0, "Fly Machines API unreachable (TimeoutError)")],
    ["throws anything else", new Error("boom")],
  ] as const) {
    it(`502 when Fly ${what}: a failed ask is a refusal, never "no app"`, async () => {
      const e = await suspendedEstate();
      const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const fly = fakeFly({ [e.app]: error });
      expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([502, "fly_check_failed"]);
      await expectUntouched(e);
      expect(JSON.stringify(errLog.mock.calls)).not.toContain("LEAKME"); // the Fly error text stays out of the log
    });
  }

  it("409 when the record changed while Fly was being asked (a writer outside the lock)", async () => {
    await suspendedEstate();
    const fly = fakeFly();
    fly.hook = async () => {
      const other = (await getEstate(user.id))!;
      other.roster = { allowed_scope: ["a.b"], max_ttl_days: 7, max_spend_usd: null };
      await saveEstate(other);
    };
    expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([409, "estate_changed"]);
    const after = (await getEstate(user.id))!;
    expect(after.status).toBe("suspended");
    expect(after.roster.allowed_scope).toEqual(["a.b"]); // the other writer's change is kept
    expect(await auditKeys()).toEqual([]);
    expect(await store.get(markKey())).not.toBeNull();
  });

  it("409 busy while the user lock is held (a webhook or the tick is inside), without asking Fly", async () => {
    const e = await suspendedEstate();
    await store.setJSON("user_locks/" + user.id, { token: "webhook", expires_at: new Date(Date.now() + 60_000).toISOString() });
    const fly = fakeFly();
    expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([409, "busy"]);
    expect(fly.asked).toEqual([]);
    await expectUntouched(e);
  });
});

describe("a released record cannot come back from a stale copy", () => {
  it("saveEstate refuses to re-create it (plain write and owned-fields write)", async () => {
    const stale = await suspendedEstate();
    const stale2 = structuredClone(stale);
    await releaseSuspendedEstate(user.id, fakeFly() as any, NOW);

    stale.status = "provisioning"; // e.g. a worker that read the record before it was suspended and released
    expect(await refusal(saveEstate(stale))).toEqual([409, "estate_released"]);
    stale2.health = { ok: false, checked_at: "t", note: "late look" };
    expect(await refusal(saveEstate(stale2, NOW, { owns: ["health"] }))).toEqual([409, "estate_released"]);
    expect(await getEstate(user.id)).toBeNull();
  });

  it("the tick and its reconcile leave a released account without a record", async () => {
    await suspendedEstate();
    await releaseSuspendedEstate(user.id, fakeFly() as any, NOW);
    const r = await retryPendingSuspend(user.id, fakeFly() as any, NOW, { reverify: true });
    expect(r).toEqual({ outcome: "cleared", estate: null });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    expect((await tickHandler(new Request("http://portal.test/tick"))).status).toBe(200);
    expect(await getEstate(user.id)).toBeNull();
  });

  it("a later subscription queues a NEW record, which saves normally", async () => {
    const old = await suspendedEstate();
    await releaseSuspendedEstate(user.id, fakeFly() as any, NOW);
    const fresh = await queueEstate(user, new Date("2026-12-01T00:00:00.000Z"));
    expect(fresh.status).toBe("provisioning");
    expect(fresh.created_at).not.toBe(old.created_at);
    fresh.step = "allocate_ips";
    expect(await saveEstate(fresh)).toBe(true);
    expect((await getEstate(user.id))!.step).toBe("allocate_ips");
  });

  it("a copy of the released record cannot overwrite the NEW record queued after it", async () => {
    const stale = await suspendedEstate();
    await releaseSuspendedEstate(user.id, fakeFly() as any, NOW);
    const fresh = await queueEstate(user, new Date("2026-12-01T00:00:00.000Z"));
    expect(await refusal(saveEstate(stale))).toEqual([409, "estate_replaced"]);
    expect(await refusal(saveEstate(stale, NOW, { owns: ["health"] }))).toEqual([409, "estate_replaced"]);
    const stored = (await getEstate(user.id))!;
    expect([stored.created_at, stored.status, stored.machine_id]).toEqual([fresh.created_at, "provisioning", null]);
  });

  it("the audit copy is written BEFORE the delete: a delete that fails leaves the record and its audit copy", async () => {
    const e = await suspendedEstate();
    const realDelete = store.delete.bind(store);
    store.delete = async (key: string) => {
      if (key === estateKey(user.id)) throw new Error("blob store down");
      return realDelete(key);
    };
    await expect(releaseSuspendedEstate(user.id, fakeFly() as any, NOW)).rejects.toThrow("blob store down");
    store.delete = realDelete;
    expect(await getEstate(user.id)).toEqual(e); // still suspended, still refused by the gateway
    expect((await store.get(releasedEstateKey(user.id, e.created_at))).estate).toEqual(e);
    expect(await store.get(markKey())).not.toBeNull();
    await releaseSuspendedEstate(user.id, fakeFly() as any, NOW); // repeatable
    expect(await getEstate(user.id)).toBeNull();
  });

  it("an audit copy left by an interrupted release does not block the record that still exists", async () => {
    const e = await suspendedEstate();
    await store.setJSON(releasedEstateKey(user.id, e.created_at), { released_at: "t", estate: e }); // written, then the delete never happened
    e.roster = { allowed_scope: ["a.b"], max_ttl_days: 7, max_spend_usd: null };
    expect(await saveEstate(e, QUEUED_AT)).toBe(true);
    await releaseSuspendedEstate(user.id, fakeFly() as any, NOW); // and the release can simply be repeated
    expect(await getEstate(user.id)).toBeNull();
    expect((await store.get(releasedEstateKey(user.id, e.created_at))).estate.roster.allowed_scope).toEqual(["a.b"]);
  });
});

describe("release against the Stripe webhook (same user lock)", () => {
  const sub = (status: string) => ({ id: "sub_9", status, customer: "cus_1", items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] }, metadata: { user_id: user.id } });
  const active = (id: string) => ({ id, type: "customer.subscription.updated", created: 1_800_000_000, data: { object: sub("active") } });
  const fetchImpl = (async () => new Response(JSON.stringify(sub("active")), { status: 200 })) as any;
  const deps = (fly: unknown) => ({ cfg: stripeConfig()!, fly: fly as any, fetchImpl });

  it("a granting event applied first makes the release refuse; the estate stays for its resume", async () => {
    const e = await suspendedEstate();
    const fly = fakeFly();
    await handleStripeEvent(active("evt_1"), deps(fly));
    expect(await refusal(releaseSuspendedEstate(user.id, fly as any, NOW))).toEqual([409, "resume_pending"]);
    const after = (await getEstate(user.id))!;
    expect(after.created_at).toBe(e.created_at);
    expect(after.resume_pending).toBeTruthy();
    expect(await auditKeys()).toEqual([]);
  });

  it("a granting event applied after the release queues a fresh estate (never the released one)", async () => {
    const e = await suspendedEstate();
    const fly = fakeFly();
    await releaseSuspendedEstate(user.id, fly as any, NOW);
    await handleStripeEvent(active("evt_2"), deps(fly));
    const after = (await getEstate(user.id))!;
    expect(after.status).toBe("provisioning");
    expect(after.created_at).not.toBe(e.created_at);
    expect(after.machine_id).toBeNull();
    expect((await getUserById(user.id))!.tier).toBe("operator");
  });

  it("released concurrently with a granting event: one runs wholly before the other, and a paying user always ends with a record", async () => {
    const e = await suspendedEstate();
    const fly = fakeFly();
    const [rel] = await Promise.allSettled([releaseSuspendedEstate(user.id, fly as any, NOW), handleStripeEvent(active("evt_3"), deps(fly))]);
    const after = (await getEstate(user.id))!;
    expect((await getUserById(user.id))!.tier).toBe("operator");
    expect(after).not.toBeNull();
    if (rel.status === "fulfilled") {
      expect(after.created_at).not.toBe(e.created_at); // released first: the event queued a fresh estate
      expect(after.status).toBe("provisioning");
    } else {
      expect(after.created_at).toBe(e.created_at); // event first: the release was refused and the old estate resumes
      expect((rel.reason as EstateError).code).toMatch(/^(resume_pending|billing_active)$/);
      expect(await auditKeys()).toEqual([]);
    }
  });
});

describe("POST /api/estate/release and the gateway route afterwards", () => {
  let cookie: string;
  let flyStatus: number;
  let seen: { url: string; headers: Headers }[];

  const post = (c: string | null, body: unknown = { confirm: "release" }) =>
    estateHandler(new Request("http://portal.test/api/estate/release", { method: "POST", headers: c ? { cookie: c } : {}, body: typeof body === "string" ? body : JSON.stringify(body) }), ctx);
  const code = async (res: Response) => (await res.json()).error?.code;

  beforeEach(async () => {
    cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
    flyStatus = 404;
    seen = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      seen.push({ url, headers: new Headers(init?.headers) });
      if (url.startsWith("https://api.machines.dev/")) return new Response(flyStatus === 200 ? JSON.stringify({ name: "x" }) : "{}", { status: flyStatus });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
  });

  it("401 without a session", async () => {
    const e = await suspendedEstate();
    const res = await post(null);
    expect(res.status).toBe(401);
    await expectUntouched(e);
  });

  it("400 without the explicit confirmation, and on a body that is not JSON", async () => {
    const e = await suspendedEstate();
    for (const body of [{}, { confirm: true }, { confirm: "yes" }]) {
      const res = await post(cookie, body);
      expect([res.status, await code(res)]).toEqual([400, "confirmation_required"]);
    }
    const bad = await post(cookie, "not json");
    expect([bad.status, await code(bad)]).toEqual([400, "bad_json"]);
    expect(seen).toEqual([]); // Fly was never asked
    await expectUntouched(e);
  });

  it("owner only: another signed-in account cannot release it, whatever its body says", async () => {
    const e = await suspendedEstate();
    const other = await createUser("other@example.com", "sufficiently-long-pass");
    const otherCookie = sessionCookie(await issueSession(other.id)).split(";")[0];
    const res = await post(otherCookie, { confirm: "release", user_id: user.id, userId: user.id });
    expect([res.status, await code(res)]).toEqual([404, "no_estate"]);
    await expectUntouched(e);
  });

  it("409 and nothing changed while the Fly app exists; 502 when Fly fails; 501 when Fly is not configured", async () => {
    const e = await suspendedEstate();
    vi.spyOn(console, "error").mockImplementation(() => {});
    flyStatus = 200;
    const exists = await post(cookie);
    expect([exists.status, await code(exists)]).toEqual([409, "fly_app_exists"]);
    flyStatus = 500;
    const failed = await post(cookie);
    expect([failed.status, await code(failed)]).toEqual([502, "fly_check_failed"]);
    delete process.env.FLY_API_TOKEN;
    const off = await post(cookie);
    expect([off.status, await code(off)]).toEqual([501, "provisioning_not_configured"]);
    await expectUntouched(e);
  });

  it("the suspended account is refused by the gateway, released by its owner, and then reaches the shared sandbox with the same key", async () => {
    const e = await suspendedEstate();
    const key = (await issueKey((await getUserById(user.id))!, "v4")).plaintext;
    const call = () => gatewayHandler(new Request("http://portal.test/api/v1/health?x=1", { headers: { "x-api-key": key, "x-field-agent-id": "svc-verifier" } }), ctx);

    const before = await call();
    expect([before.status, await code(before)]).toEqual([403, "estate_suspended"]);
    expect(seen).toEqual([]); // nothing upstream was touched

    const res = await post(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ released: true, estate: null, route: "sandbox" });
    expect(seen.map((s) => s.url)).toEqual([`https://api.machines.dev/v1/apps/${e.app}`]);

    const status = await estateHandler(new Request("http://portal.test/api/estate", { headers: { cookie } }), ctx);
    expect((await status.json()).estate).toBeNull();

    seen.length = 0;
    const after = await call();
    expect(after.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://sandbox.example/health?x=1");
    expect(seen[0].headers.get("x-field-auth")).toBe("sandbox-secret");
    expect(seen[0].headers.get("x-ff-tenant")).toBe(user.id);
    expect(seen[0].headers.get("x-field-agent-id")).toBe("svc-verifier");

    const again = await post(cookie); // a second click: nothing left to release
    expect([again.status, await code(again)]).toEqual([404, "no_estate"]);
  });
});
