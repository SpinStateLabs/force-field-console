// Force-Field Console — dashboard client (vanilla ES module).
// All user-derived strings are rendered via textContent / createElement —
// never innerHTML with data. Secrets typed here (the Anthropic key) go
// straight to the API and are cleared from the form; nothing is kept.

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// fetch helpers
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const init = {
    method: opts.method || "GET",
    credentials: "same-origin",
    headers: {},
  };
  if (opts.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    return { status: 0, ok: false, data: null };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // 204 or non-JSON body — leave data null.
  }
  return { status: res.status, ok: res.ok, data };
}

// Prefer the server's honest { error: { code, message } } body; fall back to
// a plain HTTP description. 501 (not configured) and 503 (estate not
// attached / provisioning) carry their own honest messages from the backend.
function errMessage(status, data) {
  if (data && data.error && typeof data.error.message === "string" && data.error.message) {
    return data.error.message;
  }
  if (status === 0) return "Network error — the console could not be reached.";
  if (status === 503) return "Service unavailable (503).";
  if (status === 501) return "Not configured on this deployment (501).";
  return "Request failed (HTTP " + status + ").";
}

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function setError(el, msg) {
  if (msg) {
    el.textContent = msg;
    show(el);
  } else {
    el.textContent = "";
    hide(el);
  }
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

// ---------------------------------------------------------------------------
// state machine: unauthed <-> dashboard
// ---------------------------------------------------------------------------

let authMode = "login";
let healthChecked = false; // health is polled once per page load
let flags = null;          // /api/health capability flags
let currentMe = null;
let estatePollTimer = null;
let rosterDirty = false;
let returnParams = null;   // ?checkout=… / ?upgrade=… captured at boot

async function boot() {
  const url = new URL(window.location.href);
  returnParams = { checkout: url.searchParams.get("checkout"), upgrade: url.searchParams.get("upgrade") };
  if (returnParams.checkout || returnParams.upgrade) {
    history.replaceState(null, "", url.pathname);
  }
  const me = await api("/api/me");
  hide($("boot-note"));
  if (me.status === 200 && me.data) {
    enterDashboard(me.data);
  } else {
    showAuthView();
  }
}

function showAuthView() {
  hide($("boot-note"));
  hide($("dash-view"));
  show($("auth-view"));
  $("keys-body").replaceChildren();
  stopEstatePoll();
  $("auth-email").focus();
}

function enterDashboard(me) {
  currentMe = me;
  hide($("boot-note"));
  hide($("auth-view"));
  show($("dash-view"));

  $("acct-email").textContent = me.email || "";
  const tierChip = $("acct-tier");
  tierChip.className = "chip chip-ok";
  tierChip.textContent = me.tier || "";

  const lim = me.limits || {};
  const rpm = typeof lim.rpm === "number" ? lim.rpm : "?";
  const rpd = typeof lim.rpd === "number" ? lim.rpd : "?";
  $("acct-limits").textContent = rpm + " req/min · " + rpd + " req/day";

  renderQuickstart();
  renderBilling(me);
  refreshKeys();
  loadEstate();
  if (!healthChecked) {
    healthChecked = true;
    checkHealth();
  }
  handleReturnParams();
}

// ---------------------------------------------------------------------------
// auth: register / login / logout
// ---------------------------------------------------------------------------

function setAuthMode(mode) {
  authMode = mode;
  const login = $("tab-login");
  const reg = $("tab-register");
  login.classList.toggle("active", mode === "login");
  reg.classList.toggle("active", mode === "register");
  login.setAttribute("aria-selected", String(mode === "login"));
  reg.setAttribute("aria-selected", String(mode === "register"));
  $("auth-submit").textContent = mode === "login" ? "Log in" : "Create account";
  $("auth-password").setAttribute(
    "autocomplete",
    mode === "login" ? "current-password" : "new-password"
  );
  setError($("auth-error"), "");
}

async function submitAuth(ev) {
  ev.preventDefault();
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const btn = $("auth-submit");
  btn.disabled = true;
  const path = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
  const res = await api(path, { method: "POST", body: { email, password } });
  btn.disabled = false;
  if (res.status === 200 || res.status === 201) {
    $("auth-password").value = "";
    setError($("auth-error"), "");
    const me = await api("/api/me");
    if (me.status === 200 && me.data) {
      enterDashboard(me.data);
    } else {
      setError($("auth-error"), errMessage(me.status, me.data));
    }
  } else {
    setError($("auth-error"), errMessage(res.status, res.data));
  }
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  showAuthView();
}

// ---------------------------------------------------------------------------
// billing: plan summary, Stripe Checkout, Customer Portal
// ---------------------------------------------------------------------------

function renderBilling(me) {
  const tier = me.tier || "sandbox";
  const b = me.billing || null;
  let summary = "Current plan: " + tier + ".";
  if (b && b.status) {
    summary += " Subscription " + b.status + ".";
    if (b.current_period_end) summary += " Current period ends " + fmtTime(b.current_period_end) + ".";
  }
  $("billing-summary").textContent = summary;

  const configured = flags ? flags.billing_configured === true : null;
  const note = $("billing-note");
  if (configured === false) {
    note.textContent = "Paid checkout is not enabled on this deployment; paid tiers are not for sale here.";
    show(note);
  } else if (!returnParams || !returnParams.checkout) {
    hide(note);
  }

  const paid = tier === "operator" || tier === "sovereign";
  const upOp = $("upgrade-operator");
  const upSov = $("upgrade-sovereign");
  const manage = $("manage-billing");
  upOp.disabled = configured === false;
  upSov.disabled = configured === false;
  if (paid) {
    hide(upOp);
    if (tier === "operator") { show(upSov); upSov.textContent = "Change plan via billing portal"; upSov.disabled = true; } else { hide(upSov); }
  } else {
    show(upOp);
    show(upSov);
    upSov.textContent = "Upgrade to Sovereign ($249/mo)";
  }
  if (b && b.has_customer) show(manage); else hide(manage);
}

async function startCheckout(tier, btn) {
  btn.disabled = true;
  setError($("billing-error"), "");
  const res = await api("/api/billing/checkout", { method: "POST", body: { tier } });
  if (res.status === 200 && res.data && typeof res.data.url === "string") {
    window.location.assign(res.data.url);
    return;
  }
  btn.disabled = false;
  if (res.status === 401) { showAuthView(); return; }
  setError($("billing-error"), errMessage(res.status, res.data));
}

async function openBillingPortal() {
  const btn = $("manage-billing");
  btn.disabled = true;
  setError($("billing-error"), "");
  const res = await api("/api/billing/portal", { method: "POST" });
  if (res.status === 200 && res.data && typeof res.data.url === "string") {
    window.location.assign(res.data.url);
    return;
  }
  btn.disabled = false;
  setError($("billing-error"), errMessage(res.status, res.data));
}

// After Stripe redirects back: the tier changes when the webhook lands, so
// poll /api/me for a short while instead of pretending the upgrade happened.
function handleReturnParams() {
  if (!returnParams) return;
  const note = $("billing-note");
  if (returnParams.checkout === "success") {
    note.textContent = "Payment received. Your plan updates when Stripe's webhook arrives (normally within seconds) — this page checks automatically.";
    show(note);
    let tries = 0;
    const startTier = currentMe ? currentMe.tier : null;
    const timer = setInterval(async () => {
      tries += 1;
      const me = await api("/api/me");
      if (me.status === 200 && me.data && me.data.tier !== startTier) {
        clearInterval(timer);
        returnParams = null;
        enterDashboard(me.data);
      } else if (tries >= 24) {
        clearInterval(timer);
        note.textContent = "Stripe has not confirmed the subscription yet. Reload in a minute; if the plan still shows sandbox, contact Spin State Labs — nothing is lost, the webhook retries.";
      }
    }, 5000);
  } else if (returnParams.checkout === "cancelled") {
    note.textContent = "Checkout cancelled; nothing was charged.";
    show(note);
  }
  if (returnParams.upgrade === "operator" || returnParams.upgrade === "sovereign") {
    const panel = $("billing-panel");
    panel.classList.add("panel-highlight");
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => panel.classList.remove("panel-highlight"), 4000);
  }
  returnParams = returnParams.checkout === "success" ? returnParams : null;
}

