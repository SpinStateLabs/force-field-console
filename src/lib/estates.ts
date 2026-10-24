// Force-Field Console — dedicated estates.
//
// One Fly.io app per paying account (`ff-est-<8 hex>`), created and armed by
// a resumable state machine: every step is idempotent, short (one or two Fly
// calls), and recorded on the estate blob "estates/<user_id>" so a step can be
// driven by the dashboard's poll, by the scheduled tick, or by a retry after an
// error. The posture that results is the Phase F product posture of the
// public sandbox (ledger per-event signing REQUIRED, served attestations
// signed, gateway enforce + tool check, DOA roster mint gate).
//
// Secrets: the estate's shared secret is DERIVED (HMAC of ESTATE_SECRET_MASTER
// over the app name) so nothing per-estate is stored; self-agent token ids are
// minted in the estate and pushed straight into Fly secrets, never persisted
// here; the customer's Anthropic key goes to Fly secrets and is never stored.
// Only PUBLIC keys leave the estate (kept on the record so the customer can
// verify their ledger and attestations off-box).

import { createHash, createHmac } from "node:crypto";
import { env, portalStore } from "./store";
import type { User } from "./users";
import { withUserLock } from "./locks";
import { FlyError, estateMachineConfig, estateOrigin, flyConfig, withAutostart, type FetchLike, type FlyClient, type MachineConfig } from "./fly";

export type EstateStatus = "pending_manual" | "provisioning" | "ready" | "suspended" | "error";

export const STEPS = [
  "create_app",
  "allocate_ips",
  "create_volume",
  "set_base_secrets",
  "create_machine",
  "wait_boot",
  "bootstrap",
  "provision_sentinel",
  "provision_gateway",
  "provision_crosswalk",
  "arm",
  "wait_armed",
  "done",
] as const;
export type EstateStep = (typeof STEPS)[number];

export type RosterRow = {
  allowed_scope: string[];
  max_ttl_days: number;
  max_spend_usd: number | null;
};

/** The scheduled tick's last look at a ready estate: never a trigger for destruction, only a flag. */
export type EstateHealth = { ok: boolean; checked_at: string; note: string };

/** A resume the tick still owes a paying customer (bounded retries with backoff, then flagged for an operator). */
export type ResumePending = { since: string; attempts: number; last_error: string; next_retry_at: string | null; failed: boolean };

export type SuspendPending = {
  reason: string;
  since: string;
  attempts: number;
  /** Fixed generic text; the underlying error is only ever logged server-side. */
  last_error: string;
  next_retry_at: string | null;
  /** Retries exhausted (MAX_SUSPEND_RETRIES): needs an operator; the tick stops retrying. */
  failed: boolean;
};

export type Estate = {
  user_id: string;
  app: string;
  region: string;
  status: EstateStatus;
  step: EstateStep;
  attempts: number;
  polls: number;
  error: string | null;
  log: { at: string; step: string; note: string }[];
  volume_id: string | null;
  machine_id: string | null;
  ips: string[];
  url: string | null;
  grantor: string;
  roster: RosterRow;
  public_keys: Record<string, string>;
  fingerprints: Record<string, string>;
  self_agents: Record<string, { provisioned_at: string }>;
  posture: { enforce: boolean; tool_check: boolean; require_signing: boolean; attest_signing: boolean } | null;
  anthropic_key_set_at: string | null;
  /** The engine image the machine runs (recorded at launch/upgrade; null on records older than this field). */
  image: string | null;
  health: EstateHealth | null;
  /** An image that failed to reach the armed posture on this estate; the tick will not retry it. */
  upgrade_failed_image: string | null;
  suspended_from: EstateStatus | null;
  /**
   * A suspension that was decided but whose machine stop failed. The estate is NOT
   * marked suspended (the machine is still running and billing), the gateway refuses
   * it meanwhile, and the scheduled tick retries the stop until it succeeds.
   */
  suspend_pending?: SuspendPending | null;
  resume_pending?: ResumePending | null;
  lease_until: string | null;
  worker_until: string | null;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  suspended_at: string | null;
};

export const SELF_GRANTOR = "Founder & CTO, Spin State Labs";
export const SELF_OWNER = "Spin State Labs (platform self-agent)";
export const SELF_AGENTS: { id: string; step: EstateStep; secret: string }[] = [
  { id: "conformance-sentinel", step: "provision_sentinel", secret: "FIELD_SENTINEL_SELF_TOKEN" },
  { id: "force-gateway", step: "provision_gateway", secret: "FIELD_GATEWAY_SELF_TOKEN" },
  { id: "compliance-crosswalk", step: "provision_crosswalk", secret: "FIELD_CROSSWALK_SELF_TOKEN" },
];
export const MAX_ATTEMPTS = 6;
export const MAX_POLLS = 90;
export const LEASE_MS = 25000;
export const MAX_LOG = 60;
export const DEFAULT_ROSTER: RosterRow = { allowed_scope: [], max_ttl_days: 30, max_spend_usd: null };

export class EstateError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// --- records ------------------------------------------------------------------

export function estateKey(userId: string): string {
  return "estates/" + userId;
}

export async function getEstate(userId: string): Promise<Estate | null> {
  const store = await portalStore();
  return ((await store.get(estateKey(userId), { type: "json" })) as Estate | null) ?? null;
}

/**
 * Write the estate record. NOT a blind write: the stored record is re-read with its
 * etag, merged under the rules below and written conditionally (retried on a lost
 * race), so two writers of one record cannot silently undo each other.
 *
 * - Default (a worker or any step driver holding a possibly stale copy): SUSPEND
 *   WINS. If the stored record is suspended, or has a suspension pending, the
 *   caller's progress fields are kept but the suspension fields come from the
 *   store, and the caller's object is updated to match.
 * - `onlyIf`: checked against the STORED record on every attempt; when false nothing is
 *   written and false is returned.
 * - `owns` (suspend / resume / clearing a pending suspension: the writers that decide
 *   the suspension state): ONLY the named fields are taken from the caller's copy;
 *   everything else (status, lease, step, machine / volume facts a worker saved
 *   meanwhile) stays as stored. The log is merged.
 */
export async function saveEstate(e: Estate, now: Date = new Date(), opts: { owns?: readonly OwnedField[]; onlyIf?: (stored: Estate) => boolean } = {}): Promise<boolean> {
  e.updated_at = now.toISOString();
  if (e.log.length > MAX_LOG) e.log = e.log.slice(e.log.length - MAX_LOG);
  const store = await portalStore();
  const key = estateKey(e.user_id);
  for (let attempt = 0; attempt < 8; attempt++) {
    const read = await store.getWithEtag(key);
    const cur = read?.data as Estate | undefined;
    // A write conditional on the STORED record (e.g. "the suspension is still pending"): skipped, not forced.
    if (cur && opts.onlyIf && !opts.onlyIf(cur)) return false;
    let out: Estate = e;
    if (cur) out = opts.owns ? mergeOwned(cur, e, opts.owns) : mergeSuspendWins(cur, e);
    const ok = read ? await store.setJSONIfMatch(key, out, read.etag) : await store.setJSONIfNew(key, out);
    if (ok) {
      if (out !== e) Object.assign(e, out);
      return true;
    }
  }
  throw new EstateError(409, "estate_write_conflict", "The estate record kept changing underneath this write; try again.");
}

type OwnedField = "status" | "suspended_from" | "suspended_at" | "suspend_pending" | "health" | "machine_id" | "error" | "step" | "resume_pending";
const OWN_SUSPEND: readonly OwnedField[] = ["status", "suspended_from", "suspended_at", "suspend_pending", "health"];
const OWN_PENDING: readonly OwnedField[] = ["suspend_pending", "health"];
const OWN_RESUME: readonly OwnedField[] = ["status", "suspended_from", "suspended_at", "suspend_pending", "resume_pending", "health"];
const OWN_RESUME_PENDING: readonly OwnedField[] = ["resume_pending", "health"];

