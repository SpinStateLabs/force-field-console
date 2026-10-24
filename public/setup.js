// Force-Field Console — dedicated-estate setup pages (vanilla ES module).
// Everything is rendered with createElement/textContent. Nothing secret is read, requested, stored
// or logged: status comes from the existing session-authenticated GET /api/me, /api/estate and
// /api/keys, which return public facts only (key prefixes, fingerprints, public keys).

import { STEPS, OVERVIEW, GUIDE_URL, indexFromHash, hashFor, stepStatus, navMark, opsNote, ALSO_IN_OPS } from "./setup-steps.js";

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const ctx = { signedIn: false, me: null, estate: undefined, estateError: "", keys: null, loaded: false };

async function getJSON(path) {
  try {
    const res = await fetch(path, { credentials: "same-origin" });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}

async function loadStatus() {
  const me = await getJSON("/api/me");
  if (me.status === 200 && me.data) {
    ctx.signedIn = true;
    ctx.me = me.data;
    const [est, keys] = await Promise.all([getJSON("/api/estate"), getJSON("/api/keys")]);
    if (est.status === 200 && est.data) { ctx.estate = est.data.estate || null; ctx.estateError = ""; }
    else if (est.status === 404) { ctx.estate = null; }
    else { ctx.estate = undefined; ctx.estateError = "Estate status could not be read (HTTP " + est.status + ")."; }
    ctx.keys = keys.status === 200 && keys.data && Array.isArray(keys.data.keys) ? keys.data.keys : null;
  } else {
    ctx.signedIn = false; ctx.me = null; ctx.estate = undefined; ctx.keys = null;
  }
  ctx.loaded = true;
}

// ---------------------------------------------------------------------------
// copy button
// ---------------------------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function announce(msg) {
  const live = $("setup-live");
  live.textContent = "";
  setTimeout(() => { live.textContent = msg; }, 30);
}

function copyButton(getText, label) {
  const b = el("button", "btn btn-secondary btn-small copy-btn", "Copy");
  b.type = "button";
  b.setAttribute("aria-label", "Copy " + label);
  b.addEventListener("click", async () => {
    const ok = await copyText(getText());
    b.textContent = ok ? "Copied" : "Copy failed";
    announce(ok ? label + " copied to the clipboard." : "Copy failed; select the text and copy it by hand.");
    setTimeout(() => { b.textContent = "Copy"; }, 2000);
  });
  return b;
}

let blockSeq = 0;
function codeBlock(heading, code, note) {
  const wrap = el("div", "cmd-block");
  const head = el("div", "cmd-head");
  const hid = "cmd-" + (++blockSeq);
  const h = el("p", "cmd-title", heading);
  h.id = hid;
  head.appendChild(h);
  head.appendChild(copyButton(() => code, heading));
  wrap.appendChild(head);
  const pre = el("pre", "code");
  pre.setAttribute("tabindex", "0");
  pre.setAttribute("aria-labelledby", hid);
  pre.appendChild(el("code", null, code));
  wrap.appendChild(pre);
  if (note) wrap.appendChild(el("p", "setup-hint", note));
  return wrap;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function chipClass(kind) {
  return { ok: "chip chip-ok", warn: "chip chip-warn", err: "chip chip-err", info: "chip chip-muted" }[kind] || "chip";
}

function fact(label, value) {
  const row = el("dl", "kv");
  row.appendChild(el("dt", null, label));
  row.appendChild(el("dd", null, value));
  return row;
}

function statusCard(step) {
  const st = stepStatus(step.status, ctx);
  const card = el("section", "setup-status card");
  card.setAttribute("aria-label", "Live status for this step");
  const head = el("p", "setup-status-head");
  head.appendChild(el("span", "setup-status-label", "Live status "));
  head.appendChild(el("span", chipClass(st.kind), st.label));
  card.appendChild(head);
  card.appendChild(el("p", null, st.text));
  if (st.fingerprint) card.appendChild(fact(step.status === "attest" ? "attest-sign fingerprint" : "ledger-sign fingerprint", st.fingerprint));
  if (!ctx.signedIn && ctx.loaded) {
    const p = el("p", "setup-hint");
    const a = el("a", null, "Sign in on the dashboard");
    a.href = "app.html";
    p.appendChild(a);
    p.appendChild(document.createTextNode(", then come back."));
    card.appendChild(p);
  }
  const btn = el("button", "btn btn-secondary btn-small", "Refresh status");
  btn.type = "button";
  btn.id = "refresh-status";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    await loadStatus();
    route(false);
    const again = document.getElementById("refresh-status");
    if (again) again.focus();
    announce("Status refreshed.");
  });
  card.appendChild(btn);
  return card;
}

