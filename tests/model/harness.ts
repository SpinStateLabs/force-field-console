// Runs one Scenario against the REAL portal code (netlify/functions/billing.mts webhook handler,
// netlify/functions/estate-tick.mts, the estate library's dashboard drivers) in virtual time, behind
// the HTTP-level Fly / Stripe model (net.ts) and the Blobs-contract store model (model-store.ts).
// Then drives the system to quiescence (Stripe redelivers until 2xx or its 3-day window ends; the
// tick runs every 2 minutes; time jumps over backoffs) and checks the spec's invariants.
import { clock } from "./vclock";
import { Net, NO_FLY_FAULTS, mulberry32, type FMachine, type Rng, type StripeSub } from "./net";
import { installModelStore, type ModelStore } from "./model-store";
import type { Action, Scenario, StripeOp, SubStatus } from "./scenario";
import { describeAction } from "./scenario";
import billingHandler from "../../netlify/functions/billing.mts";
import tickHandler from "../../netlify/functions/estate-tick.mts";
import healthHandler from "../../netlify/functions/health.mts";
import { emailKey, type User } from "../../src/lib/users";
import { signPayload } from "../../src/lib/stripe";
import {
  advanceEstate,
  attestSigner,
  estateKey,
  getEstate,
  newAppName,
  publicEstate,
  queueEstate,
  resolveRoute,
  retryEstate,
  saveEstate,
  setEstateAnthropicKey,
  upgradeEstateImage,
  type Estate,
} from "../../src/lib/estates";
import { estateMachineConfig, estateOrigin, flyClientOrNull, flyConfig } from "../../src/lib/fly";

export const T0 = Date.parse("2026-10-24T12:00:00.000Z");
const WHSEC = "whsec_model_test_only";
export const MODEL_ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: "sk_test_model_only",
  STRIPE_WEBHOOK_SECRET: WHSEC,
  STRIPE_PRICE_OPERATOR: "price_op",
  STRIPE_PRICE_SOVEREIGN: "price_sov",
  FLY_API_TOKEN: "fo1_LEAKME_model_token_only",
  FLY_ORG_SLUG: "model-org",
  FLY_ESTATE_IMAGE: "registry.fly.io/ff-estate:v1",
  ESTATE_SECRET_MASTER: "model-master-0123456789",
  SESSION_SECRET: "test-secret-0123456789",
};
const GRANTING = new Set(["active", "trialing", "past_due"]);
/** What must never reach users (publicEstate, /api/health, ALERT lines). Mirrors tests/model-fly.ts FLY_LEAK_RE plus the model token. */
export const LEAK_RE = /fo1_|Bearer|api\.machines\.dev|\/apps\/|answered|HTTP \d{3}|LEAKME|sk_test_|whsec_/;

export type Violation = { inv: string; key: string; detail: string; at: number };

type Ev = {
  idx: number;
  id: string;
  type: string;
  created: number;
  payload: any;
  u: number;
  attempts: number;
  delivered: boolean;
  lostAsDuplicate: boolean;
  givenUp: boolean;
  nextAt: number;
  inFlight: boolean;
  firstAt: number;
};

type Pending = { ev: Ev; inv: ReturnType<typeof clock.invoke>; processed: boolean };

export type CaseResult = {
  violations: Violation[];
  rounds: number;
  virtualMs: number;
  flyCalls: number;
  storeOps: number;
  events: number;
  lost: number;
  billingAfterCancelMs: number[];
  trace: string[];
};

let currentNet: Net | null = null;
let fetchInstalled = false;
let realFetch: typeof fetch | null = null;
const alerts: string[] = [];

/** Install the per-case dispatcher once (FlyClient captures globalThis.fetch at construction). */
export function installGlobals(): void {
  if (fetchInstalled) return;
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    if (!currentNet) throw new Error("model: no network installed");
    return currentNet.fetch(input, init);
  }) as any;
  for (const [k, v] of Object.entries(MODEL_ENV)) process.env[k] = v;
  delete process.env.URL; // no background-worker kick: the tick falls back to one synchronous step
  delete process.env.CONTEXT;
  const quiet = () => {};
  console.log = quiet;
  console.warn = quiet;
  console.info = quiet;
  console.error = (...a: any[]) => {
    const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    if (s.startsWith("ALERT")) alerts.push(s);
  };
  fetchInstalled = true;
}