// ---------------------------------------------------------------------------
// dedicated estate: status, provisioning progress, BYO key, roster row
// ---------------------------------------------------------------------------

const STEP_LABELS = {
  create_app: "Create the Fly.io app",
  allocate_ips: "Allocate public IPs",
  create_volume: "Create the data volume",
  set_base_secrets: "Set the estate secret",
  create_machine: "Launch the machine",
  wait_boot: "Wait for the estate to boot",
  bootstrap: "Generate keys, manifests and roster",
  provision_sentinel: "Provision the sentinel identity",
  provision_gateway: "Provision the gateway identity",
  provision_crosswalk: "Provision the crosswalk identity",
  arm: "Arm the posture (signing, attestation, enforcement)",
  wait_armed: "Verify the armed posture",
};

function stopEstatePoll() {
  if (estatePollTimer) {
    clearInterval(estatePollTimer);
    estatePollTimer = null;
  }
}

async function loadEstate() {
  const res = await api("/api/estate");
  if (res.status === 401) { showAuthView(); return; }
  const panel = $("estate-panel");
  const paid = currentMe && (currentMe.tier === "operator" || currentMe.tier === "sovereign");
  if (res.status !== 200 || !res.data) {
    if (paid) {
      show(panel);
      setError($("estate-error"), errMessage(res.status, res.data));
    } else {
      hide(panel);
    }
    return;
  }
  const estate = res.data.estate;
  if (!estate) {
    if (paid) {
      show(panel);
      $("estate-status").className = "chip chip-warn";
      $("estate-status").textContent = "not created yet";
      $("estate-note").textContent = "The estate record is created when Stripe confirms the subscription.";
    } else {
      hide(panel);
    }
    return;
  }
  show(panel);
  renderEstate(estate, res.data.provisioning_configured === true);
  if (estate.status === "provisioning" && res.data.provisioning_configured === true) {
    if (!estate.worker_active) kickWorker();
    startEstatePoll();
  }
}

