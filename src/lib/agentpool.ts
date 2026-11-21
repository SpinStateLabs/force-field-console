// Force-Field Console — the governed-agent pool (price book rev 2), enforced at the portal gateway.
// A dedicated-estate account may run at most its pool of agents: billing.agent_pool, recorded by the Stripe webhook
// from seats and packs (src/lib/billing.ts), or, for a subscription recorded before seats existed, the pool of the
// tier's minimum seat count. Counted = the estate registry's agents that are NOT retired and NOT platform self-agents.
// Gated: registering an agent and reviving a retired one. Retiring, reading and every other service pass untouched, so
// a customer over the pool (seats lowered) can always get back under it.
import type { User } from "./users";
import { SELF_OWNER } from "./estates";
import { agentPool, seatBounds } from "./pricebook";

/**
 * The upstream path as the estate will route it: percent-decoded (the upstream server decodes before routing, so
 * "%2F" is a slash and "%61" an "a"), repeated slashes collapsed, trailing slash dropped. null when the path cannot
 * be decoded (the gateway refuses it rather than guess how the upstream would read it).
 */
export function canonicalPath(subPath: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(subPath);
  } catch {
    return null;
  }
  p = p.replace(/\/+/g, "/");
  if (p.length > 1) p = p.replace(/\/$/, "");
  return p;
}

export type PoolGate = { kind: "register" } | { kind: "maybe_revive"; agent_id: string } | null;

/** Which requests can add an agent to the pool. A PATCH is a revival only if it sets a non-retired status. */
export function classify(method: string, canon: string, body: ArrayBuffer | undefined): PoolGate {
  const m = method.toUpperCase();
  if (m === "POST" && canon === "/registry/agents") return { kind: "register" };
  const one = /^\/registry\/agents\/([^/]+)$/.exec(canon);
  if (one && m === "PATCH") {
    let status: unknown;
    try {
      status = JSON.parse(new TextDecoder().decode(body ?? new ArrayBuffer(0)))?.status;
    } catch {
      return null; // not JSON: the upstream refuses it; nothing is revived
    }
    if (typeof status === "string" && status.toLowerCase() !== "retired") return { kind: "maybe_revive", agent_id: one[1] };
  }
  return null;
}

/** Agents that count against the pool. */
export function agentsInUse(list: unknown): number | null {
  if (!Array.isArray(list)) return null;
  return list.filter((a: any) => a && a.owner !== SELF_OWNER && String(a.status ?? "").toLowerCase() !== "retired").length;
}

/** The account's pool, or null when the account has no paid seat tier (no pool to enforce). */
export function poolFor(user: User): number | null {
  if (user.tier !== "operator" && user.tier !== "sovereign") return null;
  const recorded = user.billing?.agent_pool;
  if (typeof recorded === "number" && Number.isFinite(recorded) && recorded >= 0) return recorded;
  return agentPool(user.tier, seatBounds(user.tier).min, 0);
}