function mergeSuspendWins(cur: Estate, mine: Estate): Estate {
  const suspended = cur.status === "suspended";
  const pending = Boolean(cur.suspend_pending);
  if (!suspended && !pending) return mine;
  const out: Estate = { ...mine };
  if (suspended) {
    out.status = "suspended";
    out.suspended_at = cur.suspended_at;
    // The worker may have advanced the record (e.g. to ready) before the suspension landed.
    out.suspended_from = mine.status !== "suspended" && mine.status !== "pending_manual" ? mine.status : cur.suspended_from;
    out.lease_until = null;
  }
  if (pending && !mine.suspend_pending) {
    out.suspend_pending = cur.suspend_pending;
    out.health = cur.health;
  }
  return out;
}

function mergeOwned(cur: Estate, mine: Estate, owns: readonly OwnedField[]): Estate {
  const out: Estate = { ...cur };
  for (const f of owns) (out as any)[f] = (mine as any)[f] ?? null;
  // A suspension records the status the record had when it landed: the stored one, not a stale copy's.
  if (owns.includes("status") && mine.status === "suspended") out.suspended_from = cur.status !== "suspended" ? cur.status : cur.suspended_from;
  const seen = new Set(mine.log.map((l) => l.at + "|" + l.step + "|" + l.note));
  out.log = [...mine.log, ...cur.log.filter((l) => !seen.has(l.at + "|" + l.step + "|" + l.note))].sort((a, b) => a.at.localeCompare(b.at));
  if (out.log.length > MAX_LOG) out.log = out.log.slice(out.log.length - MAX_LOG);
  out.updated_at = mine.updated_at;
  return out;
}

export async function listEstates(): Promise<Estate[]> {
  const store = await portalStore();
  const { blobs } = await store.list({ prefix: "estates/" });
  const out: Estate[] = [];
  for (const b of blobs) {
    const e = (await store.get(b.key, { type: "json" })) as Estate | null;
    if (e) out.push(e);
  }
  return out;
}

export function logEstate(e: Estate, step: string, note: string, now: Date = new Date()): void {
  e.log.push({ at: now.toISOString(), step, note });
}

/**
 * Fly app name for a user: lowercase, digits, dashes; DETERMINISTIC (a hash of
 * the user id), so two racing writers of the same estate record (a webhook
 * redelivery, a concurrent driver) agree on one app instead of orphaning one.
 */
export function newAppName(userId: string): string {
  return "ff-est-" + createHash("sha256").update("estate-app:" + userId).digest("hex").slice(0, 8);
}

/** The estate's shared secret, derived — never stored. base64url, 43 chars. */
export function estateSecret(app: string, master: string | undefined = env("ESTATE_SECRET_MASTER")): string {
  if (!master) throw new EstateError(501, "provisioning_not_configured", "ESTATE_SECRET_MASTER is not set.");
  return createHmac("sha256", master).update("estate-secret:" + app).digest("base64url");
}

export function attestSigner(grantor: string): string {
  return `Force-Field estate key for ${grantor} (provisioned by Spin State Labs — standing attestation)`;
}

/** Create the estate record for a paying user, or return the existing one. */
export async function queueEstate(user: User, now: Date = new Date()): Promise<Estate> {
  const existing = await getEstate(user.id);
  if (existing) return existing;
  const configured = flyConfig() !== null;
  const e: Estate = {
    user_id: user.id,
    app: newAppName(user.id),
    region: flyConfig()?.region ?? "yyz",
    status: configured ? "provisioning" : "pending_manual",
    step: "create_app",
    attempts: 0,
    polls: 0,
    error: null,
    log: [],
    volume_id: null,
    machine_id: null,
    ips: [],
    url: null,
    grantor: user.email,
    roster: { ...DEFAULT_ROSTER, allowed_scope: [] },
    public_keys: {},
    fingerprints: {},
    self_agents: {},
    posture: null,
    anthropic_key_set_at: null,
    image: null,
    health: null,
    upgrade_failed_image: null,
    suspended_from: null,
    suspend_pending: null,
    resume_pending: null,
    lease_until: null,
    worker_until: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ready_at: null,
    suspended_at: null,
  };
  logEstate(e, "queue", configured ? "queued for automatic provisioning" : "queued; provisioning is not configured on this deployment (manual)", now);
  // Create-only write: a concurrent creator (a webhook redelivery, a racing
  // driver) cannot overwrite a record that already exists — its record wins.
  const store = await portalStore();
  if (!(await store.setJSONIfNew(estateKey(user.id), e))) {
    return (await getEstate(user.id))!;
  }
  return e;
}

// --- in-machine scripts -----------------------------------------------------------

/**
 * Shared by the bootstrap and roster scripts. The estate's DOA roster is
 * FAIL-CLOSED: a row with no scopes (or any other invalid row) makes the whole
 * file invalid and the delegation service then refuses EVERY mint with 503 —
 * including the platform self-agents (the live rehearsal of 2026-09-14 failed
 * at `lifecycle provision` for exactly this: the customer's default row had an
 * empty scope list). So: a customer row is written only once it has scopes,
 * and the file is validated with the estate's own loader before it replaces
 * the live roster. The roster path is the one the delegation service reads
 * (FIELD_DOA_ROSTER, inherited by exec; /data/doa-roster.yaml on an estate).
 */
export const ROSTER_LIB_PY = `
import json, os, sys
import yaml
from delegation_authority.doa import load_roster
ROSTER = os.environ.get("FIELD_DOA_ROSTER") or "/data/doa-roster.yaml"
def customer_row(c):
    scopes = [s for s in (c.get("allowed_scope") or []) if s]
    if not scopes: return None
    row = {"grantor": c["grantor"], "allowed_scope": scopes, "max_ttl_days": int(c["max_ttl_days"]), "active": True}
    if c.get("max_spend_usd") is not None: row["max_spend_usd"] = float(c["max_spend_usd"])
    return row
def write_roster(rows):
    tmp = os.path.join(os.path.dirname(ROSTER) or ".", ".doa-roster.tmp")
    with open(tmp, "w") as f: yaml.safe_dump({"grantors": rows}, f, sort_keys=False, allow_unicode=True)
    os.chmod(tmp, 0o600)
    try:
        load_roster(tmp)
    except Exception as e:
        os.unlink(tmp)
        print(json.dumps({"error": "roster rejected by the estate's validator, live roster untouched: %s" % str(e)[:300]})); sys.exit(1)
    os.replace(tmp, ROSTER)
`;