// The slow work runs in a background function (up to 15 minutes); the page
// only kicks it and watches the record. Netlify answers 202 immediately.
let lastKick = 0;
async function kickWorker() {
  if (Date.now() - lastKick < 30000) return;
  lastKick = Date.now();
  await api("/.netlify/functions/estate-worker-background", { method: "POST", body: { action: "advance" } });
}

function startEstatePoll() {
  if (estatePollTimer) return;
  estatePollTimer = setInterval(pollEstate, 5000);
}

async function pollEstate() {
  const res = await api("/api/estate");
  if (res.status === 401) { showAuthView(); return; }
  if (res.status !== 200 || !res.data || !res.data.estate) {
    setError($("estate-error"), errMessage(res.status, res.data));
    return;
  }
  const estate = res.data.estate;
  renderEstate(estate, res.data.provisioning_configured === true);
  if (estate.status !== "provisioning") { stopEstatePoll(); return; }
  if (!estate.worker_active) kickWorker();
}

async function retryEstate() {
  const btn = $("estate-retry");
  btn.disabled = true;
  const res = await api("/api/estate/retry", { method: "POST" });
  btn.disabled = false;
  if (res.status === 200 && res.data && res.data.estate) {
    renderEstate(res.data.estate, true);
    if (res.data.estate.status === "provisioning") { lastKick = Date.now(); startEstatePoll(); }
  } else {
    setError($("estate-error"), errMessage(res.status, res.data));
  }
}