const subId = (u: number, s: number) => `sub_u${u}_${s}`;
const userId = (u: number) => `user-${u}`;
const cust = (u: number) => `cus_u${u}`;
const priceId = (p: string) => (p === "sov" ? "price_sov" : "price_op");
const TERMINAL = new Set(["canceled", "incomplete_expired"]);

export class World {
  net = new Net();
  store!: ModelStore;
  rng: Rng;
  events: Ev[] = [];
  pending: Pending[] = [];
  violations: Violation[] = [];
  /** per user: virtual time Stripe last turned the user non-granting (null while granting) */
  cancelAt: (number | null)[] = [];
  trace: string[] = [];
  evSeq = 0;
  appToUser = new Map<string, number>();
  traceOn: boolean;

  constructor(public sc: Scenario, opts: { trace?: boolean } = {}) {
    this.rng = mulberry32(sc.seed);
    this.traceOn = Boolean(opts.trace);
  }

  log(s: string) {
    if (this.traceOn) this.trace.push(`${new Date(clock.now).toISOString().slice(11, 23)} ${s}`);
  }

  violate(inv: string, key: string, detail: string) {
    if (this.violations.some((v) => v.inv === inv && v.key === key)) return;
    this.violations.push({ inv, key, detail, at: clock.now - T0 });
    this.log(`VIOLATION ${inv} ${key}: ${detail}`);
  }

  // ------------------------------------------------------------------ setup
  async setup(): Promise<void> {
    installGlobals();
    clock.install(T0);
    this.store = installModelStore();
    process.env.FLY_ESTATE_IMAGE = MODEL_ENV.FLY_ESTATE_IMAGE;
    const r = this.rng;
    this.store.latency = () => 0; // setup runs outside the virtual scheduler
    this.net.rng = r;
    this.net.traceOn = this.traceOn;
    this.net.trace = this.trace;
    currentNet = this.net;
    alerts.length = 0;
    this.net.onApply = (op, app, m, info) => this.onFlyApply(op, app, m, info);
    const cfg = flyConfig()!;
    for (let u = 0; u < this.sc.users.length; u++) {
      const id = userId(u);
      const email = `u${u}@model.test`;
      this.appToUser.set(newAppName(id), u);
      const user: User = { id, email, pw_hash: "x", tier: "sandbox", created_at: new Date(T0).toISOString(), keys: [], billing: null };
      this.cancelAt.push(null);
      if (this.sc.users[u] === "ready") {
        // a paying customer on sub 1 with a provisioned, armed, running estate
        user.tier = "operator";
        user.billing = { customer_id: cust(u), subscription_id: subId(u, 1), status: "active", price_id: "price_op", tier: "operator", current_period_end: null, updated_at: new Date(T0).toISOString() };
        this.net.subs.set(subId(u, 1), { id: subId(u, 1), customer: cust(u), status: "active", price: "price_op", user_meta: id, created: Math.floor(T0 / 1000) - 86400 });
        await this.store.inner.setJSON("stripe_customers/" + cust(u), { user_id: id });
      }
      await this.store.inner.setJSON(emailKey(email), user);
      await this.store.inner.setJSON("uid/" + id, { email_key: emailKey(email) });
      if (this.sc.users[u] === "ready") {
        const e = await queueEstate(user, new Date(T0));
        const a = this.net.app(e.app);
        a.volumes.push({ id: `vol_${e.app}_1`, name: "ff_data" });
        a.ips.push({ address: "2a09::1", type: "v6" });
        a.shared = "137.66.0.1";
        const m = this.net.addMachine(e.app, estateMachineConfig(cfg, `vol_${e.app}_1`, "armed", attestSigner(e.grantor)), "started");
        Object.assign(e, {
          status: "ready",
          step: "done",
          machine_id: m.id,
          volume_id: `vol_${e.app}_1`,
          url: estateOrigin(e.app),
          ips: ["137.66.0.1", "2a09::1"],
          image: cfg.image,
          posture: { enforce: true, tool_check: true, require_signing: true, attest_signing: true },
          fingerprints: { "ledger-sign": "fp-ledger" },
          self_agents: Object.fromEntries(["conformance-sentinel", "force-gateway", "compliance-crosswalk"].map((k) => [k, { provisioned_at: new Date(T0).toISOString() }])),
          ready_at: new Date(T0).toISOString(),
        } satisfies Partial<Estate>);
        await saveEstate(e, new Date(T0));
      }
    }
    this.store.latency = () => 1 + Math.floor(r() * 25);
  }