/** argv[1] = JSON {grantor, allowed_scope, max_ttl_days, max_spend_usd}. Prints one JSON line. */
export const BOOTSTRAP_PY = ROSTER_LIB_PY + `
import base64, hashlib, subprocess, importlib.resources as r
os.makedirs("/data/keys", exist_ok=True); os.makedirs("/data/manifests", exist_ok=True)
out = {"keys": {}, "manifests": []}
for name in ("ledger-anchor", "ledger-sign", "attest-sign"):
    priv = "/data/keys/%s.pem" % name
    if not os.path.exists(priv):
        p = subprocess.run([sys.executable, "/platform/tools/volume_admin.py", "keys", "generate", "--dir", "/data/keys", name], capture_output=True, text=True)
        if p.returncode != 0:
            print(json.dumps({"error": "keygen %s rc=%d: %s" % (name, p.returncode, p.stderr[-300:])})); sys.exit(1)
    pub = open("/data/keys/%s.pub.pem" % name).read()
    der = base64.b64decode("".join(l for l in pub.splitlines() if not l.startswith("-----")))
    out["keys"][name] = {"pub": pub, "fingerprint": hashlib.sha256(der[-32:]).hexdigest()}
pairs = (("conformance-sentinel", "conformance_sentinel"), ("force-gateway", "force_gateway"), ("compliance-crosswalk", "compliance_crosswalk"))
for mid, pkg in pairs:
    src = r.files(pkg) / "self_manifest.yaml"
    with open("/data/manifests/%s.yaml" % mid, "w") as f: f.write(src.read_text())
    out["manifests"].append(mid)
self_name = "Founder & CTO, Spin State Labs"; scopes = []
for mid, _ in pairs:
    m = yaml.safe_load(open("/data/manifests/%s.yaml" % mid))
    assert m["identity"]["principal"] == self_name, m["identity"]["principal"]
    for s in m["delegation"]["scope"]:
        if s not in scopes: scopes.append(s)
c = json.loads(sys.argv[1])
rows = [{"grantor": self_name, "allowed_scope": scopes, "max_ttl_days": 30, "active": True}]
crow = customer_row(c)
if crow: rows.append(crow)
write_roster(rows)
out["roster_rows"] = len(rows); out["customer_row"] = bool(crow)
import csv
owners_path = os.environ.get("FIELD_LIFECYCLE_ROSTER") or "/data/owners.csv"
owners_tmp = owners_path + ".tmp"
with open(owners_tmp, "w", newline="") as f:
    w = csv.writer(f, quoting=csv.QUOTE_ALL)
    w.writerow(["owner", "aliases"]); w.writerow([${JSON.stringify(SELF_OWNER)}, ""]); w.writerow([c["grantor"], ""])
os.chmod(owners_tmp, 0o600); os.replace(owners_tmp, owners_path)
out["owners"] = 2
print(json.dumps(out))
`;

/** argv[1] = JSON row (grantor, allowed_scope, max_ttl_days, max_spend_usd): replace that grantor's row, keep the rest. */
export const ROSTER_PY = ROSTER_LIB_PY + `
c = json.loads(sys.argv[1])
doc = yaml.safe_load(open(ROSTER)) if os.path.exists(ROSTER) else {"grantors": []}
rows = [x for x in ((doc or {}).get("grantors") or []) if x.get("grantor") != c["grantor"]]
crow = customer_row(c)
if crow: rows.append(crow)
write_roster(rows)
print(json.dumps({"roster_rows": len(rows), "customer_row": bool(crow)}))
`;

/** $0 = shared secret, $1 = self-agent id, $2 = owner. Prints one JSON line with the token id; on failure, the report's steps. */
export const PROVISION_SH = `
set -e
export FIELD_SHARED_SECRET="$0" FIELD_REGISTRY_URL=http://127.0.0.1:8001 FIELD_LEDGER_URL=http://127.0.0.1:8002 FIELD_DELEGATION_URL=http://127.0.0.1:8003 FIELD_GOVERNOR_URL=http://127.0.0.1:8006 FIELD_LIFECYCLE_URL=http://127.0.0.1:8012
id="$1"; owner="$2"
lifecycle provision --manifest "/data/manifests/$id.yaml" --owner "$owner" --domain platform --grantor "Founder & CTO, Spin State Labs" --ttl-days 30 --manifest-ref "/data/manifests/$id.yaml" --out "/tmp/prov-$id.json" > "/tmp/prov-$id.out" 2>&1 || {
  tail -c 300 "/tmp/prov-$id.out" || true
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('steps:', [[s['step'], s['outcome'], str(s.get('detail') or '')[:200]] for s in d.get('steps', [])])" "/tmp/prov-$id.json" 2>/dev/null || true
  exit 1
}
python3 -c "import json,sys; d=json.load(open('/tmp/prov-'+sys.argv[1]+'.json')); print(json.dumps({'token_id': d['token_id'], 'ok': d.get('ok'), 'steps': [[s['step'], s['outcome']] for s in d.get('steps', [])]}))" "$id"
rm -f "/tmp/prov-$id.json"
`;

// --- helpers ---------------------------------------------------------------------

/** Replace every occurrence of a secret in captured output before it is logged, stored or served. */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!secret || !text) return text ?? "";
  return text.split(secret).join("[redacted]");
}

export function lastJsonLine(text: string): any | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("{")) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export async function healthJson(origin: string, path: string, fetchImpl: FetchLike = fetch): Promise<any | null> {
  try {
    const res = await fetchImpl(origin + path, { method: "GET", signal: AbortSignal.timeout(6000) });
    if (res.status !== 200) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function validateRoster(input: any): RosterRow {
  const scopes = input?.allowed_scope;
  if (!Array.isArray(scopes) || scopes.length > 64) throw new EstateError(400, "bad_roster", "allowed_scope must be a list of at most 64 scope strings.");
  const cleaned: string[] = [];
  for (const s of scopes) {
    if (typeof s !== "string") throw new EstateError(400, "bad_roster", "Every scope must be a string.");
    const t = s.trim();
    if (!t || t.length > 120 || /[\u0000-\u001f\u007f]/.test(t)) throw new EstateError(400, "bad_roster", "Scopes are 1–120 printable characters.");
    if (!cleaned.includes(t)) cleaned.push(t);
  }
  const ttl = Number(input?.max_ttl_days);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 365) throw new EstateError(400, "bad_roster", "max_ttl_days must be an integer from 1 to 365.");
  let spend: number | null = null;
  if (input?.max_spend_usd !== null && input?.max_spend_usd !== undefined && input?.max_spend_usd !== "") {
    spend = Number(input.max_spend_usd);
    if (!Number.isFinite(spend) || spend <= 0 || spend > 1_000_000) throw new EstateError(400, "bad_roster", "max_spend_usd must be a positive number (or empty for no ceiling).");
  }
  return { allowed_scope: cleaned, max_ttl_days: ttl, max_spend_usd: spend };
}

export function validateAnthropicKey(key: any): string {
  if (typeof key !== "string") throw new EstateError(400, "bad_key", "key must be a string.");
  const k = key.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{30,220}$/.test(k)) throw new EstateError(400, "bad_key", "That does not look like an Anthropic API key (sk-ant-…).");
  return k;
}

// --- the state machine ----------------------------------------------------------

export type AdvanceOutcome = "progressed" | "waiting" | "done" | "error" | "idle";
export type AdvanceResult = { estate: Estate; outcome: AdvanceOutcome; note: string };

function nextStep(e: Estate, note: string, now: Date): void {
  const i = STEPS.indexOf(e.step);
  logEstate(e, e.step, note, now);
  e.step = STEPS[Math.min(i + 1, STEPS.length - 1)];
  e.attempts = 0;
  e.polls = 0;
  e.error = null;
}

/**
 * Run ONE provisioning step. Safe to call from several drivers: a short lease
 * on the record keeps two callers from running the same step at once, and each
 * step checks Fly for what already exists before creating anything.
 */
