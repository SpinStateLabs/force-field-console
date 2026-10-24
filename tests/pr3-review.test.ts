// Review follow-ups for the durable-suspend PR: machine-config writers vs a cancellation, resume
// failure states, a gone machine, the user's current subscription, and the model-based gaps.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ModelFly, RICH_CONFIG } from "./model-fly";
import { freshStore } from "./helpers";
import { createUser, getUserById, saveUser, type User } from "../src/lib/users";
import { stripeConfig } from "../src/lib/stripe";
import { handleStripeEvent, retryPendingSuspend } from "../src/lib/billing";
import { withAutostart } from "../src/lib/fly";
import { renewSelfAgents } from "../src/lib/renewal";
import {
  advanceEstate,
  getEstate,
  queueEstate,
  readback,
  resumeEstate,
  retryEstate,
  saveEstate,
  setEstateAnthropicKey,
  suspendEstate,
  upgradeEstateImage,
  type Estate,
} from "../src/lib/estates";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STRIPE_ENV = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov" };
const FLY_ENV = { FLY_API_TOKEN: "fo1_test", FLY_ORG_SLUG: "personal", FLY_ESTATE_IMAGE: "registry.fly.io/x:new", ESTATE_SECRET_MASTER: "master-0123456789" };

function sub(id: string, status: string, userId: string) {
  return { id, status, customer: "cus_1", items: { data: [{ price: { id: "price_op" }, current_period_end: 1_800_000_000 }] }, metadata: { user_id: userId } };
}
const ev = (id: string, type: string, created: number, s: any) => ({ id, type, created, data: { object: s } });

let user: User;
let fly: ModelFly;
const origDelay = readback.delayMs;
beforeEach(async () => {
  freshStore();
  Object.assign(process.env, STRIPE_ENV, FLY_ENV);
  readback.delayMs = 5;
  user = await createUser("pr3@example.com", "sufficiently-long-pass");
  fly = new ModelFly();
});
afterEach(() => {
  readback.delayMs = origDelay;
  for (const k of [...Object.keys(STRIPE_ENV), ...Object.keys(FLY_ENV)]) delete process.env[k];
});

async function payingUser(subId = "sub_1") {
  user.tier = "operator";
  user.billing = { customer_id: "cus_1", subscription_id: subId, status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: "t" };
  await saveUser(user);
}

async function estate(over: Partial<Estate> = {}) {
  const e = await queueEstate(user);
  Object.assign(
    e,
    {
      status: "ready",
      step: "done",
      machine_id: "m_1",
      volume_id: "vol_1",
      url: `https://${e.app}.fly.dev`,
      image: "registry.fly.io/x:old",
      fingerprints: { "ledger-sign": "fs" },
    },
    over,
  );
  await saveEstate(e);
  return e;
}

const armedHealth = (async (u: any) => {
  const p = new URL(String(u)).pathname;
  const b: Record<string, any> = {
    "/ledger/health": { signing: "on", require_signing: true, appendable: true, key_fingerprint: "fs" },
    "/gateway/health": { enforce: true, tool_check: true },
    "/attest/health": { signing: "on" },
  };
  return new Response(JSON.stringify(b[p] ?? {}), { status: b[p] ? 200 : 503 });
}) as any;