  // ------------------------------------------------------------------ monitors
  private estateRaw(u: number): Estate | null {
    return ((this.store.inner as any).map.get(estateKey(userId(u))) as Estate | undefined) ?? null;
  }

  onFlyApply(op: string, app: string, m: FMachine | null, info: { issuedAt: number; callerGone: boolean; cfg?: any }) {
    const u = this.appToUser.get(app);
    if (u === undefined) return;
    const a = this.net.apps.get(app)!;
    if (op === "create_machine") {
      const live = [...a.machines.values()].filter((x) => x.state !== "destroyed");
      if (live.length > 1) this.violate("S2", "second-machine", `app ${app} has ${live.length} machines`);
    }
    if (op === "create_volume" && a.volumes.length > 1) this.violate("S2", "second-volume", `app ${app} has ${a.volumes.length} volumes`);
    const e = this.estateRaw(u);
    const suspendedOrPending = Boolean(e && (e.status === "suspended" || e.suspend_pending));
    if (op === "update" && info.cfg && !Net.autostartOff(info.cfg) && suspendedOrPending) {
      this.violate(
        "S6",
        info.callerGone ? "late-autostart-on-update" : "autostart-on-update-while-suspended",
        `an update with autostart ON landed on ${app} (machine -> ${m?.state}) while the record was ${e!.status}${e!.suspend_pending ? "+suspend_pending" : ""}; issued ${(clock.now - info.issuedAt) / 1000}s earlier, caller ${info.callerGone ? "already gone" : "waiting"}`,
      );
    }
  }

  // ------------------------------------------------------------------ Stripe side
  private granting(u: number): boolean {
    for (const s of this.net.subs.values()) if (s.customer === cust(u) && GRANTING.has(s.status) && (s.price === "price_op" || s.price === "price_sov")) return true;
    return false;
  }

  private subObject(s: StripeSub): any {
    return {
      id: s.id,
      object: "subscription",
      status: s.status,
      customer: s.customer,
      items: { data: [{ price: { id: s.price }, current_period_end: 1_900_000_000 }] },
      metadata: s.user_meta ? { user_id: s.user_meta } : {},
    };
  }

  private emit(u: number, type: string, object: any) {
    const idx = this.events.length;
    const ev: Ev = { idx, id: `evt_${++this.evSeq}`, type, created: Math.floor(clock.now / 1000), payload: null, u, attempts: 0, delivered: false, lostAsDuplicate: false, givenUp: false, nextAt: clock.now, inFlight: false, firstAt: clock.now };
    ev.payload = { id: ev.id, object: "event", type, created: ev.created, data: { object } };
    this.events.push(ev);
    this.log(`stripe emits #${idx} ${ev.id} ${type} ${object.id ?? ""} ${object.status ?? ""} created=${ev.created}`);
  }