export async function advanceEstate(
  e: Estate,
  fly: FlyClient | null,
  opts: { now?: Date; fetchImpl?: FetchLike } = {},
): Promise<AdvanceResult> {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cfg = flyConfig();

  if (e.status === "pending_manual" && fly && cfg) {
    e.status = "provisioning";
    logEstate(e, "queue", "provisioning became configured; starting", now);
    await saveEstate(e, now);
  }
  if (e.status !== "provisioning") return { estate: e, outcome: "idle", note: `estate is ${e.status}` };
  if (e.suspend_pending) return { estate: e, outcome: "idle", note: "a suspension is pending; not provisioning further" };
  if (!fly || !cfg) return { estate: e, outcome: "idle", note: "provisioning is not configured on this deployment" };
  if (e.lease_until && new Date(e.lease_until).getTime() > now.getTime()) {
    return { estate: e, outcome: "waiting", note: "another driver holds the step lease" };
  }
  if (e.step === "done") {
    e.status = "ready";
    await saveEstate(e, now);
    return { estate: e, outcome: "done", note: "ready" };
  }

  e.lease_until = new Date(now.getTime() + LEASE_MS).toISOString();
  await saveEstate(e, now);
  const origin = estateOrigin(e.app);
  const signer = attestSigner(e.grantor);
  const step = e.step;

  try {
    switch (step) {
      case "create_app": {
        await fly.createApp(e.app);
        nextStep(e, `app ${e.app} present in org ${cfg.org}`, now);
        break;
      }
      case "allocate_ips": {
        const have = await fly.listIps(e.app);
        const types = new Set(have.map((i) => i.type.toLowerCase()));
        const addrs = have.map((i) => i.address);
        if (![...types].some((t) => t.includes("v4"))) addrs.push(await fly.allocateIp(e.app, "shared_v4"));
        if (![...types].some((t) => t === "v6" || t.includes("v6"))) addrs.push(await fly.allocateIp(e.app, "v6"));
        e.ips = addrs.filter(Boolean);
        nextStep(e, `public IPs: ${e.ips.length}`, now);
        break;
      }
      case "create_volume": {
        if (!e.volume_id) {
          const vols = await fly.listVolumes(e.app);
          const existing = vols.find((v) => v.name === "ff_data");
          e.volume_id = existing ? existing.id : (await fly.createVolume(e.app, "ff_data", 1)).id;
        }
        nextStep(e, `volume ${e.volume_id} (ff_data, 1 GB, ${cfg.region})`, now);
        break;
      }
      case "set_base_secrets": {
        await fly.setSecrets(e.app, { FIELD_SHARED_SECRET: estateSecret(e.app) });
        nextStep(e, "FIELD_SHARED_SECRET set (derived; not stored in the console)", now);
        break;
      }
      case "create_machine": {
        if (!e.machine_id) {
          const machines = await fly.listMachines(e.app);
          const existing = machines.find((m) => m.name === "estate");
          if (existing) {
            e.machine_id = existing.id;
            e.image = existing.config?.image ?? cfg.image;
          } else {
            e.machine_id = (await fly.createMachine(e.app, "estate", estateMachineConfig(cfg, e.volume_id!, "boot", signer))).id;
            e.image = cfg.image;
          }
        }
        nextStep(e, `machine ${e.machine_id} launched from ${e.image ?? cfg.image} (observer posture for bootstrap)`, now);
        break;
      }
      case "wait_boot": {
        const [reg, led, del] = await Promise.all([
          healthJson(origin, "/registry/health", fetchImpl),
          healthJson(origin, "/ledger/health", fetchImpl),
          healthJson(origin, "/delegation/health", fetchImpl),
        ]);
        if (reg && led && del) {
          nextStep(e, `estate answering at ${origin} (build ${led.build_sha ?? "?"})`, now);
        } else {
          e.polls += 1;
          if (e.polls > MAX_POLLS) throw new EstateError(504, "boot_timeout", "the estate did not become healthy in time");
          e.lease_until = null;
          await saveEstate(e, now);
          return { estate: e, outcome: "waiting", note: `booting (poll ${e.polls})` };
        }
        break;
      }
      case "bootstrap": {
        const row = { grantor: e.grantor, ...e.roster };
        const r = await fly.exec(e.app, e.machine_id!, ["python3", "-c", BOOTSTRAP_PY, JSON.stringify(row)], 25);
        const out = lastJsonLine(r.stdout);
        if (r.exit_code !== 0 || !out || out.error) {
          throw new EstateError(502, "bootstrap_failed", `bootstrap rc=${r.exit_code}: ${(out?.error ?? r.stderr ?? r.stdout).toString().slice(-300)}`);
        }
        for (const [name, k] of Object.entries<any>(out.keys ?? {})) {
          e.public_keys[name] = String(k.pub ?? "");
          e.fingerprints[name] = String(k.fingerprint ?? "");
        }
        nextStep(e, `keys ${Object.keys(out.keys ?? {}).join(", ")}; manifests ${(out.manifests ?? []).length}; roster rows ${out.roster_rows} (customer row ${out.customer_row ? "present" : "omitted until it has scopes"})`, now);
        break;
      }
      case "provision_sentinel":
      case "provision_gateway":
      case "provision_crosswalk": {
        const agent = SELF_AGENTS.find((a) => a.step === step)!;
        const secret = estateSecret(e.app);
        const r = await fly.exec(e.app, e.machine_id!, ["sh", "-c", PROVISION_SH, secret, agent.id, SELF_OWNER], 25);
        const out = lastJsonLine(r.stdout);
        if (r.exit_code !== 0 || !out?.token_id) {
          // The exec environment carries the shared secret; never let captured output leak it.
          throw new EstateError(502, "self_agent_failed", `provision ${agent.id} rc=${r.exit_code}: ${redactSecret((r.stdout + r.stderr).slice(-300), secret)}`);
        }
        await fly.setSecrets(e.app, { [agent.secret]: String(out.token_id) });
        e.self_agents[agent.id] = { provisioned_at: now.toISOString() };
        nextStep(e, `${agent.id} registered, capped and tokened (30 d); ${agent.secret} set`, now);
        break;
      }
      case "arm": {
        await updateMachineGuarded(e, fly, () => estateMachineConfig(cfg, e.volume_id!, "armed", signer));
        e.posture = { enforce: true, tool_check: true, require_signing: true, attest_signing: true };
        nextStep(e, "machine updated to the armed posture (signing required, attest signing, gateway enforce + tool check); restarting", now);
        break;
      }
      case "wait_armed": {
        const { armed, ledger: led } = await armedPosture(origin, fetchImpl);
        if (armed) {
          const fp = String(led?.key_fingerprint ?? "");
          if (e.fingerprints["ledger-sign"] && fp && fp !== e.fingerprints["ledger-sign"]) {
            throw new EstateError(500, "fingerprint_mismatch", "the ledger reports a signing key that is not the one generated at bootstrap");
          }
          e.status = "ready";
          e.url = origin;
          e.ready_at = now.toISOString();
          nextStep(e, `armed and healthy at ${origin}`, now);
        } else {
          e.polls += 1;
          if (e.polls > MAX_POLLS) throw new EstateError(504, "arm_timeout", "the estate did not report the armed posture in time");
          e.lease_until = null;
          await saveEstate(e, now);
          return { estate: e, outcome: "waiting", note: `arming (poll ${e.polls})` };
        }
        break;
      }
    }
  } catch (err: any) {
    e.attempts += 1;
    e.polls = 0; // a fresh polling window per attempt
    // User-visible text is fixed and generic for anything that came from Fly (app names, machine ids, URLs and
    // tokens can ride in its error text); the detail goes to the server log only, truncated.
    console.error("estate provision: step", step, "failed for", e.app, redactSecret(String(err?.message ?? err), cfg ? estateSecret(e.app) : null).slice(0, 300));
    e.error =
      err instanceof EstateError
        ? redactSecret(err.message, cfg ? estateSecret(e.app) : null).slice(0, 400)
        : err instanceof FlyError
          ? "the Fly API refused or failed the request; retrying"
          : "an unexpected error occurred; retrying";
    logEstate(e, step, `attempt ${e.attempts} failed: ${e.error}`, now);
    if (e.attempts >= MAX_ATTEMPTS) {
      e.status = "error";
      logEstate(e, step, "giving up; retry from the dashboard once the cause is fixed", now);
    }
    e.lease_until = null;
    await saveEstate(e, now);
    return { estate: e, outcome: "error", note: e.error };
  }

  e.lease_until = null;
  await saveEstate(e, now);
  if (e.status === "ready") return { estate: e, outcome: "done", note: "ready" };
  return { estate: e, outcome: "progressed", note: `next: ${e.step}` };
}