describe("MED 1: machine-config writers cannot undo a completed suspend", () => {
  const paths: Record<string, (e: Estate) => Promise<unknown>> = {
    renewSelfAgents: (e) => renewSelfAgents(e, fly as any),
    setEstateAnthropicKey: (e) => setEstateAnthropicKey(e, fly as any, "sk-ant-" + "a".repeat(40)),
    upgradeEstateImage: (e) => upgradeEstateImage(e, fly as any, { force: true, polls: 2, sleepMs: 1, fetchImpl: armedHealth }),
    "arm step": async (e) => {
      e.status = "provisioning";
      e.step = "arm";
      await saveEstate(e);
      return advanceEstate((await getEstate(e.user_id))!, fly as any, { fetchImpl: armedHealth });
    },
  };

  for (const [name, run] of Object.entries(paths)) {
    it(`${name}: a cancellation arriving while its slow update is in flight ends with a stopped machine, autostart off and the record suspended`, async () => {
      await payingUser();
      const e = await estate();
      fly.machine("m_1").config = RICH_CONFIG();
      fly.updateDelayOnce = 80;
      const writer = run(e).catch(() => null);
      await sleep(15);
      await handleStripeEvent(ev("e_del", "customer.subscription.deleted", 200, sub("sub_1", "canceled", user.id)), { cfg: stripeConfig()!, fly: fly as any });
      await writer;
      const stored = (await getEstate(user.id))!;
      expect(stored.status).toBe("suspended");
      expect(fly.machine("m_1").state).toBe("stopped");
      expect(fly.autostartOff("m_1")).toBe(true);
      expect(fly.ping("m_1")).toBe("stopped");
    });

    it(`${name}: refuses outright on a suspended estate (no machine write)`, async () => {
      await payingUser();
      const e = await estate();
      await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
      fly.log.length = 0;
      const cur = (await getEstate(user.id))!;
      if (name === "arm step") {
        const r = await advanceEstate({ ...cur, status: "provisioning", step: "arm" } as Estate, fly as any, { fetchImpl: armedHealth });
        expect(r.outcome === "idle" || r.estate.status === "suspended").toBe(true);
      } else if (name === "upgradeEstateImage") {
        await expect(run({ ...cur, status: "ready" } as Estate)).rejects.toThrow(/suspended/);
      } else {
        await expect(run({ ...cur, status: "ready" } as Estate)).rejects.toThrow(/suspended/);
      }
      expect(fly.log.filter((l) => l.startsWith("update"))).toEqual([]);
      expect(fly.ping("m_1")).toBe("stopped");
      expect(e.app).toBeTruthy();
    });
  }

  it("a pending suspension also blocks the writers", async () => {
    await payingUser();
    const e = await estate();
    fly.failStop = true;
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    expect((await getEstate(user.id))!.suspend_pending).toBeTruthy();
    fly.log.length = 0;
    await expect(setEstateAnthropicKey(e, fly as any, "sk-ant-" + "a".repeat(40))).rejects.toThrow(/suspend/);
    expect(fly.log.filter((l) => l.startsWith("update"))).toEqual([]);
  });
});

describe("MED 2: resume only starts the machine (it never turns autostart on), so no failure leaves a stopped machine with autostart on", () => {
  it("start fails: the estate stays suspended, the machine stays stopped with autostart off, and no config was written", async () => {
    await estate();
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    fly.log.length = 0;
    fly.failStart = true;
    await expect(resumeEstate((await getEstate(user.id))!, fly as any)).rejects.toThrow();
    expect((await getEstate(user.id))!.status).toBe("suspended");
    expect(fly.machine("m_1").state).toBe("stopped");
    expect(fly.autostartOff("m_1")).toBe(true);
    expect(fly.ping("m_1")).toBe("stopped");
    expect(fly.log.filter((l) => l.startsWith("update"))).toEqual([]);
  });

  it("resume issues the start without any Fly config update (the ~20 s call that outlasted the webhook), and leaves autostart off", async () => {
    await estate();
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    fly.log.length = 0;
    await resumeEstate((await getEstate(user.id))!, fly as any);
    expect(fly.log).toContain("start m_1");
    expect(fly.log.filter((l) => l.startsWith("update"))).toEqual([]);
    expect(fly.machine("m_1").state).toBe("started");
    expect(fly.autostartOff("m_1")).toBe(true);
  });

  it("the start comes first among the Fly calls (a slow later call cannot keep the machine stopped)", async () => {
    await estate();
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    fly.log.length = 0;
    await resumeEstate((await getEstate(user.id))!, fly as any);
    expect(fly.log.findIndex((l) => l === "start m_1")).toBeLessThanOrEqual(1); // at most the existence read before it
  });
});