  applyStripe(op: StripeOp) {
    const u = op.u % this.sc.users.length;
    const before = this.granting(u);
    const id = subId(u, op.sub);
    const existing = this.net.subs.get(id);
    const hasAny = [...this.net.subs.values()].some((s) => s.customer === cust(u));
    if (op.k === "checkout" || op.k === "newsub" || !existing) {
      if (existing) return; // a subscription id is created once
      const viaCheckout = op.k === "checkout" || !hasAny || (op.k !== "newsub");
      const status: SubStatus = op.k === "newsub" ? op.status : "active";
      const price = "price" in op ? priceId(op.price) : "price_op";
      const meta = op.k === "newsub" ? op.meta : true;
      const s: StripeSub = { id, customer: cust(u), status, price, user_meta: viaCheckout || meta ? userId(u) : null, created: Math.floor(clock.now / 1000) };
      this.net.subs.set(id, s);
      this.emit(u, "customer.subscription.created", this.subObject(s));
      if (viaCheckout && status !== "incomplete") {
        this.emit(u, "checkout.session.completed", { id: "cs_" + id, object: "checkout.session", mode: "subscription", subscription: id, customer: cust(u), client_reference_id: userId(u), metadata: { user_id: userId(u) } });
      }
    } else if (op.k === "status") {
      if (TERMINAL.has(existing.status) || existing.status === op.status) return;
      if (op.status === "incomplete") return; // only an initial status
      existing.status = op.status;
      this.emit(u, op.status === "canceled" ? "customer.subscription.deleted" : "customer.subscription.updated", this.subObject(existing));
    } else if (op.k === "plan") {
      if (TERMINAL.has(existing.status) || existing.price === priceId(op.price)) return;
      existing.price = priceId(op.price);
      this.emit(u, "customer.subscription.updated", this.subObject(existing));
    }
    const after = this.granting(u);
    if (before && !after) this.cancelAt[u] = clock.now;
    if (after) this.cancelAt[u] = null;
  }

  // ------------------------------------------------------------------ invocations
  deliver(ev: Ev, limitMs: number, crashAt: number | null) {
    ev.attempts += 1;
    ev.inFlight = true;
    const raw = JSON.stringify(ev.payload);
    const sig = signPayload(raw, WHSEC, Math.floor(clock.now / 1000));
    const inv = clock.invoke(
      "webhook",
      `${ev.id} try ${ev.attempts}`,
      async () => {
        const res = await billingHandler(new Request("https://portal.test/api/billing/webhook", { method: "POST", body: raw, headers: { "stripe-signature": sig } }), {} as any);
        const body = await res.json().catch(() => ({}));
        // the claim as it stood when this answer was given (a 200 duplicate for a claim still "processing")
        const claim = (this.store.inner as any).map.get("stripe_events/" + ev.id) ?? null;
        return { status: res.status, body, claimAtReply: claim?.status ?? null };
      },
      { limitMs, killAtOp: crashAt },
    );
    this.pending.push({ ev, inv, processed: false });
    this.log(`deliver ${ev.id} (#${ev.idx} ${ev.type}) try ${ev.attempts}${crashAt !== null ? " crash@" + crashAt : ""}`);
  }

  processOutcomes() {
    for (const p of this.pending) {
      if (p.processed) continue;
      const inv = p.inv;
      if (!inv.done && !inv.dead) continue;
      p.processed = true;
      const ev = p.ev;
      ev.inFlight = this.pending.some((q) => q !== p && q.ev === ev && !q.processed);
      const r = inv.done && !inv.error ? inv.result : null;
      const ok = r && r.status >= 200 && r.status < 300;
      this.log(`  -> ${ev.id} ${inv.dead ? "KILLED " + inv.killedBy : inv.error ? "THREW " + String(inv.error?.message ?? inv.error).slice(0, 80) : r.status + " " + JSON.stringify(r.body).slice(0, 140)}`);
      if (ok) {
        if (!ev.delivered && r.body?.duplicate && r.claimAtReply === "processing") {
          // Stripe counts this 2xx as delivered; the event is applied only if the in-flight attempt succeeds
          ev.lostAsDuplicate = true;
        }
        if (!r.body?.duplicate) ev.lostAsDuplicate = false;
        ev.delivered = true;
      } else if (!ev.delivered) {
        // Stripe retries a failed delivery with backoff for up to 3 days
        const delay = this.sc.stripeRetryMs * 2 ** Math.min(ev.attempts - 1, 12);
        ev.nextAt = Math.max(ev.nextAt, clock.now + delay);
        if (ev.nextAt - ev.firstAt > 3 * 86_400_000) ev.givenUp = true;
      }
    }
  }

  private invokeWith(kind: string, label: string, fn: () => Promise<any>, crashAt: number | null = null, limitMs = 60_000) {
    return clock.invoke(kind, label, async () => {
      try {
        return await fn();
      } catch (e) {
        return { threw: String((e as any)?.message ?? e).slice(0, 120) };
      }
    }, { limitMs, killAtOp: crashAt });
  }

