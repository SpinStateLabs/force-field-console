// Force-Field Console — dedicated-estate setup: the step registry.
//
// Source of truth: docs/estate-quickstart.md. Every step of that guide has exactly one entry here, in
// guide order. `sh` blocks are copied verbatim from the guide's fenced code (a test enforces it);
// `ps` blocks are Console-supplied PowerShell 5.1 equivalents (the guide itself only has sh).
// No secret values appear anywhere in this file: `ff_live_...` is the guide's own placeholder and the
// PowerShell variants read the key from a file you create, never from a prompt.
//
// This module is plain data + pure functions (no DOM) so the browser and the vitest suite share it.

export const GUIDE_URL = "https://github.com/SpinStateLabs/force-field-console/blob/main/docs/estate-quickstart.md";
export const GATEWAY_BASE = "https://force-field-console.netlify.app/api/v1";

const PS_PREAMBLE = [
  '# Windows PowerShell 5.1 -- needs the three variables from step 0.4 set in this window.',
  '$h = @{ "x-api-key" = $env:FF_KEY }',
].join("\n");

export const STEPS = [
  {
    id: "roster-scopes",
    slug: "roster-scopes",
    num: "0.1",
    section: "0. Before the first call",
    guideItem: "**Roster scopes.**",
    title: "Save your roster scopes",
    purpose:
      "Tell the estate which scopes your agents may be delegated, the longest token you will mint, and an optional spend ceiling. This is what puts your row on the estate's delegation roster.",
    details: [
      "On the dashboard, save the scopes your agents may be delegated (one per line), the longest token you will mint, and an optional spend ceiling.",
      "Until at least one scope is saved, your row is left off the estate's roster and no token can be minted under your name.",
    ],
    action: { label: "Open the dashboard", href: "app.html", note: "Dashboard > Dedicated estate > Delegation roster. The form appears once the estate is ready." },
    commands: [],
    see: [
      "A saved roster row on the dashboard: your allowed scopes, the longest token and the spend ceiling.",
      "Your grantor string (your account email) is shown beside the roster form. Step 2 must use it exactly.",
    ],
    fail: [
      "No scope saved: your row is left off the estate's roster and no token can be minted under your name.",
      "A later mint is refused with 403 D.grantor if you are not on the roster, are inactive, or ask for a scope you may not delegate (step 2).",
    ],
    status: "roster",
  },
  {
    id: "anthropic-key",
    slug: "anthropic-key",
    num: "0.2",
    section: "0. Before the first call",
    guideItem: "**Anthropic key**",
    title: "Place your Anthropic key",
    purpose:
      "Only needed for governed LLM calls (step 4). Model calls from your estate use your own Anthropic key.",
    details: [
      "Place your own key on the dashboard. It is set as a secret on your estate and never stored by the console.",
      "Type or paste the key only into the dashboard's key field. This page never asks for it, never shows it and never receives it.",
    ],
    action: { label: "Open the dashboard", href: "app.html", note: "Dashboard > Dedicated estate > Anthropic API key (bring your own)." },
    commands: [],
    see: [
      "The dashboard's estate facts list \"Anthropic key: placed\" with a time. The key itself is never displayed.",
    ],
    fail: [
      "Without an Anthropic key on the estate the upstream call in step 4 answers 502.",
      "The dashboard says the estate restarts to apply the key (about a minute); retry the call after that.",
    ],
    status: "anthropic",
  },
  {
    id: "api-key",
    slug: "api-key",
    num: "0.3",
    section: "0. Before the first call",
    guideItem: "**API key**:",
    title: "Create a console API key",
    purpose:
      "Every call below goes through the console gateway with your console API key in the x-api-key header.",
    details: [
      "Create one on the dashboard. Rate limits are per tier (see the pricing table).",
      "A key's plaintext is shown once, at creation; the console stores only a hash. Save it to a file only you can read, for example %USERPROFILE%\\.force-field\\console-key.txt, and refer to it by that path.",
    ],
    action: { label: "Open the dashboard", href: "app.html", note: "Dashboard > API keys > New key. Up to 5 active keys per account." },
    commands: [],
    see: ["The new key appears in the API keys table with its prefix. The full key is shown once, in a dialog."],
    fail: [
      "Requests over your tier's per-minute or per-day limit are refused until the window passes.",
      "More than 5 active keys: revoke one first.",
    ],
    status: "apikey",
  },
  {
    id: "environment",
    slug: "environment",
    num: "0.4",
    section: "0. Before the first call",
    guideItem: "Set these for the examples:",
    title: "Set the example variables",
    purpose:
      "The commands in steps 1 to 6 read three variables: the gateway base URL, your console API key, and your account email.",
    details: [
      "Set these for the examples. FF_KEY is your console API key; ME is your account email, which is your grantor and owner string.",
      "The PowerShell block reads the key from a file instead of asking you to type or paste it into the shell.",
    ],
    commands: [
      {
        label: "Variables",
        sh: "export FF=https://force-field-console.netlify.app/api/v1\nexport FF_KEY=ff_live_...            # your console API key\nexport ME=you@example.com            # your account email = your grantor / owner string",
        ps: '$env:FF = "https://force-field-console.netlify.app/api/v1"\n$env:FF_KEY = (Get-Content "$env:USERPROFILE\\.force-field\\console-key.txt" -Raw).Trim()   # file holding your console API key\n$env:ME = "you@example.com"   # your account email = your grantor / owner string',
      },
    ],
    see: [
      "No output. The variables exist only in the shell window where you set them.",
    ],
    fail: [
      "ME must equal your account email exactly: granted_by in step 2 has to match your grantor string exactly.",
      "A new shell window starts without these variables; set them again.",
    ],
    status: "environment",
  },
  {
    id: "register-agent",
    slug: "register-agent",
    num: "1",
    section: "1. Register an agent",
    guideHeading: "## 1. Register an agent",
    title: "Register an agent",
    purpose:
      "Put the agent in the estate's registry. The owner must be a human: use your account email, which is also on the estate's owner roster.",
    details: [
      "The daily lifecycle sweep escalates agents whose owner is not on the owner roster; it never kills anything.",
      "agent_id is a slug (^[a-z0-9][a-z0-9._-]*$). Add \"manifest_ref\" when the agent has a FIELD manifest on the estate; a ref that does not resolve is refused with 422.",
    ],
    commands: [
      {
        label: "Register invoice-bot",
        sh: `curl -s -X POST "$FF/registry/agents" -H "x-api-key: $FF_KEY" -H "content-type: application/json" \\\n  -d '{"agent_id":"invoice-bot","name":"Invoice bot","owner":"'"$ME"'","domain":"finance"}'`,
        ps: `${PS_PREAMBLE}\n$body = @{ agent_id = "invoice-bot"; name = "Invoice bot"; owner = $env:ME; domain = "finance" } | ConvertTo-Json -Compress\nInvoke-RestMethod -Method Post -Uri "$env:FF/registry/agents" -Headers $h -ContentType "application/json" -Body $body`,
      },
    ],
    see: ["The agent is listed by the registry call in step 6 (GET /registry/agents)."],
    fail: [
      "422 when a manifest_ref does not resolve on the estate.",
      "The agent_id must match the slug pattern above.",
      "The sweep escalates (but never kills) agents whose owner is not on the owner roster.",
    ],
    status: "estate-ready",
  },
  {
    id: "mint-token",
    slug: "mint-token",
    num: "2",
    section: "2. Mint a delegation token",
    guideHeading: "## 2. Mint a delegation token",
    title: "Mint a delegation token",
    purpose:
      "Give the agent a scoped, time-limited delegation. granted_by must equal your grantor string exactly (your account email), the scopes must be a subset of the scopes you saved on the dashboard, and the TTL must not exceed the longest token you allowed there.",
    details: [
      "The answer carries token_id; keep it with the agent. Every mint and revoke is a signed ledger event.",
      "To revoke, POST $FF/delegation/tokens/<token_id>/revoke.",
    ],
    commands: [
      {
        label: "Mint a 24-hour token",
        sh: `curl -s -X POST "$FF/delegation/tokens" -H "x-api-key: $FF_KEY" -H "content-type: application/json" \\\n  -d '{"agent_id":"invoice-bot","granted_by":"'"$ME"'","scope":["draft invoice"],"ttl_seconds":86400}'`,
        ps: `${PS_PREAMBLE}\n$body = @{ agent_id = "invoice-bot"; granted_by = $env:ME; scope = @("draft invoice"); ttl_seconds = 86400 } | ConvertTo-Json -Compress\nInvoke-RestMethod -Method Post -Uri "$env:FF/delegation/tokens" -Headers $h -ContentType "application/json" -Body $body`,
      },
      {
        label: "Revoke (replace <token_id>)",
        sh: 'curl -s -X POST "$FF/delegation/tokens/<token_id>/revoke" -H "x-api-key: $FF_KEY"',
        derivedSh: true,
        sNote: "The guide gives only the route, POST $FF/delegation/tokens/<token_id>/revoke; this curl form is expanded from it.",
        ps: `${PS_PREAMBLE}\nInvoke-RestMethod -Method Post -Uri "$env:FF/delegation/tokens/<token_id>/revoke" -Headers $h`,
      },
    ],
    see: ["A JSON answer carrying token_id. Keep it with the agent; step 3 and step 4 use it."],
    fail: [
      "403 D.grantor: you are not on the roster, are inactive, or asked for a scope you may not delegate.",
      "422 D.scope: the scope is outside the agent's manifest.",
      "403 when the TTL is past your ceiling.",
    ],
    status: "estate-ready",
  },
  {
    id: "sentinel-check",
    slug: "sentinel-check",
    num: "3",
    section: "3. Check an action before taking it",
    guideHeading: "## 3. Check an action before taking it",
    title: "Check an action before taking it",
    purpose: "Ask the sentinel whether the agent may take an action under its token, before it does.",
    details: ["Replace <token_id> with the value from step 2."],
    commands: [
      {
        label: "Sentinel check",
        sh: `curl -s -X POST "$FF/sentinel/check" -H "x-api-key: $FF_KEY" -H "content-type: application/json" \\\n  -d '{"agent_id":"invoice-bot","action":"draft invoice","token_id":"<token_id>"}'`,
        ps: `${PS_PREAMBLE}\n$body = @{ agent_id = "invoice-bot"; action = "draft invoice"; token_id = "<token_id>" } | ConvertTo-Json -Compress\nInvoke-RestMethod -Method Post -Uri "$env:FF/sentinel/check" -Headers $h -ContentType "application/json" -Body $body`,
      },
    ],
    see: [
      "A verdict: ALLOW, BLOCK or ESCALATE, with the reason code.",
    ],
    fail: [
      "A BLOCK or ESCALATE names its reason: R.unregistered, D.scope, E.kill_switch, E.spend_cap, E.rate_limit, L.unreachable, and others.",
      "A BLOCK is itself a ledger event.",
    ],
    status: "estate-ready",
  },
  {
    id: "governed-call",
    slug: "governed-call",
    num: "4",
    section: "4. Make a governed LLM call",
    guideHeading: "## 4. Make a governed LLM call",
    title: "Make a governed LLM call",
    purpose:
      "The estate's gateway is an Anthropic-Messages-shaped endpoint that checks identity and authority on every call before it forwards anything.",
    details: [
      "x-field-action names the action the sentinel checks (it must be inside the token's scope); x-force-preset selects a FORCE prompt-hygiene preset.",
      "Token usage is metered to the agent's spend cap on the governor. Responses are buffered and requests time out after 30 seconds.",
    ],
    commands: [
      {
        label: "Governed message",
        sh: `curl -s -X POST "$FF/gateway/v1/messages" -H "x-api-key: $FF_KEY" -H "content-type: application/json" \\\n  -H "x-field-agent-id: invoice-bot" -H "x-field-token: <token_id>" -H "x-field-action: draft invoice" \\\n  -d '{"model":"claude-haiku-4-5","max_tokens":200,"messages":[{"role":"user","content":"Draft a two-line invoice note."}]}'`,
        ps: `$h = @{ "x-api-key" = $env:FF_KEY; "x-field-agent-id" = "invoice-bot"; "x-field-token" = "<token_id>"; "x-field-action" = "draft invoice" }\n$body = @{ model = "claude-haiku-4-5"; max_tokens = 200; messages = @(@{ role = "user"; content = "Draft a two-line invoice note." }) } | ConvertTo-Json -Depth 5 -Compress\nInvoke-RestMethod -Method Post -Uri "$env:FF/gateway/v1/messages" -Headers $h -ContentType "application/json" -Body $body`,
      },
    ],
    see: ["An Anthropic-Messages-shaped answer, after the gateway has checked identity and authority."],
    fail: [
      "401: the identity headers are missing.",
      "502: there is no Anthropic key on the estate (step 0.2).",
      "A refusal from the sentinel if x-field-action is outside the token's scope (see step 3).",
    ],
    status: "governed",
  },
  {
    id: "attest-pack",
    slug: "attest-pack",
    num: "5",
    section: "5. Download an attestation pack and verify it off-box",
    guideHeading: "## 5. Download an attestation pack and verify it off-box",
    title: "Download an attestation pack and verify it off-box",
    purpose:
      "Download the signed board pack for a period and verify it on your own machine with the engine's CLI from the public repository SpinStateLabs/field-platform.",
    details: [
      "The served pack is signed with the estate's attestation key. Its fingerprint and public key are on the dashboard and below.",
      "Every metric in the pack carries the ledger query that produced it, so any number can be re-run.",
    ],
    commands: [
      {
        label: "Download the pack (period 2026-Q3)",
        sh: `curl -s "$FF/attest/pack?period=2026-Q3" -H "x-api-key: $FF_KEY" > board-pack.json\ncurl -s "$FF/attest/pack.html?period=2026-Q3" -H "x-api-key: $FF_KEY" > board-pack.html`,
        ps: `${PS_PREAMBLE}\nInvoke-WebRequest -UseBasicParsing -Uri "$env:FF/attest/pack?period=2026-Q3" -Headers $h -OutFile board-pack.json\nInvoke-WebRequest -UseBasicParsing -Uri "$env:FF/attest/pack.html?period=2026-Q3" -Headers $h -OutFile board-pack.html`,
        psNote: "Uses -OutFile: in Windows PowerShell 5.1 the > operator writes UTF-16, which would break verification.",
      },
      {
        label: "Verify off-box",
        sh: "attest verify board-pack.json --pubkey attest-sign.pub.pem",
        ps: "attest verify board-pack.json --pubkey attest-sign.pub.pem",
        shared: true,
      },
    ],
    see: [
      "attest verify succeeds against attest-sign.pub.pem, the public key shown on this page.",
      "The attest-sign fingerprint shown on this page matches the one on the dashboard.",
    ],
    fail: [
      "The guide lists no failure codes for this step. If verification fails, the pack was altered or the public key is not your estate's: compare the fingerprint on this page with the dashboard before anything else.",
    ],
    status: "attest",
    publicKey: "attest-sign",
  },
  {
    id: "read-ledger",
    slug: "read-ledger",
    num: "6",
    section: "6. Read the ledger and the registry",
    guideHeading: "## 6. Read the ledger and the registry",
    title: "Read the ledger and the registry",
    purpose:
      "Check that the ledger is signing, list the registered agents, and read the daily lifecycle sweep's report.",
    details: [
      "The ledger's key_fingerprint must equal the ledger-sign fingerprint on your dashboard; it was generated inside your estate at bootstrap and the private key never leaves it.",
    ],
    commands: [
      {
        label: "Ledger health, registry, lifecycle findings",
        sh: `curl -s "$FF/ledger/health" -H "x-api-key: $FF_KEY"          # signing: on, require_signing, appendable, key fingerprint\ncurl -s "$FF/registry/agents" -H "x-api-key: $FF_KEY"\ncurl -s "$FF/lifecycle/findings" -H "x-api-key: $FF_KEY"     # the daily sweep's report (404 before the first sweep)`,
        ps: `${PS_PREAMBLE}\nInvoke-RestMethod -Uri "$env:FF/ledger/health" -Headers $h      # signing: on, require_signing, appendable, key fingerprint\nInvoke-RestMethod -Uri "$env:FF/registry/agents" -Headers $h\nInvoke-RestMethod -Uri "$env:FF/lifecycle/findings" -Headers $h   # the daily sweep's report (404 before the first sweep)`,
      },
    ],
    see: [
      "ledger/health reports signing on, require_signing, appendable and a key fingerprint equal to the ledger-sign fingerprint shown on this page.",
      "registry/agents lists invoice-bot once step 1 has succeeded.",
    ],
    fail: [
      "lifecycle/findings answers 404 before the first daily sweep. That is expected, not an error.",
      "A key_fingerprint that differs from the ledger-sign fingerprint on the dashboard is a problem to raise with Spin State Labs.",
    ],
    status: "ledger",
  },
  {
    id: "console-boundaries",
    slug: "console-boundaries",
    num: "i",
    section: "What the console does to your estate, and what it does not",
    guideHeading: "## What the console does to your estate, and what it does not",
    title: "What the console does to your estate",
    purpose: "Reference, not a task: what the console does to your estate and, as importantly, what it never does.",
    details: [],
    bullets: [
      "It never reads your ledger contents, your keys, or your Anthropic key.",
      "A scheduled check every two minutes looks at /ledger/health and flags a problem on the dashboard; it never stops, restarts or destroys the estate.",
      "When Spin State Labs publishes a new engine image (smoked on the public sandbox first), your estate follows it: one machine update in the armed posture, then the posture and your ledger's signing key are re-verified; a failure halts the rollout for your estate and shows on the dashboard.",
      "A cancelled subscription stops the machine and keeps the volume; destroying an estate is a manual operator action, never automatic.",
      "The three platform self-agents inside your estate (sentinel, gateway, crosswalk) renew their own 30-day tokens automatically after 25 days, with one brief restart.",
    ],
    commands: [],
    see: ["The dashboard shows the estate's health check, engine image and any halted rollout (live values above)."],
    fail: ["A failed rollout halts for your estate and shows on the dashboard; Spin State Labs investigates before retrying."],
    status: "boundaries",
  },
];

