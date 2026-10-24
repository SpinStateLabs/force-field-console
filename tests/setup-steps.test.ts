// The dedicated-estate setup pages: every step of docs/estate-quickstart.md must have a page.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore plain browser ES module shared with the page
import { STEPS, SLUGS, indexFromHash, hashFor, stepStatus, navMark, exportRegistry, opsNote, GUIDE_URL } from "../public/setup-steps.js";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const guide = read("docs/estate-quickstart.md");

function fencedBlocks(md: string): string[] {
  const out: string[] = [];
  const re = /```[a-z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md))) out.push(m[1].replace(/\n$/, ""));
  return out;
}

describe("step registry vs the quickstart guide", () => {
  it("has one page per guide step (inventory)", () => {
    const numbered = [...guide.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => m[1]);
    expect(numbered).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    // Section 0 holds three numbered items plus the "set these" variables; every other section is one step;
    // the closing "What the console does" section is a reference page.
    const sec0 = guide.split(/^## 1\./m)[0].split(/^## 0\./m)[1];
    const items = [...sec0.matchAll(/^\d+\. \*\*(.+?)\*\*/gm)].length;
    expect(items).toBe(3);
    expect(sec0).toContain("Set these for the examples:");
    const expected = items + 1 + 6 + 1;
    expect(STEPS.length).toBe(expected);
    expect(STEPS.map((s: any) => s.num)).toEqual(["0.1", "0.2", "0.3", "0.4", "1", "2", "3", "4", "5", "6", "i"]);
  });

  it("anchors every step to a heading or item that exists in the guide", () => {
    for (const s of STEPS) {
      const anchor = s.guideHeading ?? s.guideItem;
      expect(anchor, s.id).toBeTruthy();
      expect(guide, s.id).toContain(anchor);
    }
  });

  it("carries every fenced command from the guide verbatim", () => {
    const all = STEPS.flatMap((s: any) => s.commands.map((c: any) => c.sh));
    for (const block of fencedBlocks(guide)) {
      expect(all.some((sh: string) => sh === block), "missing guide block:\n" + block).toBe(true);
    }
  });

  it("gives every step purpose, see and fail copy", () => {
    for (const s of STEPS) {
      expect(s.title.length, s.id).toBeGreaterThan(3);
      expect(s.purpose.length, s.id).toBeGreaterThan(20);
      expect(s.see.length, s.id).toBeGreaterThan(0);
      expect(s.fail.length, s.id).toBeGreaterThan(0);
    }
  });

  it("every command has a PowerShell form unless it is shared", () => {
    for (const s of STEPS) for (const c of s.commands) expect(c.shared || typeof c.ps === "string", s.id).toBeTruthy();
  });
});

describe("routing and links", () => {
  it("slugs and numbers are unique and url-safe", () => {
    expect(new Set(SLUGS).size).toBe(SLUGS.length);
    expect(new Set(STEPS.map((s: any) => s.num)).size).toBe(STEPS.length);
    for (const s of SLUGS) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("every slug resolves through the hash router, with or without a slash", () => {
    STEPS.forEach((s: any, i: number) => {
      expect(indexFromHash(hashFor(s.slug))).toBe(i);
      expect(indexFromHash("#/" + s.slug)).toBe(i);
    });
    expect(indexFromHash("")).toBe(-1);
    expect(indexFromHash("#nope")).toBe(-1);
  });

  it("the page, script and dashboard link are wired", () => {
    expect(existsSync(join(root, "public/setup.html"))).toBe(true);
    const html = read("public/setup.html");
    const js = read("public/setup.js");
    expect(html).toContain('src="setup.js"');
    for (const id of js.matchAll(/\$\("([a-z-]+)"\)/g)) expect(html, "id " + id[1]).toContain('id="' + id[1] + '"');
    expect(read("public/app.html")).toContain('href="setup.html"');
    expect(js).toContain('from "./setup-steps.js"');
    for (const s of STEPS) if (s.action) expect(existsSync(join(root, "public", s.action.href)), s.id).toBe(true);
    expect(GUIDE_URL).toContain("docs/estate-quickstart.md");
  });
});

describe("placement (portal vs FIELD ops console)", () => {
  const by = (id: string) => STEPS.find((s: any) => s.id === id);
  it("matches the agreed split", () => {
    for (const id of ["roster-scopes", "anthropic-key", "api-key", "governed-call", "console-boundaries"]) {
      expect(by(id).surfaces).toEqual(["portal"]);
      expect(opsNote(by(id))).toBeNull();
    }
    for (const id of ["register-agent", "mint-token", "sentinel-check", "attest-pack", "read-ledger"]) {
      expect(by(id).surfaces).toEqual(["portal", "ops"]);
      expect(opsNote(by(id))).toBeTruthy();
    }
    for (const id of ["mint-token", "attest-pack", "read-ledger"]) expect(by(id).primary).toBe("ops");
    for (const id of ["register-agent", "sentinel-check"]) expect(by(id).primary).toBe("portal");
  });
  it("exports plain JSON for reuse", () => {
    const e = exportRegistry();
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
    expect(e.steps.length).toBe(STEPS.length);
    expect(e.steps.every((s: any) => s.id && s.title && s.surfaces && s.primary)).toBe(true);
  });
});

describe("no secrets, no external requests", () => {
  const files = ["public/setup-steps.js", "public/setup.js", "public/setup.html"];
  it("contains no key-shaped values", () => {
    for (const f of files) {
      const t = read(f);
      expect(t, f).not.toMatch(/sk-ant-[A-Za-z0-9_-]{6,}/);
      expect(t, f).not.toMatch(/ff_live_[A-Za-z0-9]{6,}/);
      expect(t, f).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    }
  });
  it("makes no CDN or font requests and only links known hosts", () => {
    const allowed = /^https:\/\/(github\.com\/SpinStateLabs\/|force-field-console\.netlify\.app\/)/;
    for (const f of files) {
      const t = read(f);
      expect(t, f).not.toMatch(/fonts\.(googleapis|gstatic)\.com|cdn\./i);
      for (const m of t.matchAll(/https?:\/\/[^\s"'<>)`\\]+/g)) expect(m[0], f).toMatch(allowed);
    }
  });
  it("the script never stores, logs or injects markup", () => {
    const js = read("public/setup.js");
    expect(js).not.toMatch(/localStorage|sessionStorage|document\.cookie|console\.|innerHTML|insertAdjacentHTML|eval\(/);
    // It only reads the three existing GET endpoints.
    const paths = [...js.matchAll(/getJSON\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(paths.sort()).toEqual(["/api/estate", "/api/keys", "/api/me"].sort());
    expect(js).not.toMatch(/method:\s*"(POST|PUT|DELETE)"/);
  });
});

describe("live status is honest", () => {
  const ready = (over: any = {}) => ({
    signedIn: true, me: { email: "a@b.co", tier: "operator" }, keys: [{ revoked: false }],
    estate: { status: "ready", roster: { allowed_scope: [] }, anthropic_key_set_at: null, fingerprints: { "attest-sign": "aa:bb", "ledger-sign": "cc:dd" }, health: { ok: true, note: "fine" } }, ...over,
  });
  it("signed out claims nothing", () => {
    for (const s of STEPS) expect(stepStatus(s.status, { signedIn: false }).kind).toBe("info");
  });
  it("no estate warns instead of passing", () => {
    expect(stepStatus("roster", ready({ estate: null })).kind).toBe("warn");
    expect(stepStatus("estate-ready", ready({ estate: null })).kind).toBe("warn");
  });
  it("a provisioning estate is not ok", () => {
    const c = ready({ estate: { status: "provisioning" } });
    for (const k of ["roster", "anthropic", "estate-ready", "governed", "attest", "ledger"]) expect(stepStatus(k, c).kind).toBe("warn");
  });
  it("an unreadable estate is unknown, not green", () => {
    expect(stepStatus("roster", ready({ estate: undefined, estateError: "HTTP 500" })).kind).toBe("info");
  });
  it("roster, anthropic and api key reflect real facts", () => {
    expect(stepStatus("roster", ready()).kind).toBe("warn");
    const saved = ready(); saved.estate.roster.allowed_scope = ["draft invoice"];
    expect(stepStatus("roster", saved).kind).toBe("ok");
    expect(stepStatus("anthropic", ready()).kind).toBe("warn");
    const placed = ready(); placed.estate.anthropic_key_set_at = "2026-10-01T00:00:00Z";
    expect(stepStatus("anthropic", placed).kind).toBe("ok");
    expect(stepStatus("apikey", ready({ keys: [{ revoked: true }] })).kind).toBe("warn");
    expect(stepStatus("apikey", ready()).kind).toBe("ok");
    expect(stepStatus("apikey", ready({ keys: null })).kind).toBe("info");
  });
  it("steps the console cannot observe never turn green", () => {
    for (const k of ["estate-ready", "attest", "ledger", "environment"]) expect(stepStatus(k, ready()).kind).not.toBe("ok");
    expect(stepStatus("governed", ready()).kind).not.toBe("ok");
  });
  it("governed call warns when no Anthropic key is placed", () => {
    expect(stepStatus("governed", ready()).kind).toBe("warn");
  });
  it("fingerprints are surfaced; a halted rollout is an error", () => {
    expect(stepStatus("attest", ready()).fingerprint).toBe("aa:bb");
    expect(stepStatus("ledger", ready()).fingerprint).toBe("cc:dd");
    const bad = ready(); bad.estate.upgrade_failed_image = "img:2";
    expect(stepStatus("boundaries", bad).kind).toBe("err");
  });
  it("only verified facts get a nav mark", () => {
    const saved = ready(); saved.estate.roster.allowed_scope = ["x"];
    const marks = STEPS.filter((s: any) => navMark(s, saved) === "verified").map((s: any) => s.id);
    expect(marks).toEqual(["roster-scopes", "api-key"]);
  });
});

describe("review fixes", () => {
  const est = (over: any) => ({
    signedIn: true, me: { email: "a@b.co", tier: "operator" }, keys: [],
    estate: { status: "ready", roster: { allowed_scope: ["x"] }, fingerprints: {}, ...over },
  });
  it("a ready estate with suspend_pending is not ready (the gateway answers 403 estate_suspended)", () => {
    const c = est({ suspend_pending: { since: "2026-10-23T00:00:00Z" } });
    for (const k of ["roster", "anthropic", "estate-ready", "governed", "attest", "ledger"]) {
      const s = stepStatus(k, c);
      expect(s.kind, k).toBe("warn");
      expect(s.text, k).toMatch(/being suspended.*refused/i);
    }
  });
  it("a resume that is still being retried says so (the subscription IS active), and a failed one asks for Spin State Labs", () => {
    const retrying = est({ status: "suspended", resume_pending: { attempts: 2, failed: false, next_retry_at: "2026-10-24T00:00:00Z" } });
    for (const k of ["roster", "estate-ready", "governed", "attest"]) {
      const s = stepStatus(k, retrying);
      expect(s.kind, k).toBe("warn");
      expect(s.label, k).toBe("resuming");
      expect(s.text, k).toMatch(/subscription is active/i);
      expect(s.text, k).not.toMatch(/not active/i);
    }
    const failed = stepStatus("estate-ready", est({ status: "suspended", resume_pending: { attempts: 10, failed: true, next_retry_at: null } }));
    expect(failed.kind).toBe("err");
    expect(failed.label).toBe("resume failed");
    expect(failed.text).toMatch(/Spin State Labs needs to step in/);
  });
  it("a freshly queued resume says the estate starts within about 2 minutes", () => {
    const s = stepStatus("estate-ready", est({ status: "suspended", resume_pending: { attempts: 0, failed: false, next_retry_at: null } }));
    expect(s.kind).toBe("warn");
    expect(s.label).toBe("resuming");
    expect(s.text).toMatch(/within about 2 minutes/);
    expect(s.text).not.toMatch(/not active/i);
  });
  it("a gone machine is not reported as a provisioning failure", () => {
    const s = stepStatus("estate-ready", est({ status: "error", error: "machine_missing: the Fly machine behind this estate is gone" }));
    expect(s.kind).toBe("err");
    expect(s.label).toBe("machine missing");
    expect(s.text).toMatch(/data volume is kept/);
    expect(s.text).not.toMatch(/Provisioning failed/);
  });
  it("a failed suspension asks for Spin State Labs; the boundaries step flags both failed states", () => {
    const s = stepStatus("estate-ready", est({ suspend_pending: { failed: true, attempts: 10 } }));
    expect(s.kind).toBe("err");
    expect(s.label).toBe("suspension failed");
    for (const over of [{ suspend_pending: { failed: true } }, { resume_pending: { failed: true } }]) {
      expect(stepStatus("boundaries", est(over)).kind).toBe("err");
    }
    expect(stepStatus("boundaries", est({ resume_pending: { failed: false } })).text).toMatch(/resume pending/);
  });
  it("pending_manual says commands go to the shared sandbox, not the account's estate", () => {
    const s = stepStatus("estate-ready", est({ status: "pending_manual" }));
    expect(s.kind).toBe("warn");
    expect(s.text).toMatch(/shared sandbox/i);
    expect(s.text).not.toMatch(/becomes available once it is ready/);
  });
  it("the health line says when it was checked", () => {
    const s = stepStatus("boundaries", est({ health: { ok: true, note: "fine", checked_at: "2026-10-23T10:00:00Z" } }));
    expect(s.text).toContain("as of 2026-10-23T10:00:00Z");
  });
  it("PowerShell blocks use curl.exe so error bodies stay readable", () => {
    for (const s of STEPS) for (const c of s.commands) {
      if (!c.ps || c.shared || s.id === "environment") continue;
      expect(c.ps, s.id).not.toMatch(/Invoke-RestMethod|Invoke-WebRequest|&&|\bcurl\s/);
      expect(c.ps, s.id).toContain("curl.exe");
      if (s.id !== "attest-pack") expect(c.ps, s.id).toContain("%{http_code}");
    }
  });
  it("Refresh status restores keyboard focus after re-rendering", () => {
    expect(read("public/setup.js")).toMatch(/refresh-status[\s\S]*focus\(\)/);
  });
});