function renderEstate(e, configured) {
  const chip = $("estate-status");
  const cls = { ready: "chip-ok", provisioning: "chip-warn", pending_manual: "chip-warn", suspended: "chip-err", error: "chip-err" };
  chip.className = "chip " + (cls[e.status] || "chip-muted");
  chip.textContent = String(e.status || "").replace("_", " ");

  const urlWrap = $("estate-url-wrap");
  if (e.url) {
    $("estate-url").textContent = e.url;
    $("estate-url").href = e.url;
    show(urlWrap);
  } else {
    hide(urlWrap);
  }

  const notes = {
    ready: "Your estate is armed: per-event ledger signing required, served attestations signed, gateway enforcement with tool checks, and the delegation roster below gates every mint. Requests through /api/v1/* with your API keys reach it.",
    provisioning: "Provisioning runs in the background (a scheduled check restarts it every two minutes if it stalls); typically a few minutes, and every step is shown here.",
    pending_manual: "Automatic provisioning is not enabled on this deployment; Spin State Labs provisions this estate by hand and this page updates when it is ready.",
    suspended: "Suspended: the subscription is not active. The machine is stopped and the data is kept; reactivate billing to resume.",
    error: "Provisioning failed. The last error is shown below; retry once the cause is fixed, or contact Spin State Labs.",
  };
  let note = notes[e.status] || "";
  if (e.resume_pending) {
    note = e.resume_pending.failed
      ? "Your subscription is active, but the estate's machine could not be restarted automatically. Spin State Labs needs to step in."
      : "Your subscription is active; the estate's machine is being restarted (retried automatically).";
  } else if (e.status === "error" && /^machine_missing/.test(String(e.error || ""))) {
    note = "The machine behind your estate is gone; your data volume is kept. Retry re-creates the machine on it.";
  } else if (e.suspend_pending) {
    note = e.suspend_pending.failed ? "The estate's suspension could not be completed automatically; Spin State Labs needs to step in." : "The estate is being suspended (the subscription is not active).";
  }
  $("estate-note").textContent = note;

  // steps
  const steps = Array.isArray(e.steps) ? e.steps.filter((s) => s !== "done") : [];
  const list = $("estate-steps");
  list.replaceChildren();
  const currentIndex = steps.indexOf(e.step);
  const finished = e.status === "ready" || e.status === "suspended";
  for (let i = 0; i < steps.length; i++) {
    const li = document.createElement("li");
    let state = "pending";
    if (finished || i < currentIndex) state = "done";
    else if (i === currentIndex) state = e.status === "error" ? "failed" : "current";
    li.className = state;
    li.textContent = STEP_LABELS[steps[i]] || steps[i];
    list.appendChild(li);
  }
  list.classList.toggle("hidden", e.status === "pending_manual");

  setError($("estate-error"), e.status === "error" && e.error ? e.error : "");
  if (e.status === "error") show($("estate-retry")); else hide($("estate-retry"));

  // facts
  const facts = $("estate-facts");
  facts.replaceChildren();
  const addFact = (k, v) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    facts.appendChild(dt);
    facts.appendChild(dd);
  };
  addFact("Fly app", String(e.app || "") + " (" + String(e.region || "") + ")");
  if (e.posture) {
    addFact("Posture", "ledger signing required: " + e.posture.require_signing + " · attest signing: " + e.posture.attest_signing + " · gateway enforce: " + e.posture.enforce + " · tool check: " + e.posture.tool_check);
  }
  const fps = e.fingerprints || {};
  for (const name of Object.keys(fps)) addFact("Public key " + name, String(fps[name]));
  if (Array.isArray(e.self_agents) && e.self_agents.length) addFact("Platform self-agents", e.self_agents.join(", ") + " (30-day tokens, renewed automatically after 25 days with a brief restart)");
  if (e.image) addFact("Engine image", String(e.image));
  if (e.health) addFact("Health", (e.health.ok ? "ok" : "PROBLEM") + " — " + String(e.health.note || "") + " (checked " + fmtTime(e.health.checked_at) + ")");
  if (e.upgrade_failed_image) addFact("Image upgrade", "FAILED for " + String(e.upgrade_failed_image) + " — the rollout to this estate is halted; Spin State Labs investigates before retrying");
  addFact("Anthropic key", e.anthropic_key_set_at ? "placed " + fmtTime(e.anthropic_key_set_at) : "not placed — POST /gateway/v1/messages answers 502 until it is");
  if (e.ready_at) addFact("Ready since", fmtTime(e.ready_at));
  show(facts);

  // log
  const log = Array.isArray(e.log) ? e.log : [];
  $("estate-log").textContent = log.map((l) => String(l.at || "").slice(0, 19).replace("T", " ") + "  " + l.step + ": " + l.note).join("\n");
  if (log.length) show($("estate-log-wrap")); else hide($("estate-log-wrap"));

  // configuration forms
  const cfgWrap = $("estate-config");
  if (e.status === "ready" && configured) {
    show(cfgWrap);
    $("roster-grantor").textContent = String(e.grantor || "");
    if (!rosterDirty && e.roster) {
      $("roster-scopes").value = (e.roster.allowed_scope || []).join("\n");
      $("roster-ttl").value = String(e.roster.max_ttl_days || 30);
      $("roster-spend").value = e.roster.max_spend_usd === null || e.roster.max_spend_usd === undefined ? "" : String(e.roster.max_spend_usd);
    }
  } else {
    hide(cfgWrap);
  }
}