  tick(crashAt: number | null = null) {
    this.log("tick" + (crashAt !== null ? " crash@" + crashAt : ""));
    return clock.invoke("tick", "tick", async () => (await tickHandler(new Request("https://portal.test/.netlify/functions/estate-tick", { method: "POST", body: "{}" }))).json(), { limitMs: 30_000, killAtOp: crashAt });
  }

  async runAction(a: Action) {
    this.log("ACTION " + describeAction(a));
    const nU = this.sc.users.length;
    switch (a.k) {
      case "stripe":
        this.applyStripe(a.op);
        break;
      case "deliver": {
        if (this.events.length) this.deliver(this.events[a.ev % this.events.length], a.limitMs, a.crashAt);
        break;
      }
      case "tick":
        this.tick(a.crashAt);
        break;
      case "poll": {
        const id = userId(a.u % nU);
        this.invokeWith("poll", "poll " + id, async () => {
          const e = await getEstate(id);
          if (!e) return null;
          const fly = flyClientOrNull();
          if (!fly) return null;
          return (await advanceEstate(e, fly)).outcome;
        }, a.crashAt);
        break;
      }
      case "key": {
        const id = userId(a.u % nU);
        this.invokeWith("key", "key " + id, async () => {
          const e = await getEstate(id);
          if (!e || e.status !== "ready") return null;
          await setEstateAnthropicKey(e, flyClientOrNull()!, "sk-ant-" + "a".repeat(40));
          return "set";
        });
        break;
      }
      case "upgrade": {
        const id = userId(a.u % nU);
        process.env.FLY_ESTATE_IMAGE = "registry.fly.io/ff-estate:v2";
        this.invokeWith("upgrade", "upgrade " + id, async () => {
          const e = await getEstate(id);
          if (!e || e.status !== "ready" || e.suspend_pending) return null;
          return (await upgradeEstateImage(e, flyClientOrNull()!, { polls: 6, sleepMs: 5000 })).outcome;
        }, null, 15 * 60_000);
        break;
      }
      case "retry": {
        const id = userId(a.u % nU);
        this.invokeWith("retry", "retry " + id, async () => {
          const e = await getEstate(id);
          if (!e || e.status !== "error") return null;
          await retryEstate(e);
          return (await advanceEstate(e, flyClientOrNull())).outcome;
        });
        break;
      }
      case "proxy": {
        this.net.proxyHit(newAppName(userId(a.u % nU)));
        break;
      }
      case "pstop":
        this.net.platformStop(newAppName(userId(a.u % nU)));
        break;
      case "fault":
        this.net.faults = { ...NO_FLY_FAULTS(), ...a.f };
        this.net.stripeFaults.pTimeout = a.stripeTimeout;
        break;
      case "jump":
        await clock.runUntil(clock.now + a.ms);
        this.processOutcomes();
        break;
    }
    const gap = "gap" in a ? a.gap : 0;
    if (gap > 0) await clock.runUntil(clock.now + gap);
    else await clock.flush();
    this.processOutcomes();
    await this.checkAlways();
  }

  // ------------------------------------------------------------------ checks
  private async checkAlways() {
    for (let u = 0; u < this.sc.users.length; u++) {
      const e = this.estateRaw(u);
      if (!e) continue;
      const pub = JSON.stringify(publicEstate(e, new Date(clock.now)));
      const m = LEAK_RE.exec(pub);
      if (m) this.violate("S5", "leak-public-estate", `publicEstate contains ${JSON.stringify(m[0])}: ${pub.slice(Math.max(0, m.index - 80), m.index + 60)}`);
    }
    for (const a of alerts) {
      const m = LEAK_RE.exec(a);
      if (m) this.violate("S5", "leak-alert", `ALERT line contains ${m[0]}`);
    }
  }

