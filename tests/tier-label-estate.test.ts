// The top paid tier is shown to people as "Estate". The internal tier id stays "sovereign"
// (stored on user records, sent by checkout, matched against STRIPE_PRICE_SOVEREIGN*), so only
// display copy changes. These tests pin the display label everywhere a person can read it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TIERS } from "../src/lib/tiers";
// @ts-ignore plain browser ES module shared with the page
import { OVERVIEW, stepStatus } from "../public/setup-steps.js";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// User-visible files: the pages, their scripts, the user docs, and the function that words an error.
const VISIBLE = [
  "public/index.html",
  "public/app.html",
  "public/app.js",
  "public/setup-steps.js",
  "docs/estate-quickstart.md",
  "netlify/functions/estate.mts",
  "README.md",
];

describe("top tier display label is Estate", () => {
  it("tiers.ts labels the sovereign tier Estate and keeps the internal id", () => {
    expect(TIERS.sovereign.label).toBe("Estate");
    expect(Object.keys(TIERS)).toEqual(["sandbox", "operator", "sovereign"]);
  });

  it.each(VISIBLE)("%s shows no 'Sovereign' tier label", (p) => {
    // Case-sensitive on purpose: the env names STRIPE_PRICE_SOVEREIGN* and the lowercase id
    // "sovereign" (element ids, checkout tier, ?upgrade=) are internal and stay.
    expect(read(p)).not.toMatch(/\bSovereign\b/);
  });

  it("landing page pricing card is named Estate and still upgrades the sovereign id", () => {
    const html = read("public/index.html");
    expect(html).toMatch(/<h3 class="tier-name">Estate<\/h3>\s*<p class="tier-price">\$249/);
    expect(html).toContain('href="app.html?upgrade=sovereign" data-upgrade="sovereign"');
  });

  it("dashboard upgrade button reads Upgrade to Estate", () => {
    expect(read("public/app.html")).toContain('<button id="upgrade-sovereign" class="btn btn-secondary" type="button">Upgrade to Estate ($249/mo)</button>');
    expect(read("public/app.js")).toContain('upSov.textContent = "Upgrade to Estate ($249/mo)";');
    expect(read("public/app.js")).toContain('startCheckout("sovereign", ev.currentTarget)');
  });

  it("setup pages name the Operator and Estate tiers", () => {
    expect(OVERVIEW.intro[0]).toContain("For Operator and Estate accounts");
    const s = stepStatus("boundaries", { signedIn: true, estate: null, keys: [] });
    expect(s.text).toContain("come with the Operator and Estate tiers");
  });

  it("estate function's no-estate message names the Estate tier", () => {
    expect(read("netlify/functions/estate.mts")).toContain("estates come with the Operator and Estate tiers.");
  });
});