async function submitAnthropicKey(ev) {
  ev.preventDefault();
  const input = $("anthropic-key");
  const key = input.value.trim();
  if (!key) { setError($("anthropic-error"), "Paste your Anthropic API key first."); return; }
  const btn = $("anthropic-btn");
  btn.disabled = true;
  setError($("anthropic-error"), "");
  const res = await api("/api/estate/anthropic-key", { method: "POST", body: { key } });
  input.value = "";
  btn.disabled = false;
  if (res.status === 200) {
    $("anthropic-status").textContent = "Key placed " + fmtTime(res.data && res.data.anthropic_key_set_at) + ". The estate is restarting to apply it; the console did not keep a copy.";
    loadEstate();
  } else if (res.status === 401) {
    showAuthView();
  } else {
    setError($("anthropic-error"), errMessage(res.status, res.data));
  }
}

async function submitRoster(ev) {
  ev.preventDefault();
  const scopes = $("roster-scopes").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const ttl = Number($("roster-ttl").value);
  const spendRaw = $("roster-spend").value.trim();
  const body = { allowed_scope: scopes, max_ttl_days: ttl, max_spend_usd: spendRaw === "" ? null : Number(spendRaw) };
  const btn = $("roster-btn");
  btn.disabled = true;
  setError($("roster-error"), "");
  const res = await api("/api/estate/roster", { method: "PUT", body });
  btn.disabled = false;
  if (res.status === 200) {
    rosterDirty = false;
    $("roster-status").textContent = scopes.length
      ? "Saved: " + scopes.length + " scope(s), tokens up to " + ttl + " day(s)."
      : "Saved with no scopes: your row is left off the estate's roster, so no token can be minted under your name until you add at least one scope.";
  } else if (res.status === 401) {
    showAuthView();
  } else {
    setError($("roster-error"), errMessage(res.status, res.data));
  }
}

// ---------------------------------------------------------------------------
// API keys: list / create / revoke
// ---------------------------------------------------------------------------

async function refreshKeys() {
  const res = await api("/api/keys");
  if (res.status === 401) {
    showAuthView();
    return;
  }
  if (res.status !== 200 || !res.data) {
    setError($("keys-error"), errMessage(res.status, res.data));
    return;
  }
  setError($("keys-error"), "");
  renderKeys(Array.isArray(res.data.keys) ? res.data.keys : []);
}

function renderKeys(keys) {
  const body = $("keys-body");
  body.replaceChildren();

  if (keys.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "empty-cell";
    td.textContent = "No keys yet — create one below.";
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const k of keys) {
    const tr = document.createElement("tr");

    const tdLabel = document.createElement("td");
    tdLabel.textContent = String(k.label ?? "");
    tr.appendChild(tdLabel);

    const tdPrefix = document.createElement("td");
    const code = document.createElement("code");
    code.textContent = String(k.prefix ?? "") + "…";
    tdPrefix.appendChild(code);
    tr.appendChild(tdPrefix);

    const tdCreated = document.createElement("td");
    tdCreated.textContent = String(k.created_at ?? "").slice(0, 10);
    tr.appendChild(tdCreated);

    const tdStatus = document.createElement("td");
    const chip = document.createElement("span");
    chip.className = "chip " + (k.revoked ? "chip-err" : "chip-ok");
    chip.textContent = k.revoked ? "revoked" : "active";
    tdStatus.appendChild(chip);
    tr.appendChild(tdStatus);

    const tdAction = document.createElement("td");
    if (!k.revoked) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-danger btn-small";
      btn.textContent = "Revoke";
      btn.addEventListener("click", () => revokeKey(String(k.id ?? ""), btn));
      tdAction.appendChild(btn);
    }
    tr.appendChild(tdAction);

    body.appendChild(tr);
  }
}