  private sig(): string {
    const out: any[] = [];
    for (let u = 0; u < this.sc.users.length; u++) {
      const e = this.estateRaw(u);
      const usr = this.userRaw(u);
      const m = this.net.machineByApp(newAppName(userId(u)));
      out.push([usr?.tier, usr?.billing?.status, usr?.billing?.subscription_id, e?.status, e?.step, !!e?.suspend_pending, !!e?.resume_pending, m?.state, m ? Net.autostartOff(m.config) : null]);
    }
    return JSON.stringify(out);
  }

  private userRaw(u: number): User | null {
    const map = (this.store.inner as any).map as Map<string, any>;
    return (map.get(emailKey(`u${u}@model.test`)) as User | undefined) ?? null;
  }

  private workPending(): boolean {
    if (this.events.some((e) => !e.delivered && !e.givenUp)) return true;
    if (clock.liveInvocations().length) return true;
    for (let u = 0; u < this.sc.users.length; u++) {
      const e = this.estateRaw(u);
      if (!e) continue;
      if (e.status === "provisioning") return true;
      for (const p of [e.suspend_pending, e.resume_pending]) if (p && (!p.failed || p.next_retry_at)) return true;
    }
    return false;
  }

  private nextDue(): number | null {
    let t: number | null = null;
    const take = (x: number) => (t = t === null ? x : Math.min(t, x));
    for (const e of this.events) if (!e.delivered && !e.givenUp && !e.inFlight) take(e.nextAt);
    for (let u = 0; u < this.sc.users.length; u++) {
      const e = this.estateRaw(u);
      for (const p of [e?.suspend_pending, e?.resume_pending]) if (p?.next_retry_at) take(Date.parse(p.next_retry_at));
    }
    return t;
  }

  async quiesce(): Promise<number> {
    this.net.faults = NO_FLY_FAULTS();
    this.net.stripeFaults.pTimeout = 0;
    this.log("QUIESCE");
    let last = "";
    let stable = 0;
    let round = 0;
    // events the scenario never delivered: Stripe delivers them now, in a seeded random order
    const never = this.events.filter((e) => e.attempts === 0);
    for (let i = never.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [never[i], never[j]] = [never[j], never[i]];
    }
    for (const e of never) this.deliver(e, 60_000, null);
    for (; round < 160; round++) {
      for (const e of this.events) if (!e.delivered && !e.givenUp && !e.inFlight && e.nextAt <= clock.now) this.deliver(e, 60_000, null);
      this.tick();
      await clock.runUntil(clock.now + 120_000);
      this.processOutcomes();
      await this.checkAlways();
      const s = this.sig();
      const busy = this.workPending();
      const changed = s !== last;
      last = s;
      if (!changed && !busy) {
        if (++stable >= 3) break;
      } else stable = 0;
      if (!changed) {
        const due = this.nextDue();
        if (due !== null && due > clock.now + 120_000) {
          await clock.runUntil(due - 1);
          this.processOutcomes();
        }
      }
    }
    if (round >= 160) this.violate("Q", "no-quiescence", `not stable after ${round} rounds: ${this.sig()}`);
    return round;
  }