/** Reset a failed estate so the driver retries its current step. */
export async function retryEstate(e: Estate, now: Date = new Date()): Promise<Estate> {
  if (e.status !== "error") throw new EstateError(409, "not_failed", "Only a failed estate can be retried.");
  e.status = "provisioning";
  e.attempts = 0;
  e.polls = 0;
  e.error = null;
  logEstate(e, e.step, "retry requested", now);
  await saveEstate(e, now);
  return e;
}

export const MAX_SUSPEND_RETRIES = 10;
const SUSPEND_BACKOFF_BASE_MS = 2 * 60_000;
const SUSPEND_BACKOFF_MAX_MS = 60 * 60_000;
const SUSPEND_ERR = "machine stop failed";
/** After the fast retries are exhausted a failed suspension / resume is still retried slowly, a bounded number of times. */
export const SLOW_RETRY_MS = 6 * 60 * 60_000;
export const MAX_SLOW_RETRIES = 8;
export const MAX_RESUME_RETRIES = 10;

/** When a pending record is next due: its next_retry_at, or at once when it has none and has not failed. */
export function retryDue(p: { next_retry_at: string | null; failed: boolean } | null | undefined, now: Date): boolean {
  if (!p) return true;
  return p.next_retry_at ? new Date(p.next_retry_at).getTime() <= now.getTime() : !p.failed;
}

/**
 * Stop the machine; keep the volume (no data is destroyed here). A failed stop leaves the
 * estate un-suspended with `suspend_pending` (retried by the tick with backoff, at most
 * MAX_SUSPEND_RETRIES times, then `failed`). A Fly 404 means the machine is already gone:
 * that counts as stopped. Error detail goes to the server log only; the record, health and
 * log carry fixed generic text.
 *
 * A cancel that lands while the create_machine step may be in flight (no machine_id yet)
 * cannot be marked suspended: the machine may appear a moment later. It is recorded as
 * pending; the retry looks the machine up on Fly by name and stops it.
 *
 * `requirePending` (the tick's retry): every write is conditional on the suspension still
 * being pending in the STORED record, so a reactivation that cleared it meanwhile is never
 * overwritten (nor its flag revived by a failing retry).
 */
export async function suspendEstate(
  e: Estate,
  fly: FlyClient | null,
  now: Date = new Date(),
  reason = "suspended",
  opts: { requirePending?: boolean } = {},
): Promise<Estate> {
  // A suspended estate with a pending flag is one whose machine still needs quieting (a failed resume rollback).
  if (e.status === "suspended" && !e.suspend_pending) return e;
  const onlyIf = opts.requirePending ? (cur: Estate) => Boolean(cur.suspend_pending) : undefined;
  const flag = (failed: boolean, attempts: number, note: string, next: Date | null, prior: SuspendPending | null | undefined) => {
    e.suspend_pending = {
      reason,
      since: prior?.since ?? now.toISOString(),
      attempts,
      last_error: SUSPEND_ERR,
      next_retry_at: next ? next.toISOString() : null,
      failed,
    };
    e.health = { ok: false, checked_at: now.toISOString(), note };
  };

  let machineId = e.machine_id;
  let discovered = false;
  if (fly && !machineId && e.status === "provisioning" && e.step === "create_machine") {
    if (!e.suspend_pending) {
      flag(false, 0, "suspend pending: machine creation was in flight; the machine will be stopped once it exists", new Date(now.getTime() + SUSPEND_BACKOFF_BASE_MS), null);
      logEstate(e, "suspend", "cancel arrived while the machine was being created; suspension pending until the machine can be stopped", now);
      await saveEstate(e, now, { owns: OWN_PENDING, onlyIf });
      return e;
    }
    try {
      const found = (await fly.listMachines(e.app)).find((m) => m.name === "estate");
      if (found) {
        machineId = found.id;
        discovered = true;
      }
    } catch (err: any) {
      console.error("estate suspend: machine lookup failed for", e.app, String(err?.message ?? err).slice(0, 300));
      return failStop(err);
    }
  }

  function failStop(err: any): Promise<Estate> {
    // The machine may still be running (and billing): do NOT mark the estate suspended.
    console.error("estate suspend: machine stop failed for", e.app, String(err?.message ?? err).slice(0, 300));
    const prior = e.suspend_pending;
    const attempts = (prior?.attempts ?? 0) + 1;
    const failed = attempts >= MAX_SUSPEND_RETRIES;
    const delay = Math.min(SUSPEND_BACKOFF_BASE_MS * 2 ** (attempts - 1), SUSPEND_BACKOFF_MAX_MS);
    if (failed && !prior?.failed) console.error("ALERT suspend_failed", JSON.stringify({ key: "suspend_failed", user_id: e.user_id, app: e.app, attempts }));
    flag(
      failed,
      attempts,
      failed
        ? `suspend failed: the machine could not be stopped after ${attempts} attempts; operator action needed`
        : `suspend pending: the machine could not be stopped yet (attempt ${attempts}); retrying`,
      failed ? (attempts < MAX_SUSPEND_RETRIES + MAX_SLOW_RETRIES ? new Date(now.getTime() + SLOW_RETRY_MS) : null) : new Date(now.getTime() + delay),
      prior,
    );
    logEstate(e, "suspend", failed ? `${SUSPEND_ERR}; giving up after ${attempts} attempts (suspend failed) - gateway refuses` : `${SUSPEND_ERR} (attempt ${attempts}); suspension pending - gateway refuses, tick retries`, now);
    return saveEstate(e, now, { owns: OWN_PENDING, onlyIf }).then(() => e);
  }

  if (fly && machineId && !e.suspend_pending) {
    // Visible BEFORE the slow part: from here on the gateway refuses and the guarded config writers
    // refuse, so nothing can slip in while the machine is being quieted.
    flag(false, 0, "suspend pending: the machine is being stopped", new Date(now.getTime() + SUSPEND_BACKOFF_BASE_MS), null);
    logEstate(e, "suspend", `suspension started: ${reason}`, now);
    await saveEstate(e, now, { owns: OWN_PENDING, onlyIf });
  }
  if (fly && machineId) {
    try {
      const r = await quiesceMachine(e.app, fly, machineId);
      logEstate(
        e,
        "suspend",
        r === "gone"
          ? `machine ${machineId} not found on Fly (already gone): ${reason}`
          : `machine ${machineId} stopped with proxy autostart disabled (verified by read-back): ${reason}`,
        now,
      );
    } catch (err: any) {
      return failStop(err);
    }
  } else {
    logEstate(e, "suspend", `marked suspended: ${reason}` + (fly ? "" : " (provisioning not configured; no machine to stop)"), now);
  }
  if (discovered) e.machine_id = machineId;
  if (e.status !== "suspended") {
    e.suspended_from = e.status;
    e.status = "suspended";
    e.suspended_at = now.toISOString();
  }
  e.suspend_pending = null;
  if (e.health && /^suspend (pending|failed)/.test(e.health.note)) e.health = null;
  await saveEstate(e, now, { owns: discovered ? [...OWN_SUSPEND, "machine_id"] : OWN_SUSPEND, onlyIf });
  return e;
}