async function createKey(ev) {
  ev.preventDefault();
  const input = $("new-key-label");
  const label = input.value.trim();
  if (!label) {
    setError($("keys-error"), "Enter a label for the new key.");
    input.focus();
    return;
  }
  const btn = $("new-key-btn");
  btn.disabled = true;
  const res = await api("/api/keys", { method: "POST", body: { label } });
  btn.disabled = false;
  if (res.status === 201 && res.data && typeof res.data.key === "string") {
    input.value = "";
    setError($("keys-error"), "");
    openKeyModal(res.data.key);
    refreshKeys();
  } else if (res.status === 401) {
    showAuthView();
  } else {
    setError($("keys-error"), errMessage(res.status, res.data));
  }
}

async function revokeKey(hash, btn) {
  if (!window.confirm("Revoke this key? Requests using it will be rejected.")) return;
  btn.disabled = true;
  const res = await api("/api/keys/" + encodeURIComponent(hash), { method: "DELETE" });
  if (res.status === 200) {
    refreshKeys();
  } else if (res.status === 401) {
    showAuthView();
  } else {
    btn.disabled = false;
    setError($("keys-error"), errMessage(res.status, res.data));
  }
}

// ---------------------------------------------------------------------------
// one-time key modal — the plaintext exists only here, never in a list
// ---------------------------------------------------------------------------

function openKeyModal(plaintext) {
  $("key-modal-value").textContent = plaintext;
  const copyBtn = $("key-copy-btn");
  copyBtn.textContent = "Copy key";
  copyBtn.disabled = false;
  show($("key-modal"));
  $("key-copy-btn").focus();
}

// Only the Done button closes the modal — no backdrop/Escape close, so the
// once-only key cannot be dismissed by accident.
function closeKeyModal() {
  $("key-modal-value").textContent = "";
  hide($("key-modal"));
}

async function copyKey() {
  const value = $("key-modal-value").textContent;
  const btn = $("key-copy-btn");
  try {
    await navigator.clipboard.writeText(value);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed — select the key text manually";
  }
}

// ---------------------------------------------------------------------------
// health — polled once; drives the estate status chip and the billing note
// ---------------------------------------------------------------------------

async function checkHealth() {
  const chip = $("estate-chip");
  const res = await api("/api/health");
  if (res.status === 200 && res.data && res.data.ok === true) {
    flags = res.data;
    const own = currentMe && currentMe.estate && currentMe.estate.status === "ready";
    if (own) {
      chip.className = "chip chip-ok";
      chip.textContent = "dedicated estate ready";
    } else if (res.data.estate_attached) {
      chip.className = "chip chip-ok";
      chip.textContent = "sandbox estate attached";
    } else {
      chip.className = "chip chip-warn";
      chip.textContent = "sandbox estate not attached yet";
    }
  } else {
    chip.className = "chip chip-err";
    chip.textContent = "health check unavailable";
  }
  if (currentMe) renderBilling(currentMe);
}

// ---------------------------------------------------------------------------
// quickstart
// ---------------------------------------------------------------------------

function renderQuickstart() {
  const origin = window.location.origin;
  $("quickstart-code").textContent = [
    "curl -X POST " + origin + "/api/v1/sentinel/check \\",
    '  -H "x-api-key: ff_live_YOUR_KEY" \\',
    '  -H "content-type: application/json" \\',
    "  -d '{\"agent_id\": \"my-agent\", \"action\": \"example.action\"}'",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

$("tab-login").addEventListener("click", () => setAuthMode("login"));
$("tab-register").addEventListener("click", () => setAuthMode("register"));
$("auth-form").addEventListener("submit", submitAuth);
$("logout-btn").addEventListener("click", logout);
$("new-key-form").addEventListener("submit", createKey);
$("key-copy-btn").addEventListener("click", copyKey);
$("key-modal-close").addEventListener("click", closeKeyModal);
$("upgrade-operator").addEventListener("click", (ev) => startCheckout("operator", ev.currentTarget));
$("upgrade-sovereign").addEventListener("click", (ev) => startCheckout("sovereign", ev.currentTarget));
$("manage-billing").addEventListener("click", openBillingPortal);
$("estate-retry").addEventListener("click", retryEstate);
$("anthropic-form").addEventListener("submit", submitAnthropicKey);
$("roster-form").addEventListener("submit", submitRoster);
$("roster-scopes").addEventListener("input", () => { rosterDirty = true; });
$("roster-ttl").addEventListener("input", () => { rosterDirty = true; });
$("roster-spend").addEventListener("input", () => { rosterDirty = true; });

boot();
