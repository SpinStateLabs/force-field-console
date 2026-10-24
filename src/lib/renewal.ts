// Force-Field Console — self-agent token renewal for dedicated estates.
//
// Each estate carries three platform identities (conformance-sentinel,
// force-gateway, compliance-crosswalk) whose delegation tokens are minted for
// 30 days at provisioning. Without renewal the gateway's own calls would be
// refused on day 31. The scheduled tick renews all three after RENEW_AFTER_DAYS:
// mint in-machine against the estate's delegation service (the DOA roster's
// platform row allows it), push the new ids into Fly secrets, and update the
// machine so the processes restart with them (about a minute of downtime).
// Token ids never land on the estate record.

import { EstateError, SELF_AGENTS, estateSecret, lastJsonLine, logEstate, redactSecret, saveEstate, updateMachineGuarded, type Estate } from "./estates";
import type { FlyClient } from "./fly";

export const RENEW_AFTER_DAYS = 25;
export const TOKEN_TTL_S = 30 * 86400 - 60; // under the roster row's max_ttl_days of 30

/** $1 = shared secret, $2 = self-agent id. Prints one JSON line with the new token id. */
export const RENEW_PY = `
import json, sys, urllib.error, urllib.request
import yaml
secret, agent = sys.argv[1], sys.argv[2]
m = yaml.safe_load(open("/data/manifests/%s.yaml" % agent))
body = {"agent_id": agent, "granted_by": "Founder & CTO, Spin State Labs", "scope": list(m["delegation"]["scope"]), "ttl_seconds": ${TOKEN_TTL_S}}
req = urllib.request.Request("http://127.0.0.1:8003/tokens", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-field-auth": secret}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=20) as r:
        d = json.load(r)
except urllib.error.HTTPError as e:
    print(json.dumps({"error": "HTTP %d: %s" % (e.code, e.read()[:300].decode(errors="replace"))})); sys.exit(1)
print(json.dumps({"token_id": d["token_id"], "expires_at": d.get("expires_at")}))
`;

/** True when a ready estate has any self-agent token older than RENEW_AFTER_DAYS (or unknown). */
export function renewalDue(e: Estate, now: Date = new Date()): boolean {
  if (e.status !== "ready" || !e.machine_id) return false;
  const cutoff = now.getTime() - RENEW_AFTER_DAYS * 86400 * 1000;
  return SELF_AGENTS.some((a) => {
    const at = e.self_agents[a.id]?.provisioned_at;
    return !at || new Date(at).getTime() < cutoff;
  });
}

/** Mint fresh 30-day tokens for the three self-agents, set them as secrets, restart the machine. */
export async function renewSelfAgents(e: Estate, fly: FlyClient, now: Date = new Date()): Promise<Estate> {
  if (e.status !== "ready" || !e.machine_id) throw new EstateError(409, "estate_not_ready", "Only a ready estate renews its self-agent tokens.");
  const secret = estateSecret(e.app);
  const secrets: Record<string, string> = {};
  for (const agent of SELF_AGENTS) {
    const r = await fly.exec(e.app, e.machine_id, ["python3", "-c", RENEW_PY, secret, agent.id], 25);
    const out = lastJsonLine(r.stdout);
    if (r.exit_code !== 0 || !out?.token_id) {
      logEstate(e, "renew", `mint for ${agent.id} failed rc=${r.exit_code}: ${redactSecret((out?.error ?? r.stderr ?? r.stdout).toString().slice(-200), secret)}`, now);
      await saveEstate(e, now);
      throw new EstateError(502, "renew_failed", `token renewal for ${agent.id} failed`);
    }
    secrets[agent.secret] = String(out.token_id);
  }
  await fly.setSecrets(e.app, secrets);
  await updateMachineGuarded(e, fly, (cur) => cur!, { readCurrent: true });
  for (const agent of SELF_AGENTS) e.self_agents[agent.id] = { provisioned_at: now.toISOString() };
  logEstate(e, "renew", "self-agent tokens renewed (30 d) and applied; machine restarted", now);
  await saveEstate(e, now);
  return e;
}
