// Rule: the customer docs' route table states exactly what the gateway forwards (ALLOWED_ROUTES), with the same
// sandbox flag, and the setup steps offer only calls the gateway forwards for that step's estate.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_ROUTES, routeDecision } from "../src/lib/upstream";
// @ts-ignore plain browser ES module shared with the page
import { STEPS } from "../public/setup-steps.js";

const root = join(__dirname, "..");
const guide = readFileSync(join(root, "docs/estate-quickstart.md"), "utf-8").replace(/\r\n/g, "\n");

/** Rows of the "Which calls the console forwards" table: [method, path, sandbox?]. */
function tableRows(): [string, string, boolean][] {
  const start = guide.indexOf("## Which calls the console forwards");
  expect(start).toBeGreaterThan(0);
  return guide
    .slice(start)
    .split("\n")
    .filter((l) => /^\| (GET|POST|PUT|PATCH|DELETE) \|/.test(l))
    .map((l) => {
      const cells = l.split("|").map((c) => c.trim());
      return [cells[1], cells[2].replace(/`/g, ""), cells[3] === "dedicated and sandbox"] as [string, string, boolean];
    });
}

/** A sample concrete path for a table path ("<name>" filled in). */
const sample = (p: string) => p.replace("<name>", "audit");

describe("docs: the route table matches the gateway", () => {
  it("lists one row per allowed route, with the same method and sandbox flag", () => {
    const rows = tableRows();
    expect(rows).toHaveLength(ALLOWED_ROUTES.length);
    for (const [method, path, sandbox] of rows) {
      const route = ALLOWED_ROUTES.find((r) => r.method === method && r.pattern.test(sample(path)));
      expect(route, method + " " + path).toBeTruthy();
      expect(route!.sandbox, method + " " + path).toBe(sandbox);
    }
    for (const r of ALLOWED_ROUTES) {
      expect(rows.some(([m, p]) => m === r.method && r.pattern.test(sample(p))), r.docs).toBe(true);
    }
  });

  it("offers no revoke call", () => {
    expect(guide).not.toMatch(/\/revoke/);
  });
});

describe("setup steps: every offered call is forwarded for the estate the step is for", () => {
  it("every command's /api/v1 call is an allowed route on a dedicated estate", () => {
    let seen = 0;
    for (const step of STEPS as any[]) {
      for (const c of step.commands ?? []) {
        for (const src of [c.sh ?? "", c.ps ?? ""]) {
          for (const m of src.matchAll(/(?:-X (POST|GET) )?"\$(?:env:)?FF(\/[a-z0-9/._-]+)/g)) {
            const method = m[1] ?? "GET";
            const path = m[2].split("?")[0];
            expect(routeDecision(method, path, "estate"), step.id + " " + method + " " + path).toEqual({ ok: true });
            seen += 1;
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(5);
  });
});