export const OVERVIEW = {
  slug: "overview",
  title: "Dedicated-estate setup",
  intro: [
    "For Operator and Sovereign accounts whose dashboard shows the estate as ready. Everything goes through the console gateway, https://force-field-console.netlify.app/api/v1/<service>/..., with your console API key in x-api-key.",
    "The gateway strips /api/v1, adds the estate's own perimeter secret, and forwards your x-field-* and x-force-* headers (never cookies, Authorization, or a caller-supplied x-field-auth). Responses are buffered; requests time out after 30 s.",
    "The estate is a Force-Field Protocol engine: thirteen services behind one origin, in the armed posture (per-event ledger signing required, served attestations signed, gateway enforcement with tool checks, and a delegation roster that gates every mint).",
  ],
};

export const SLUGS = STEPS.map((s) => s.slug);

/** Parse a location hash such as "#roster-scopes" or "#/roster-scopes" into a step index, or -1. */
export function indexFromHash(hash) {
  const h = String(hash || "").replace(/^#\/?/, "").trim().toLowerCase();
  return SLUGS.indexOf(h);
}

export function hashFor(slug) {
  return "#" + slug;
}

// ---------------------------------------------------------------------------
// Live status. Pure: takes what the portal already knows and says only what that supports.
//   ctx = { signedIn: bool, me, estate (object | null | undefined), estateError, keys (array | null) }
// kind: "ok" (verified true), "warn" (needs action), "err", "info" (not tracked / no claim).
// Nothing here ever returns "ok" for a step whose completion the console cannot observe.
// ---------------------------------------------------------------------------

const NEEDS_READY = new Set(["estate-ready", "governed", "attest", "ledger", "roster", "anthropic"]);

export function stepStatus(statusKey, ctx) {
  if (!ctx || !ctx.signedIn) {
    return { kind: "info", label: "signed out", text: "Sign in to see live status for this step. The commands below work the same either way." };
  }
  const estate = ctx.estate;
  const activeKeys = Array.isArray(ctx.keys) ? ctx.keys.filter((k) => !k.revoked).length : null;

  if (statusKey === "apikey") {
    if (activeKeys === null) return { kind: "info", label: "unknown", text: "Could not read your API keys just now." };
    if (activeKeys > 0) return { kind: "ok", label: "key exists", text: activeKeys + " active API key" + (activeKeys === 1 ? "" : "s") + " on this account. Only the prefix is known to the console." };
    return { kind: "warn", label: "no key yet", text: "No active API key yet. Create one on the dashboard." };
  }
  if (statusKey === "environment") {
    const email = ctx.me && ctx.me.email ? ctx.me.email : null;
    return { kind: "info", label: "your values", text: email ? "Your account email, which is your grantor and owner string: " + email : "Use your account email as ME.", email };
  }

  if (estate === undefined) {
    return { kind: "info", label: "unknown", text: ctx.estateError || "Estate status could not be read just now." };
  }
  if (estate === null) {
    return { kind: "warn", label: "no estate", text: "No dedicated estate on this account yet. Dedicated estates come with the Operator and Sovereign tiers; the record is created when Stripe confirms the subscription." };
  }
  if (statusKey === "boundaries") {
    const bits = [];
    bits.push("Estate status: " + String(estate.status));
    if (estate.health) bits.push("last health check: " + (estate.health.ok ? "ok" : "PROBLEM") + (estate.health.note ? " (" + estate.health.note + ")" : ""));
    if (estate.image) bits.push("engine image: " + estate.image);
    if (estate.upgrade_failed_image) bits.push("rollout HALTED for image " + estate.upgrade_failed_image);
    const bad = estate.upgrade_failed_image || (estate.health && !estate.health.ok);
    return { kind: bad ? "err" : "info", label: bad ? "needs attention" : "as reported", text: bits.join(" · ") };
  }
  if (estate.status !== "ready") {
    const why = {
      provisioning: "The estate is still provisioning; this step becomes available once it is ready.",
      pending_manual: "Spin State Labs provisions this estate by hand; this step becomes available once it is ready.",
      suspended: "The estate is suspended (subscription not active). The machine is stopped and the data is kept.",
      error: "Provisioning failed. See the dashboard for the error and the retry button.",
    }[estate.status] || "The estate is not ready.";
    return { kind: estate.status === "error" || estate.status === "suspended" ? "err" : "warn", label: "estate " + String(estate.status).replace("_", " "), text: why };
  }

  switch (statusKey) {
    case "roster": {
      const scopes = estate.roster && Array.isArray(estate.roster.allowed_scope) ? estate.roster.allowed_scope : [];
      if (scopes.length > 0) {
        return { kind: "ok", label: "saved", text: scopes.length + " scope" + (scopes.length === 1 ? "" : "s") + " saved; longest token " + (estate.roster.max_ttl_days || "?") + " days; spend ceiling " + (estate.roster.max_spend_usd === null || estate.roster.max_spend_usd === undefined ? "none" : "$" + estate.roster.max_spend_usd) + "." };
      }
      return { kind: "warn", label: "not saved", text: "No scope saved. Until you save at least one, your row is left off the roster and no token can be minted." };
    }
    case "anthropic":
      return estate.anthropic_key_set_at
        ? { kind: "ok", label: "placed", text: "Your Anthropic key was placed " + estate.anthropic_key_set_at + ". The key itself is never visible to the console." }
        : { kind: "warn", label: "not placed", text: "No Anthropic key placed. Governed LLM calls (step 4) answer 502 until you do." };
    case "governed":
      return estate.anthropic_key_set_at
        ? { kind: "info", label: "estate ready", text: "The estate is ready and an Anthropic key is placed. The console cannot see whether you have made a call (it never reads your ledger)." }
        : { kind: "warn", label: "key missing", text: "The estate is ready but no Anthropic key is placed (step 0.2), so this call would answer 502." };
    case "attest": {
      const fp = estate.fingerprints && estate.fingerprints["attest-sign"];
      return fp
        ? { kind: "info", label: "estate ready", text: "Your estate's attest-sign fingerprint is shown here. The console cannot see whether you have downloaded or verified a pack.", fingerprint: fp }
        : { kind: "warn", label: "no key listed", text: "The estate is ready but no attest-sign fingerprint is on record; contact Spin State Labs." };
    }
    case "ledger": {
      const fp = estate.fingerprints && estate.fingerprints["ledger-sign"];
      return { kind: "info", label: "estate ready", text: "The estate is ready. Compare the ledger-sign fingerprint shown here with key_fingerprint from ledger/health. The console cannot see your registry or ledger.", fingerprint: fp || null };
    }
    default:
      return { kind: "info", label: "estate ready", text: "The estate is ready, so this step can run. The console cannot see whether you have done it: it never reads your ledger or registry." };
  }
}

/** Steps whose state the console can verify, for the small marks in the step list. */
export function navMark(step, ctx) {
  if (!["roster", "anthropic", "apikey"].includes(step.status)) return null;
  const s = stepStatus(step.status, ctx);
  return s.kind === "ok" ? "verified" : null;
}

export { NEEDS_READY };

// ---------------------------------------------------------------------------
// Placement: which console surface hosts each step (Don, 2026-10-23). "portal" is this console
// (customer portal). "ops" is the FIELD ops console (a separate PR); it reuses these step ids,
// numbers, titles and copy. `primary` is where the step is meant to be done.
// ---------------------------------------------------------------------------
const PLACEMENT = {
  "roster-scopes": { surfaces: ["portal"], primary: "portal" },
  "anthropic-key": { surfaces: ["portal"], primary: "portal" },
  "api-key": { surfaces: ["portal"], primary: "portal" },
  environment: { surfaces: ["portal"], primary: "portal" },
  "register-agent": { surfaces: ["portal", "ops"], primary: "portal" },
  "mint-token": { surfaces: ["portal", "ops"], primary: "ops" },
  "sentinel-check": { surfaces: ["portal", "ops"], primary: "portal" },
  "governed-call": { surfaces: ["portal"], primary: "portal" },
  "attest-pack": { surfaces: ["portal", "ops"], primary: "ops" },
  "read-ledger": { surfaces: ["portal", "ops"], primary: "ops" },
  "console-boundaries": { surfaces: ["portal"], primary: "portal" },
};
for (const s of STEPS) Object.assign(s, PLACEMENT[s.id]);

const OPS_NOTES = {
  "mint-token": "Minting and revoking are authority actions: the FIELD ops console is the primary place to do them, guarded by operator keys. The commands here work with your console API key.",
  "attest-pack": "The FIELD ops console is the primary place to download packs. This page shows the summary you need to verify one: the key fingerprint, the public key and the verify command.",
  "read-ledger": "The FIELD ops console has the full ledger and registry views. This page shows the summary: the ledger-sign fingerprint to compare against ledger/health.",
};
export const ALSO_IN_OPS = "Also in the FIELD ops console";
export function opsNote(step) {
  if (!step.surfaces.includes("ops")) return null;
  return OPS_NOTES[step.id] || "This step is also available in the FIELD ops console. The commands here work on their own.";
}

/** Plain-JSON export for the ops-console PR: ids, numbers, titles, placement and copy, no functions. */
export function exportRegistry() {
  return JSON.parse(JSON.stringify({ guide: GUIDE_URL, steps: STEPS.map((s) => ({ ...s, opsNote: opsNote(s) })) }));
}