describe("MED 3: resuming an estate whose machine is gone", () => {
  it("marks it machine_missing (error, visible in health), does not throw, and a retry re-creates on the existing volume without a second provision", async () => {
    await estate();
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    fly.getReturnsNull = true;
    const r = await resumeEstate((await getEstate(user.id))!, fly as any);
    expect(r.status).toBe("error");
    const stored = (await getEstate(user.id))!;
    expect(stored.status).toBe("error");
    expect(stored.error).toMatch(/^machine_missing/);
    expect(stored.health?.ok).toBe(false);
    expect(stored.health?.note).toMatch(/machine_missing/);
    expect(stored.machine_id).toBeNull();
    expect(stored.step).toBe("create_machine");
    expect(stored.volume_id).toBe("vol_1"); // data volume kept
    // the same user again cannot create a second estate record
    expect((await queueEstate(user)).app).toBe(stored.app);
    // an operator retry goes back to provisioning at create_machine
    const again = await retryEstate((await getEstate(user.id))!);
    expect(again.status).toBe("provisioning");
    expect(again.step).toBe("create_machine");
  });
});

describe("MED 4: only the user's CURRENT subscription may suspend or resume", () => {
  it("a late 'deleted' for the old subscription A does not suspend an estate that subscription B pays for", async () => {
    await payingUser("sub_A");
    await estate();
    const deps = { cfg: stripeConfig()!, fly: fly as any };
    await handleStripeEvent(ev("a_cancel", "customer.subscription.updated", 100, sub("sub_A", "canceled", user.id)), deps);
    expect((await getEstate(user.id))!.status).toBe("suspended");
    await handleStripeEvent(ev("b_new", "customer.subscription.created", 150, sub("sub_B", "active", user.id)), deps);
    expect((await getEstate(user.id))!.status).toBe("ready");
    expect((await getUserById(user.id))!.billing!.subscription_id).toBe("sub_B");

    const stops = fly.log.filter((l) => l === "stop m_1").length;
    const late = await handleStripeEvent(ev("a_deleted", "customer.subscription.deleted", 200, sub("sub_A", "canceled", user.id)), deps);
    expect(late.handled).toBe(false);
    expect(late.note).toMatch(/current subscription/);
    expect((await getEstate(user.id))!.status).toBe("ready");
    expect((await getUserById(user.id))!.tier).toBe("operator");
    expect(fly.log.filter((l) => l === "stop m_1").length).toBe(stops);
  });

  it("a second ACTIVE subscription does not displace the current one, but is remembered: when the current one is cancelled it takes over and the estate is NOT suspended", async () => {
    await payingUser("sub_A");
    await estate();
    const fetchImpl = (async (u: any) => new Response(JSON.stringify(sub(String(u).split("/").pop()!, "active", user.id)), { status: 200 })) as any;
    const deps = { cfg: stripeConfig()!, fly: fly as any, fetchImpl };
    const other = await handleStripeEvent(ev("b_new", "customer.subscription.created", 150, sub("sub_B", "active", user.id)), deps);
    expect(other.handled).toBe(false);
    expect((await getUserById(user.id))!.billing!.subscription_id).toBe("sub_A");
    await handleStripeEvent(ev("a_del", "customer.subscription.deleted", 200, sub("sub_A", "canceled", user.id)), deps);
    expect((await getEstate(user.id))!.status).toBe("ready");
    expect((await getUserById(user.id))!.billing!.subscription_id).toBe("sub_B");
    expect((await getUserById(user.id))!.tier).toBe("operator");
    expect(fly.log).not.toContain("stop m_1");
  });
});