/** A pending suspension is moot (the subscription is active again): drop it; the machine was never stopped. */
export async function clearSuspendPending(e: Estate, why: string, now: Date = new Date()): Promise<Estate> {
  if (!e.suspend_pending) return e;
  e.suspend_pending = null;
  if (e.health && !e.health.ok && /^suspend (pending|failed)/.test(e.health.note)) e.health = null;
  logEstate(e, "suspend", `pending suspension cleared: ${why}`, now);
  await saveEstate(e, now, { owns: OWN_PENDING });
  return e;
}

/**
 * Make a machine durably stopped. Stopping alone is NOT durable: with the proxy's autostart on,
 * any inbound request (a customer, a scanner, a health look) starts a stopped machine again and
 * it keeps billing (seen live: stopped at 03:15:07Z, restarted by the proxy at 03:15:10Z). So:
 *   1. read the machine; gone (404) means nothing to stop;
 *   2. write the config with every service's autostart OFF first (without launching a stopped machine);
 *   3. stop it unless it is already stopped, and wait for "stopped";
 *   4. READ BACK: the machine must be stopped AND every service must report autostart off.
 * Any failure throws, so the caller keeps the suspension pending and retries; the estate is marked
 * suspended only after all of this succeeded. Returns "gone" when Fly no longer has the machine.
 */
/** The longest the webhook / tick waits for Fly to report a stop or a start (a slow Fly call must not outlast the function limit). */
export const WAIT_S = 10;

/** Fly reads can lag a write by a moment: the read-back is retried a few times before it counts as failed. */
export const readback = { tries: 4, delayMs: 400 };

export async function quiesceMachine(app: string, fly: FlyClient, machineId: string): Promise<"stopped" | "gone"> {
  try {
    const m = await fly.getMachine(app, machineId);
    if (!m || m.state === "destroyed") return "gone";
    if (!m.config) throw new Error("machine config unreadable");
    if ((m.config.services ?? []).some((s: any) => s.autostart !== false)) {
      await fly.updateMachine(app, machineId, withAutostart(m.config, false), { skipLaunch: m.state !== "started" });
    }
    if (m.state !== "stopped") await fly.stopMachine(app, machineId);
    if (!(await fly.waitMachine(app, machineId, "stopped", WAIT_S))) throw new Error("machine did not reach stopped");
    let why = "read-back: no reading";
    let agree = 0;
    for (let i = 0; i < readback.tries; i++) {
      const v = await fly.getMachine(app, machineId);
      if (!v || v.state === "destroyed") return "gone";
      if (v.state !== "stopped") {
        why = "read-back: machine is not stopped";
        agree = 0;
      } else if (!v.config || !(v.config.services ?? []).every((s: any) => s.autostart === false)) {
        why = "read-back: proxy autostart is still on";
        agree = 0;
      } else if (++agree >= 2) {
        return "stopped"; // two consecutive reads agree
      }
      if (i < readback.tries - 1) await new Promise((r) => setTimeout(r, readback.delayMs));
    }
    throw new Error(why);
  } catch (err: any) {
    if (err instanceof FlyError && err.status === 404) return "gone";
    throw err;
  }
}

/**
 * Make a machine RUN without trusting any single read (Fly reads can lag a write, so a "started"
 * reading may be a snapshot from before a stop). Only the START is issued here: the Fly config update
 * that would turn proxy autostart back on took ~20 s on a live estate and outlasted the webhook's
 * function limit (the machine was never started), so autostart stays off until the next config
 * rebuild (estateMachineConfig restores it). A running machine with autostart off is harmless.
 * After the start (Fly returns once it is ACCEPTED) the call waits, bounded, for "started" and then
 * needs two consecutive reads to agree. A machine Fly no longer has returns "gone"; anything else
 * throws and the caller keeps its flag / stays suspended (the tick retries).
 */
export async function ensureMachineRunning(app: string, fly: FlyClient, machineId: string): Promise<"running" | "gone"> {
  try {
    const m = await fly.getMachine(app, machineId);
    if (!m || m.state === "destroyed") return "gone";
    let startError: unknown = null;
    try {
      await fly.startMachine(app, machineId);
    } catch (err) {
      startError = err; // a start of a running machine may be refused: the wait + read-back decide
    }
    if (!(await fly.waitMachine(app, machineId, "started", WAIT_S))) throw startError ?? new Error("machine did not reach started");
    let why = "read-back: no reading";
    let agree = 0;
    for (let i = 0; i < readback.tries; i++) {
      const v = await fly.getMachine(app, machineId);
      if (!v || v.state === "destroyed") return "gone";
      if (v.state !== "started") {
        why = "read-back: machine is not started";
        agree = 0;
      } else if (++agree >= 2) {
        return "running";
      }
      if (i < readback.tries - 1) await new Promise((r) => setTimeout(r, readback.delayMs));
    }
    throw startError ?? new Error(why);
  } catch (err: any) {
    if (err instanceof FlyError && err.status === 404) return "gone";
    throw err;
  }
}

/** Estate record for a machine Fly no longer has: visible in health, never re-created behind the operator's back. */
function markMachineMissing(e: Estate, now: Date): void {
  logEstate(e, "resume", "the Fly machine behind this estate is gone; retry re-creates it on the existing volume (no second estate is provisioned)", now);
  e.status = "error";
  e.error = "machine_missing: the Fly machine behind this estate is gone";
  e.step = "create_machine";
  e.machine_id = null;
  e.suspended_from = null;
  e.suspended_at = null;
  e.suspend_pending = null;
  e.health = { ok: false, checked_at: now.toISOString(), note: "machine_missing: the Fly machine is gone; operator action needed (retry re-creates it on the existing volume)" };
}

/** Record a failed resume/revive of a paying customer's estate: generic text, backoff, cap, then a slow bounded retry. */
export async function recordResumeFailure(e: Estate, now: Date, err: unknown): Promise<void> {
  console.error("estate resume: failed for", e.app, String((err as any)?.message ?? err).slice(0, 300));
  const prior = e.resume_pending;
  const attempts = (prior?.attempts ?? 0) + 1;
  const failed = attempts >= MAX_RESUME_RETRIES;
  const delay = Math.min(SUSPEND_BACKOFF_BASE_MS * 2 ** (attempts - 1), SUSPEND_BACKOFF_MAX_MS);
  const next = failed ? (attempts < MAX_RESUME_RETRIES + MAX_SLOW_RETRIES ? new Date(now.getTime() + SLOW_RETRY_MS) : null) : new Date(now.getTime() + delay);
  if (failed && !prior?.failed) console.error("ALERT resume_failed", JSON.stringify({ key: "resume_failed", user_id: e.user_id, app: e.app, attempts }));
  e.resume_pending = { since: prior?.since ?? now.toISOString(), attempts, last_error: "machine start failed", next_retry_at: next ? next.toISOString() : null, failed };
  e.health = {
    ok: false,
    checked_at: now.toISOString(),
    note: failed
      ? `resume failed: the machine could not be restarted after ${attempts} attempts; operator action needed`
      : `resume pending: the machine could not be restarted yet (attempt ${attempts}); retrying`,
  };
  logEstate(e, "resume", failed ? "machine start failed; giving up after the fast retries (resume failed)" : `machine start failed (attempt ${attempts}); resume pending, tick retries`, now);
  await saveEstate(e, now, { owns: OWN_RESUME_PENDING });
}

/**
 * A paying customer's estate that still carries a suspension flag (the stop was started, perhaps
 * even completed, before the subscription came back): the flag alone proves nothing about the
 * machine. Read it; gone -> machine_missing; autostart off or not running -> autostart on, then
 * start. Only then is the flag cleared. A failure throws and leaves the flag (retried by the tick).
 */
