// Scenario language for the lifecycle model tests. A scenario is a SEQUENCE of actions run in
// virtual time by harness.ts against the REAL portal functions (billing webhook handler, scheduled
// tick, dashboard drivers). Concurrency comes from `gap`: an action starts an invocation and the clock
// moves on by `gap` ms before the next action starts, so a small gap overlaps invocations and the
// store / Fly latencies decide the interleaving.
import type { FlyFaults } from "./net";

export type Price = "op" | "sov";
export type SubStatus = "active" | "trialing" | "past_due" | "unpaid" | "canceled" | "incomplete" | "incomplete_expired" | "paused";

export type StripeOp =
  /** a new subscription through Checkout (metadata.user_id set): customer.subscription.created + checkout.session.completed */
  | { k: "checkout"; u: number; sub: number; price: Price }
  /** another subscription of the same customer (e.g. created in the Customer Portal / dashboard); meta=false: no metadata.user_id */
  | { k: "newsub"; u: number; sub: number; price: Price; status: SubStatus; meta: boolean }
  /** a status change at Stripe (canceled -> customer.subscription.deleted) */
  | { k: "status"; u: number; sub: number; status: SubStatus }
  /** a plan change (price) at Stripe, status unchanged */
  | { k: "plan"; u: number; sub: number; price: Price };

export type Action =
  | { k: "stripe"; op: StripeOp; gap: number }
  /** one delivery attempt of the n-th event created so far (mod count). limit = function time limit, crashAt = kill at the k-th I/O */
  | { k: "deliver"; ev: number; gap: number; limitMs: number; crashAt: number | null }
  | { k: "tick"; gap: number; crashAt: number | null }
  /** dashboard: POST /api/estate/advance (one provisioning step) */
  | { k: "poll"; u: number; gap: number; crashAt: number | null }
  /** dashboard: place the Anthropic key (guarded config write, restarts the machine) */
  | { k: "key"; u: number; gap: number }
  /** worker: image upgrade to a new label (guarded full-config write; restores autostart) */
  | { k: "upgrade"; u: number; gap: number }
  /** dashboard: retry an error estate */
  | { k: "retry"; u: number; gap: number }
  /** an inbound request through the Fly proxy (customer, scanner) */
  | { k: "proxy"; u: number }
  /** Fly stops the machine by itself (host event) */
  | { k: "pstop"; u: number }
  /** Fly fault regime from now until the next fault action (quiescence clears it) */
  | { k: "fault"; f: Partial<FlyFaults>; stripeTimeout: number }
  | { k: "jump"; ms: number };

export type UserInit = "ready" | "new";

export type Scenario = {
  seed: number;
  users: UserInit[];
  /** Stripe's retry delay after a failed delivery (UNVERIFIED schedule; the model varies it) */
  stripeRetryMs: number;
  actions: Action[];
};

export function describeAction(a: Action): string {
  switch (a.k) {
    case "stripe": {
      const o = a.op;
      const s = `u${o.u}.sub${o.sub}`;
      const body = o.k === "checkout" ? `checkout ${s} ${o.price}` : o.k === "newsub" ? `newsub ${s} ${o.price} ${o.status}${o.meta ? "" : " (no metadata)"}` : o.k === "status" ? `status ${s} -> ${o.status}` : `plan ${s} -> ${o.price}`;
      return `stripe ${body} +${a.gap}ms`;
    }
    case "deliver":
      return `deliver ev#${a.ev} limit=${a.limitMs / 1000}s${a.crashAt !== null ? " crash@io" + a.crashAt : ""} +${a.gap}ms`;
    case "tick":
      return `tick${a.crashAt !== null ? " crash@io" + a.crashAt : ""} +${a.gap}ms`;
    case "poll":
      return `poll u${a.u}${a.crashAt !== null ? " crash@io" + a.crashAt : ""} +${a.gap}ms`;
    case "key":
    case "upgrade":
    case "retry":
      return `${a.k} u${a.u} +${a.gap}ms`;
    case "proxy":
    case "pstop":
      return `${a.k} u${a.u}`;
    case "fault":
      return `fault ${JSON.stringify(a.f)}${a.stripeTimeout ? " stripeTimeout=" + a.stripeTimeout : ""}`;
    case "jump":
      return `jump +${a.ms / 1000}s`;
  }
}