  async finalCheck(): Promise<void> {
    const now = new Date(clock.now);
    this.store.latency = () => 0; // the checker runs outside the scheduler
    for (let u = 0; u < this.sc.users.length; u++) {
      const G = this.granting(u);
      const usr = this.userRaw(u);
      const e = this.estateRaw(u);
      const app = newAppName(userId(u));
      const a = this.net.apps.get(app);
      const machines = a ? [...a.machines.values()].filter((x) => x.state !== "destroyed") : [];
      const lost = this.events.filter((x) => x.u === u && x.lostAsDuplicate);
      const lostNote = lost.length ? ` [events answered 200 duplicate while their claim was still processing: ${lost.map((x) => x.id + " " + x.type).join(", ")}]` : "";
      const gaveUp = this.events.filter((x) => x.u === u && x.givenUp);
      const gaveNote = gaveUp.length ? ` [Stripe gave up on ${gaveUp.map((x) => x.id).join(",")}]` : "";
      const state = `user tier=${usr?.tier} billing=${usr?.billing?.subscription_id}:${usr?.billing?.status} others=${JSON.stringify(usr?.billing?.other_subs ?? {})}; estate=${e ? `${e.status}/${e.step} sp=${!!e.suspend_pending} rp=${!!e.resume_pending} err=${e.error ?? ""}` : "none"}; machines=${machines.map((m) => `${m.id}:${m.state}:autostart_${Net.autostartOff(m.config) ? "off" : "ON"}`).join(",") || "none"}${lostNote}${gaveNote}`;
      if (machines.length > 1) this.violate("S2", "second-machine", state);
      if (a && a.volumes.length > 1) this.violate("S2", "second-volume", state);
      if (G) {
        if (!usr || usr.tier === "sandbox") this.violate("S4", "paying-user-sandbox-tier", state);
        if (!e) this.violate("L1", "paying-no-estate", state);
        else if (e.status === "error") this.violate("L4", "paying-estate-error:" + String(e.error ?? "").split(":")[0].slice(0, 40), state);
        else {
          if (e.status !== "ready" || e.suspend_pending || e.resume_pending) this.violate("L1", `paying-not-ready:${e.status}${e.suspend_pending ? "+sp" : ""}${e.resume_pending ? "+rp" : ""}`, state);
          const m = machines[0];
          if (!m || m.state !== "started") this.violate("L1", "paying-machine-not-running:" + (m?.state ?? "none"), state);
          if (usr) {
            const route = resolveRoute(usr, e);
            if (route.kind !== "estate") this.violate("L1", "paying-route-" + route.kind + ("code" in route ? ":" + route.code : ""), state);
          }
        }
      } else {
        if (usr && usr.tier !== "sandbox") this.violate("S3", "cancelled-user-paid-tier", state);
        for (const m of machines) {
          if (m.state !== "stopped") this.violate("S1", `cancelled-machine-${m.state}:record-${e?.status ?? "none"}${e?.suspend_pending ? "+sp" : ""}`, state);
          else if (!Net.autostartOff(m.config)) this.violate("S1", `cancelled-machine-autostart-on:record-${e?.status ?? "none"}`, state);
        }
        if (e && (e.suspend_pending || e.resume_pending)) this.violate("L2", `cancelled-flags-left:${e.suspend_pending ? "sp" : ""}${e.resume_pending ? "rp" : ""}${e.suspend_pending?.failed ? ":failed" : ""}`, state);
        if (e && machines.length && e.status !== "suspended" && e.status !== "error") this.violate("S1", "cancelled-record-" + e.status, state);
        // a scanner after quiescence must not wake it
        const before = machines.map((m) => m.state);
        this.net.proxyHit(app);
        const after = machines.map((m) => m.state);
        if (before.join() !== after.join()) this.violate("S1", "cancelled-machine-woken-by-proxy", state);
        if (this.cancelAt[u] !== null && machines.length) {
          const m = machines[0];
          const lastStop = [...m.history].reverse().find((h) => h.state === "stopped");
          if (lastStop && m.state === "stopped") {
            // earliest moment from which it stayed stopped
            let from = lastStop.from;
            for (let i = m.history.length - 1; i >= 0 && m.history[i].state === "stopped"; i--) from = m.history[i].from;
            this.billingAfterCancel.push(Math.max(0, from - this.cancelAt[u]!));
          }
        }
      }
    }
    // public health endpoint: booleans and fixed strings only
    const h = await (await healthHandler(new Request("https://portal.test/api/health"), {} as any)).text();
    const hm = LEAK_RE.exec(h);
    if (hm) this.violate("S5", "leak-health", h.slice(0, 200));
    void now;
  }

  billingAfterCancel: number[] = [];
}

export async function runCase(sc: Scenario, opts: { trace?: boolean } = {}): Promise<CaseResult> {
  const w = new World(sc, opts);
  await w.setup();
  let rounds = 0;
  try {
    for (const a of sc.actions) await w.runAction(a);
    rounds = await w.quiesce();
    await w.finalCheck();
  } finally {
    clock.uninstall();
  }
  return {
    violations: w.violations,
    rounds,
    virtualMs: clock.now - T0,
    flyCalls: w.net.calls,
    storeOps: w.store.ops,
    events: w.events.length,
    lost: w.events.filter((e) => e.lostAsDuplicate).length,
    billingAfterCancelMs: w.billingAfterCancel,
    trace: w.trace,
  };
}