export async function reviveEstate(e: Estate, fly: FlyClient | null, now: Date = new Date()): Promise<Estate> {
  if (!e.suspend_pending) return e;
  if (fly && e.machine_id) {
    const r = await ensureMachineRunning(e.app, fly, e.machine_id);
    if (r === "gone") {
      markMachineMissing(e, now);
      await saveEstate(e, now, { owns: [...OWN_RESUME, "health", "machine_id", "error", "step"] });
      return e;
    }
  }
  e.suspend_pending = null;
  e.resume_pending = null;
  if (e.health && !e.health.ok && /^(suspend|resume) (pending|failed)/.test(e.health.note)) e.health = null;
  logEstate(e, "resume", "subscription is active again; the machine was checked and is running with proxy autostart on", now);
  await saveEstate(e, now, { owns: [...OWN_PENDING, "resume_pending"] });
  return e;
}

/**
 * Start the machine again and return to the status it had before suspension. Only the start (plus a
 * bounded wait and read-back, see ensureMachineRunning) runs here: the Fly config update that would
 * turn autostart back on took ~20 s on a live estate and outlasted the webhook's function limit, so
 * autostart stays off until the next config rebuild. A failed start leaves the estate suspended with
 * the machine stopped and autostart off (suspended-safe); the tick retries. A machine Fly no longer
 * has is marked machine_missing (an error the operator retries), not thrown forever.
 */
export async function resumeEstate(e: Estate, fly: FlyClient | null, now: Date = new Date()): Promise<Estate> {
  if (e.status !== "suspended") return e;
  if (fly && e.machine_id) {
    const machineId = e.machine_id;
    const r = await ensureMachineRunning(e.app, fly, machineId);
    if (r === "gone") {
      markMachineMissing(e, now);
      await saveEstate(e, now, { owns: [...OWN_RESUME, "health", "machine_id", "error", "step"] });
      return e;
    }
    logEstate(e, "resume", `machine ${machineId} started`, now);
  } else {
    logEstate(e, "resume", "resumed" + (fly ? "" : " (provisioning not configured; nothing to start)"), now);
  }
  e.status = e.suspended_from ?? "ready";
  if (e.status === "suspended") e.status = "ready";
  e.suspended_from = null;
  e.suspended_at = null;
  e.suspend_pending = null;
  e.resume_pending = null;
  if (e.health && !e.health.ok && /^(suspend|resume) (pending|failed)/.test(e.health.note)) e.health = null;
  await saveEstate(e, now, { owns: OWN_RESUME });
  return e;
}

/**
 * Every machine-config write for an ACTIVE estate (arm, image upgrade, key placement, token renewal)
 * goes through here. It takes the subscription lock (the same one a cancellation takes), re-reads the
 * estate INSIDE it and refuses when it is suspended or has a suspension pending, so a stale config
 * (autostart on) can never land after a completed suspend. With `readCurrent` the machine's current
 * config is read inside the lock too (never a copy read earlier). Updating a running machine restarts
 * it, which is the intent here (secrets / image / posture take effect); skip_launch is only for the
 * suspend / resume paths.
 */
export async function updateMachineGuarded(
  e: Estate,
  fly: FlyClient,
  build: (current: MachineConfig | null) => MachineConfig,
  opts: { readCurrent?: boolean } = {},
): Promise<void> {
  const run = async () => {
    const fresh = await getEstate(e.user_id);
    if (!fresh || fresh.status === "suspended" || fresh.suspend_pending) {
      throw new EstateError(409, "estate_suspended", "The estate is suspended or being suspended; its machine config was left unchanged.");
    }
    const id = fresh.machine_id ?? e.machine_id;
    if (!id) throw new EstateError(409, "estate_not_ready", "The estate has no machine.");
    let current: MachineConfig | null = null;
    if (opts.readCurrent) {
      current = (await fly.getMachine(e.app, id))?.config ?? null;
      if (!current) throw new EstateError(502, "machine_missing", "The estate machine could not be read.");
    }
    await fly.updateMachine(e.app, id, build(current));
  };
  return withUserLock(e.user_id, run);
}

/** Place the customer's Anthropic key as an estate secret (never stored in the portal); the machine restarts. */
export async function setEstateAnthropicKey(e: Estate, fly: FlyClient, key: string, now: Date = new Date()): Promise<Estate> {
  if (e.status !== "ready") throw new EstateError(409, "estate_not_ready", "The estate must be ready before a key can be placed.");
  const k = validateAnthropicKey(key);
  await fly.setSecrets(e.app, { ANTHROPIC_API_KEY: k });
  await updateMachineGuarded(e, fly, (cur) => cur!, { readCurrent: true });
  e.anthropic_key_set_at = now.toISOString();
  logEstate(e, "anthropic_key", "ANTHROPIC_API_KEY set on the estate; machine restarted to apply", now);
  await saveEstate(e, now);
  return e;
}

/** Rewrite the customer's DOA roster row on the estate (read per mint — no restart). */
export async function updateEstateRoster(e: Estate, fly: FlyClient, input: any, now: Date = new Date()): Promise<Estate> {
  const row = validateRoster(input);
  if (e.status === "ready") {
    const r = await fly.exec(e.app, e.machine_id!, ["python3", "-c", ROSTER_PY, JSON.stringify({ grantor: e.grantor, ...row })], 20);
    const out = lastJsonLine(r.stdout);
    if (r.exit_code !== 0 || !out || out.error) {
      throw new EstateError(502, "roster_failed", `roster rewrite rc=${r.exit_code}: ${redactSecret(String(out?.error ?? (r.stdout + r.stderr).slice(-300)), estateSecret(e.app))}`);
    }
    logEstate(
      e,
      "roster",
      out.customer_row
        ? `roster row for ${e.grantor} rewritten (${row.allowed_scope.length} scopes, ttl ${row.max_ttl_days} d); ${out.roster_rows} rows`
        : `roster row for ${e.grantor} removed: no scopes, so nothing can be minted under that grantor until scopes are added; ${out.roster_rows} rows`,
      now,
    );
  } else {
    logEstate(e, "roster", `roster row stored; applied at bootstrap (estate is ${e.status})`, now);
  }
  e.roster = row;
  await saveEstate(e, now);
  return e;
}

// --- posture, health, image upgrades ------------------------------------------------

/** The armed Phase F posture as the public health endpoints report it. */
export async function armedPosture(origin: string, fetchImpl: FetchLike = fetch): Promise<{ armed: boolean; ledger: any; gateway: any; attest: any }> {
  const [ledger, gateway, attest] = await Promise.all([
    healthJson(origin, "/ledger/health", fetchImpl),
    healthJson(origin, "/gateway/health", fetchImpl),
    healthJson(origin, "/attest/health", fetchImpl),
  ]);
  const armed =
    ledger?.signing === "on" && ledger?.require_signing === true && ledger?.appendable === true &&
    gateway?.enforce === true && gateway?.tool_check === true &&
    attest?.signing === "on";
  return { armed, ledger, gateway, attest };
}

/**
 * The Fly app behind a ready estate is gone (destroyed outside the console).
 * The record becomes an honest error at step create_app with every
 * machine-bound fact cleared: the gateway answers 503 estate_error instead of
 * dialing a dead origin, and a retry provisions a FRESH estate (new keys, an
 * empty ledger) rather than pretending the old one is back.
 */
export function markEstateAppMissing(e: Estate, now: Date = new Date()): void {
  logEstate(e, "health", `Fly app ${e.app} no longer exists (destroyed outside the console); retry provisions a fresh estate (new keys, empty ledger)`, now);
  e.status = "error";
  e.error = "estate_app_missing: the Fly app behind this estate is gone";
  e.step = "create_app";
  e.attempts = 0;
  e.polls = 0;
  e.volume_id = null;
  e.machine_id = null;
  e.ips = [];
  e.url = null;
  e.posture = null;
  e.self_agents = {};
  e.fingerprints = {};
  e.public_keys = {};
  e.ready_at = null;
  e.image = null;
  e.anthropic_key_set_at = null;
  e.upgrade_failed_image = null;
  e.health = { ok: false, checked_at: now.toISOString(), note: "Fly app missing" };
}