function publicKeyCard(step) {
  if (!step.publicKey || !ctx.signedIn || !ctx.estate || !ctx.estate.public_keys) return null;
  const pem = ctx.estate.public_keys[step.publicKey];
  if (!pem) return null;
  const card = el("section", "card setup-key");
  card.appendChild(el("h2", "sub-title", "Your estate's public key"));
  card.appendChild(el("p", "setup-hint", "Public, safe to share. Save it as attest-sign.pub.pem next to the pack, then run the verify command."));
  card.appendChild(codeBlock("attest-sign public key (PEM)", pem));
  const dl = el("button", "btn btn-secondary btn-small", "Download attest-sign.pub.pem");
  dl.type = "button";
  dl.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([pem.endsWith("\n") ? pem : pem + "\n"], { type: "application/x-pem-file" }));
    const a = document.createElement("a");
    a.href = url; a.download = "attest-sign.pub.pem";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  card.appendChild(dl);
  return card;
}

function list(items) {
  const ul = el("ul", "setup-list");
  for (const t of items) ul.appendChild(el("li", null, t));
  return ul;
}

function opsCard(step) {
  const note = opsNote(step);
  if (!note) return null;
  const card = el("aside", "card setup-ops");
  card.setAttribute("aria-label", ALSO_IN_OPS);
  card.appendChild(el("h2", "sub-title", ALSO_IN_OPS));
  card.appendChild(el("p", null, note));
  const url = ctx.signedIn && ctx.estate && ctx.estate.url ? ctx.estate.url : null;
  if (url) card.appendChild(fact("Your estate origin", url));
  return card;
}

function label(s) { return s.num === "i" ? s.title : "Step " + s.num + ": " + s.title; }

function renderOverview(root) {
  root.appendChild(el("p", "eyebrow", "Dedicated estate"));
  root.appendChild(el("h1", "setup-h1", OVERVIEW.title));
  for (const p of OVERVIEW.intro) root.appendChild(el("p", "setup-lead", p));
  const start = el("a", "btn btn-primary", "Start with step " + STEPS[0].num);
  start.href = hashFor(STEPS[0].slug);
  root.appendChild(start);
  root.appendChild(el("h2", "sub-title", "All " + STEPS.length + " pages"));
  const ol = el("ol", "setup-overview");
  for (const s of STEPS) {
    const li = el("li");
    const a = el("a", null, label(s));
    a.href = hashFor(s.slug);
    li.appendChild(a);
    if (s.surfaces.includes("ops")) li.appendChild(el("span", "setup-hint", "  (also in the FIELD ops console)"));
    ol.appendChild(li);
  }
  root.appendChild(ol);
  const p = el("p", "setup-hint");
  p.appendChild(document.createTextNode("Source: "));
  const a = el("a", null, "docs/estate-quickstart.md");
  a.href = GUIDE_URL; a.target = "_blank"; a.rel = "noopener";
  p.appendChild(a);
  p.appendChild(document.createTextNode(". Commands are shown for Bash (verbatim from the guide) and Windows PowerShell 5.1."));
  root.appendChild(p);
}