describe("model-based gaps: multi-service machines, config preservation, skip_launch, stale reads", () => {
  it("autostart goes off on EVERY service, including one with no autostart field, and the rest of the config survives", async () => {
    await estate();
    fly.machine("m_1").config = RICH_CONFIG();
    const before = RICH_CONFIG();
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    const after = fly.machine("m_1").config;
    expect(after.services.map((s: any) => s.autostart)).toEqual([false, false, false]);
    expect(fly.ping("m_1")).toBe("stopped");
    for (const k of ["image", "env", "checks", "mounts", "guest", "restart", "metadata"]) expect(after[k]).toEqual((before as any)[k]);
    expect(after.services.map((s: any) => ({ ...s, autostart: undefined }))).toEqual(before.services.map((s: any) => ({ ...s, autostart: undefined })));
    // and back: resume only starts the machine - autostart stays off, the rest of the config is untouched
    await resumeEstate((await getEstate(user.id))!, fly as any);
    expect(fly.machine("m_1").state).toBe("started");
    expect(fly.machine("m_1").config.services.map((s: any) => s.autostart)).toEqual([false, false, false]);
    for (const k of ["image", "env", "checks", "mounts", "guest", "restart", "metadata"]) expect(fly.machine("m_1").config[k]).toEqual((before as any)[k]);
  });

  it("withAutostart touches only the services' autostart field", () => {
    const c = RICH_CONFIG();
    const off = withAutostart(c as any, false);
    expect(off.services!.map((s: any) => s.autostart)).toEqual([false, false, false]);
    expect({ ...off, services: undefined }).toEqual({ ...c, services: undefined });
    expect(c.services[0].autostart).toBe(true); // the input is not mutated
  });

  it("a read-back that is stale once after the update is retried, not mistaken for failure", async () => {
    await estate();
    fly.staleReads = 0;
    const orig = fly.updateMachine.bind(fly);
    fly.updateMachine = async (...a: any[]) => {
      const r = await (orig as any)(...a);
      fly.staleReads = 1; // the next read returns the pre-update snapshot
      return r;
    };
    const r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    expect(r.status).toBe("suspended");
    expect(fly.ping("m_1")).toBe("stopped");
  });

  it("a read-back that stays wrong through every try keeps the suspension pending", async () => {
    await estate();
    fly.ignoreUpdate = true;
    const r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    expect(r.status).toBe("ready");
    expect(r.suspend_pending).toBeTruthy();
    expect(fly.log.filter((l) => l === "get m_1").length).toBeGreaterThanOrEqual(1 + readback.tries);
  });

  it("a machine whose only service has no autostart field (Fly default: on) is still switched off explicitly", async () => {
    await estate();
    fly.machine("m_1").config = { image: "img", services: [{ internal_port: 8080 }] };
    expect(fly.ping("m_1")).toBe("started");
    const r = await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    expect(r.status).toBe("suspended");
    expect(fly.machine("m_1").config.services[0].autostart).toBe(false);
    expect(fly.ping("m_1")).toBe("stopped");
  });

  it("slow waits do not break the sequence; a running machine is updated WITHOUT skip_launch, a stopped one WITH", async () => {
    await estate();
    fly.waitDelay = 30;
    await suspendEstate((await getEstate(user.id))!, fly as any, new Date(), "canceled");
    expect(fly.log).toContain("update m_1 autostart=false skip=false");
    const other = await createUser("pr3b@example.com", "sufficiently-long-pass");
    const e2 = await queueEstate(other);
    Object.assign(e2, { status: "ready", step: "done", machine_id: "m_2" });
    await saveEstate(e2);
    fly.machine("m_2", { state: "stopped", autostart: true });
    await suspendEstate((await getEstate(other.id))!, fly as any, new Date(), "canceled");
    expect(fly.log).toContain("update m_2 autostart=false skip=true");
    expect(fly.restarts).toBe(1); // only the running machine was restarted by its update
  });
});