export type HealthOutcome = "ok" | "unhealthy" | "app_missing" | "skipped";

/**
 * One health look at a ready estate (the scheduled tick's job): the app must
 * still exist on Fly and the ledger must answer healthy and appendable. Flags
 * only — nothing here stops, restarts or destroys anything.
 */
export async function checkEstateHealth(
  e: Estate,
  fly: FlyClient,
  opts: { now?: Date; fetchImpl?: FetchLike } = {},
): Promise<HealthOutcome> {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (e.status !== "ready") return "skipped";
  if (e.suspend_pending) return "skipped"; // health is already flagged; the tick retries the stop
  const app = await fly.getApp(e.app, 8000);
  if (!app) {
    markEstateAppMissing(e, now);
    await saveEstate(e, now);
    return "app_missing";
  }
  if (!e.image && e.machine_id) {
    const m = await fly.getMachine(e.app, e.machine_id, 8000);
    if (m?.config?.image) e.image = m.config.image;
  }
  const led = await healthJson(e.url ?? estateOrigin(e.app), "/ledger/health", fetchImpl);
  const ok = Boolean(led && led.ok !== false && led.appendable === true);
  const note = ok
    ? "ledger healthy and appendable"
    : led
      ? `ledger answered but appendable=${String(led.appendable)}, ok=${String(led.ok)}`
      : "ledger health did not answer 200 within 6 s";
  const was = e.health?.ok;
  if (was !== undefined && was !== ok) logEstate(e, "health", ok ? "healthy again: " + note : "PROBLEM: " + note, now);
  else if (was === undefined && !ok) logEstate(e, "health", "PROBLEM: " + note, now);
  e.health = { ok, checked_at: now.toISOString(), note };
  await saveEstate(e, now);
  return ok ? "ok" : "unhealthy";
}

export type UpgradeOutcome = "upgraded" | "unchanged" | "failed";

/**
 * Move a ready estate's machine to the configured estate image (FLY_ESTATE_IMAGE,
 * a label that was smoked and deployed on the sandbox first) in the armed
 * posture, then wait until the public origin reports that posture with the
 * SAME ledger signing key. A failure flags the estate (health + the image that
 * failed, which the tick will not retry) and never destroys anything. `force`
 * re-applies the current image (an operator's "re-apply config").
 */
export async function upgradeEstateImage(
  e: Estate,
  fly: FlyClient,
  opts: { now?: Date; fetchImpl?: FetchLike; force?: boolean; polls?: number; sleepMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ estate: Estate; outcome: UpgradeOutcome }> {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cfg = flyConfig();
  if (!cfg) throw new EstateError(501, "provisioning_not_configured", "Provisioning is not configured on this deployment.");
  if (e.status !== "ready" || !e.machine_id || !e.volume_id) throw new EstateError(409, "estate_not_ready", "Only a ready estate can change image.");
  const target = cfg.image;
  if (!opts.force && e.image === target) return { estate: e, outcome: "unchanged" };
  const from = e.image ?? "unknown";
  logEstate(e, "upgrade", `updating the machine image ${from} -> ${target}${opts.force ? " (forced re-apply)" : ""}; armed posture re-verified afterwards`, now);
  await saveEstate(e, now);
  await updateMachineGuarded(e, fly, () => estateMachineConfig(cfg, e.volume_id!, "armed", attestSigner(e.grantor)));

  const origin = e.url ?? estateOrigin(e.app);
  const polls = opts.polls ?? 60;
  const sleepMs = opts.sleepMs ?? 5000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fail = async (note: string): Promise<{ estate: Estate; outcome: UpgradeOutcome }> => {
    const at = new Date();
    e.upgrade_failed_image = target;
    e.health = { ok: false, checked_at: at.toISOString(), note };
    logEstate(e, "upgrade", `FAILED: ${note}; rollout of ${target} halted for this estate`, at);
    await saveEstate(e, at);
    return { estate: e, outcome: "failed" };
  };
  for (let i = 0; i < polls; i++) {
    const p = await armedPosture(origin, fetchImpl);
    if (p.armed) {
      const fp = String(p.ledger?.key_fingerprint ?? "");
      if (e.fingerprints["ledger-sign"] && fp && fp !== e.fingerprints["ledger-sign"]) {
        return fail(`after the image update the ledger reports signing key ${fp.slice(0, 12)}…, not the one generated at bootstrap`);
      }
      const at = new Date();
      e.image = target;
      e.upgrade_failed_image = null;
      e.health = { ok: true, checked_at: at.toISOString(), note: `armed on ${target}` };
      logEstate(e, "upgrade", `armed and healthy on ${target} (ledger build ${p.ledger?.build_sha ?? "?"})`, at);
      await saveEstate(e, at);
      return { estate: e, outcome: "upgraded" };
    }
    await sleep(sleepMs);
  }
  return fail(`the estate did not report the armed posture within ${Math.round((polls * sleepMs) / 1000)} s of the image update`);
}

// --- gateway routing ---------------------------------------------------------------

export type Route =
  | { kind: "sandbox" }
  | { kind: "estate"; url: string; secret: string }
  | { kind: "refuse"; status: number; code: string; message: string };

export function resolveRoute(user: User, estate: Estate | null): Route {
  if (!estate || estate.status === "pending_manual") return { kind: "sandbox" };
  if (estate.status === "ready" && estate.url && !estate.suspend_pending) return { kind: "estate", url: estate.url, secret: estateSecret(estate.app) };
  if (estate.status === "suspended" || estate.suspend_pending) {
    return { kind: "refuse", status: 403, code: "estate_suspended", message: "Your dedicated estate is suspended (subscription not active). Its data is kept; reactivate billing to resume." };
  }
  if (estate.status === "error") {
    return { kind: "refuse", status: 503, code: "estate_error", message: "Your dedicated estate failed to provision; retry from the dashboard or contact Spin State Labs." };
  }
  return { kind: "refuse", status: 503, code: "estate_provisioning", message: `Your dedicated estate is being provisioned (step ${estate.step}); try again in a few minutes.` };
}

/** True while a background worker holds the estate and has written recently. */
export function workerActive(e: Estate, now: Date = new Date()): boolean {
  if (!e.worker_until) return false;
  if (new Date(e.worker_until).getTime() <= now.getTime()) return false;
  return now.getTime() - new Date(e.updated_at).getTime() < 90_000;
}

/** The record as the dashboard sees it: no lease, log capped, nothing secret (there is nothing secret on it). */
export function publicEstate(e: Estate, now: Date = new Date()): Record<string, unknown> {
  return {
    app: e.app,
    worker_active: workerActive(e, now),
    region: e.region,
    status: e.status,
    step: e.step,
    steps: STEPS,
    attempts: e.attempts,
    error: e.error,
    url: e.url,
    grantor: e.grantor,
    roster: e.roster,
    fingerprints: e.fingerprints,
    public_keys: e.public_keys,
    self_agents: Object.keys(e.self_agents),
    posture: e.posture,
    anthropic_key_set_at: e.anthropic_key_set_at,
    image: e.image ?? null,
    health: e.health ?? null,
    upgrade_failed_image: e.upgrade_failed_image ?? null,
    created_at: e.created_at,
    updated_at: e.updated_at,
    ready_at: e.ready_at,
    suspended_at: e.suspended_at,
    suspend_pending: e.suspend_pending ?? null,
    resume_pending: e.resume_pending ?? null,
    log: e.log.slice(-20),
  };
}