function renderStep(root, i) {
  const s = STEPS[i];
  const pos = el("p", "setup-pos");
  pos.appendChild(el("span", "eyebrow", s.num === "i" ? "Reference" : "Step " + s.num));
  pos.appendChild(el("span", "setup-hint", "  page " + (i + 1) + " of " + STEPS.length));
  root.appendChild(pos);
  const bar = el("progress", "setup-progress");
  bar.max = STEPS.length; bar.value = i + 1;
  bar.setAttribute("aria-label", "Page " + (i + 1) + " of " + STEPS.length + " in the quickstart (position in the guide, not completion)");
  root.appendChild(bar);

  root.appendChild(el("h1", "setup-h1", s.title));
  root.appendChild(el("p", "setup-lead", s.purpose));
  root.appendChild(statusCard(s));
  for (const d of s.details) root.appendChild(el("p", null, d));
  if (s.bullets) root.appendChild(list(s.bullets));

  if (s.action) {
    const p = el("p");
    const a = el("a", "btn btn-primary", s.action.label);
    a.href = s.action.href;
    p.appendChild(a);
    root.appendChild(p);
    root.appendChild(el("p", "setup-hint", s.action.note));
  }

  if (s.commands.length) {
    root.appendChild(el("h2", "sub-title", "Commands"));
    for (const c of s.commands) {
      if (c.label) root.appendChild(el("h3", "setup-cmd-label", c.label));
      root.appendChild(codeBlock(c.derivedSh ? "Bash, expanded from the guide" : "Bash, from the guide", c.sh, c.sNote));
      if (!c.shared) root.appendChild(codeBlock("Windows PowerShell 5.1", c.ps, c.psNote || "Console-supplied equivalent; the guide itself only gives the Bash form."));
    }
  }
  const key = publicKeyCard(s);
  if (key) root.appendChild(key);

  const split = el("div", "setup-split");
  const see = el("section", "card");
  see.appendChild(el("h2", "sub-title", "What you should see"));
  see.appendChild(list(s.see));
  const fail = el("section", "card");
  fail.appendChild(el("h2", "sub-title", "If it fails"));
  fail.appendChild(list(s.fail));
  split.appendChild(see); split.appendChild(fail);
  root.appendChild(split);

  const ops = opsCard(s);
  if (ops) root.appendChild(ops);

  const pn = el("nav", "setup-pager");
  pn.setAttribute("aria-label", "Previous and next step");
  const prev = i > 0 ? STEPS[i - 1] : null;
  const next = i < STEPS.length - 1 ? STEPS[i + 1] : null;
  const pa = el("a", "btn btn-secondary", prev ? "← " + label(prev) : "← Overview");
  pa.href = prev ? hashFor(prev.slug) : "#overview";
  pn.appendChild(pa);
  const na = el("a", "btn btn-primary", next ? label(next) + " →" : "Back to the dashboard");
  na.href = next ? hashFor(next.slug) : "app.html";
  pn.appendChild(na);
  root.appendChild(pn);
}

function renderNav(current) {
  const nav = $("setup-nav");
  nav.replaceChildren();
  const ov = el("li");
  const oa = el("a", "setup-nav-link" + (current === -1 ? " current" : ""), "Overview");
  oa.href = "#overview";
  if (current === -1) oa.setAttribute("aria-current", "page");
  ov.appendChild(oa);
  nav.appendChild(ov);
  STEPS.forEach((s, i) => {
    const li = el("li");
    const a = el("a", "setup-nav-link" + (i === current ? " current" : ""));
    a.href = hashFor(s.slug);
    if (i === current) a.setAttribute("aria-current", "page");
    a.appendChild(el("span", "setup-nav-num", s.num));
    a.appendChild(el("span", "setup-nav-title", s.title));
    if (navMark(s, ctx) === "verified") {
      const m = el("span", "setup-nav-mark", "✓");
      m.setAttribute("aria-hidden", "true");
      a.appendChild(m);
      a.appendChild(el("span", "visually-hidden", " (verified by the console)"));
    }
    li.appendChild(a);
    nav.appendChild(li);
  });
  $("setup-nav-summary").textContent = current === -1 ? "All steps" : "All steps (page " + (current + 1) + " of " + STEPS.length + ")";
}

function route(moveFocus) {
  const i = indexFromHash(location.hash);
  const root = $("setup-content");
  root.replaceChildren();
  blockSeq = 0;
  if (i === -1) renderOverview(root); else renderStep(root, i);
  renderNav(i);
  const title = i === -1 ? OVERVIEW.title : label(STEPS[i]);
  document.title = title + " — Force-Field Console";
  $("setup-status-line").textContent = !ctx.loaded ? "Checking session…" : ctx.signedIn ? "Signed in as " + (ctx.me.email || "") + " · tier " + (ctx.me.tier || "") : "Signed out — live status needs a session.";
  if (moveFocus) {
    root.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    announce(title);
    if (window.matchMedia("(max-width: 720px)").matches) $("setup-nav-wrap").open = false;
  }
}

window.addEventListener("hashchange", () => route(true));
if (window.matchMedia("(max-width: 720px)").matches) $("setup-nav-wrap").open = false;
route(false);
loadStatus().then(() => route(false));
