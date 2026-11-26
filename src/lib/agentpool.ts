// Force-Field Console — the governed-agent pool (price book rev 2), enforced at the portal gateway.
// A dedicated-estate account may run at most its pool of agents: billing.agent_pool, recorded by the Stripe webhook
// from seats and packs (src/lib/billing.ts), or, for a subscription recorded before seats existed, the pool of the
// tier's minimum seat count. Counted = the estate registry's agents that are NOT retired and NOT platform self-agents.
// Gated: registering an agent (POST /registry/agents). Changing an agent (PATCH /registry/agents/<id>, which includes
// reviving a retired one) is not forwarded by the console at all (it is not in ALLOWED_ROUTES, src/lib/upstream.ts),
// so there is no revival path to gate; retiring is an operator action for now.
import type { User } from "./users";
import { SELF_AGENTS, SELF_OWNER } from "./estates";

/** The platform's own agents: exempt from the pool only by BOTH their fixed id and the platform owner string, so a
 * customer cannot hide agents from the count by registering them under the platform's owner name. */
const SELF_AGENT_IDS = new Set(SELF_AGENTS.map((a) => a.id));
function isPlatformSelfAgent(a: any): boolean {
  return a?.owner === SELF_OWNER && SELF_AGENT_IDS.has(String(a?.agent_id ?? ""));
}
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

export type PoolGate = { kind: "register" } | null;

/** Which forwarded requests can add an agent to the pool: only registering. (`body` is kept for the call site.) */
export function classify(method: string, canon: string, _body?: ArrayBuffer | undefined): PoolGate {
  const m = method.toUpperCase();
  if (m === "POST" && canon === "/registry/agents") return { kind: "register" };
  return null;
}

/** Agents that count against the pool. */
export function agentsInUse(list: unknown): number | null {
  if (!Array.isArray(list)) return null;
  return list.filter((a: any) => a && !isPlatformSelfAgent(a) && String(a.status ?? "").toLowerCase() !== "retired").length;
}

/** The account's pool, or null when the account has no paid seat tier (no pool to enforce). */
export function poolFor(user: User): number | null {
  if (user.tier !== "operator" && user.tier !== "sovereign") return null;
  const recorded = user.billing?.agent_pool;
  if (typeof recorded === "number" && Number.isFinite(recorded) && recorded >= 0) return recorded;
  return agentPool(user.tier, seatBounds(user.tier).min, 0);
}
