// public/pricing.js: the landing page's pricing note is upgraded from /api/health's capability flags only when the
// flags say so; any failure leaves the conservative static text in place. Run in a VM context with a fake document.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const SRC = readFileSync(join(__dirname, "..", "public", "pricing.js"), "utf-8");
const STATIC = "static conservative note";

type Page = { note: { textContent: string } | null; ctas: { textContent: string }[]; fetched: string[] };

async function runWith(health: (() => Promise<{ ok: boolean; json: () => Promise<unknown> }>) | null, opts: { noNote?: boolean } = {}): Promise<Page> {
  const page: Page = {
    note: opts.noNote ? null : { textContent: STATIC },
    ctas: [{ textContent: "Choose" }, { textContent: "Choose" }],
    fetched: [],
  };
  const document = {
    getElementById: (id: string) => (id === "pricing-honest" ? page.note : null),
    querySelectorAll: (sel: string) => (sel === "[data-upgrade]" ? page.ctas : []),
  };
  const fetch = async (url: string) => {
    page.fetched.push(url);
    if (!health) throw new Error("network down");
    return health();
  };
  const done = vm.runInNewContext(SRC, { document, fetch });
  await done; // the script is one async IIFE: its promise is the script's value
  return page;
}

const answer = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });

describe("pricing note (public/pricing.js)", () => {
  it("billing and provisioning configured: says checkout is Stripe and the estate is provisioned automatically; CTAs read Upgrade", async () => {
    const p = await runWith(answer({ ok: true, billing_configured: true, provisioning_configured: true }));
    expect(p.fetched).toEqual(["/api/health"]);
    expect(p.note!.textContent).toMatch(/^Checkout runs through Stripe\. After checkout a dedicated estate is provisioned automatically/);
    expect(p.ctas.map((c) => c.textContent)).toEqual(["Upgrade", "Upgrade"]);
  });

  it("billing only: says provisioning is by hand; CTAs read Upgrade", async () => {
    const p = await runWith(answer({ ok: true, billing_configured: true, provisioning_configured: false }));
    expect(p.note!.textContent).toMatch(/Automatic estate provisioning is not enabled on this deployment yet/);
    expect(p.note!.textContent).not.toMatch(/provisioned automatically/);
    expect(p.ctas.map((c) => c.textContent)).toEqual(["Upgrade", "Upgrade"]);
  });

  it("neither configured: the honest note; CTAs read Talk to us", async () => {
    const p = await runWith(answer({ ok: true, billing_configured: false, provisioning_configured: true }));
    expect(p.note!.textContent).toMatch(/^Honest note: paid checkout is not enabled/);
    expect(p.ctas.map((c) => c.textContent)).toEqual(["Talk to us", "Talk to us"]);
  });

  it("flags are read strictly: a truthy non-boolean does not claim billing or provisioning", async () => {
    const p = await runWith(answer({ ok: true, billing_configured: "true", provisioning_configured: 1 }));
    expect(p.note!.textContent).toMatch(/^Honest note/);
    expect(p.ctas.map((c) => c.textContent)).toEqual(["Talk to us", "Talk to us"]);
  });

  for (const [label, health] of [
    ["the request fails", null],
    ["the answer is not 2xx", answer({ ok: true, billing_configured: true, provisioning_configured: true }, false)],
    ["the answer says ok: false", answer({ ok: false, billing_configured: true, provisioning_configured: true })],
    ["the answer has no ok: true", answer({ billing_configured: true, provisioning_configured: true })],
    ["the body is not JSON", async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } })],
  ] as const) {
    it(`${label}: the static note and the CTAs are left exactly as served`, async () => {
      const p = await runWith(health as any);
      expect(p.note!.textContent).toBe(STATIC);
      expect(p.ctas.map((c) => c.textContent)).toEqual(["Choose", "Choose"]);
    });
  }

  it("a page without the note element makes no request", async () => {
    const p = await runWith(answer({ ok: true }), { noNote: true });
    expect(p.fetched).toEqual([]);
  });
});
