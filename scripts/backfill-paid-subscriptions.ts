// Deploy step 0 of PR 29: backfill paid_subscriptions/<sub> for estates provisioned before the paid marker existed.
//
//   node node_modules/vite-node/vite-node.mjs scripts/backfill-paid-subscriptions.ts            # DRY RUN (default)
//   node node_modules/vite-node/vite-node.mjs scripts/backfill-paid-subscriptions.ts -- --apply # create-only writes
//
// Reads (never prints) from the environment: STRIPE_SECRET_KEY and the STRIPE_PRICE_* / STRIPE_WEBHOOK_SECRET values the
// site uses (stripeConfig), NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN (to open the site's "portal" blob store). A LIVE-mode
// Stripe key is refused: this backfill is for the test-mode estate only (production runs Stripe TEST mode today). Going
// live later needs a live-mode backfill behind an explicit flag; there is no such flag now. The first output line names
// the Stripe mode and the Netlify site the run reads.
// Dry run: one "subscription" line per current AND remembered (billing.other_subs) subscription of every estate's owner
// (user id, subscription id and status, the qualifying paid invoice, the action and the record it WOULD write), one
// "estate" line per estate with what the new rule does to it once those records exist (runs / parked / suspended on
// the next subscription event / kept running / stays suspended), then a summary line. --apply: the same plan, then
// create-only writes of the paid_subscriptions/ records it lists, and nothing else. A record is written only when
// Stripe shows a paid invoice for THAT subscription with amount_paid > 0, a positive NET tier line (amount minus
// discount_amounts), in the price book currency; it is never derived from "an estate exists".
//
// Why it must run BEFORE the merge (measured in tests/backfill-paid.test.ts and tests/provision-gate.test.ts, for a
// legitimately paid estate with no record yet):
//  - the first tick leaves a ready, running estate ready and running, and the gateway still routes to it;
//  - a machine found stopped is NOT restarted (no resume is queued);
//  - the next subscription event for it (a renewal's customer.subscription.updated) SUSPENDS it;
//  - a provisioning / pending_manual / error record is parked: no driver provisions it;
//  - it heals by itself only at the subscription's next paid invoice (up to a year on an annual plan).
import { getStore } from "@netlify/blobs";
import { installScriptStore, kvFromBlobStore } from "../src/lib/store";
import { stripeConfig } from "../src/lib/stripe";
import { applyBackfill, planBackfill } from "../src/lib/backfill-paid";

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  const cfg = stripeConfig();
  if (!cfg) {
    console.error("backfill: Stripe is not configured (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_OPERATOR, STRIPE_PRICE_SOVEREIGN)");
    return 2;
  }
  if (/^(sk|rk)_live_/.test(cfg.secret_key)) {
    console.error("backfill: refusing a LIVE-mode Stripe key; this backfill is for the test-mode estate");
    return 2;
  }
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (!siteID || !token) {
    console.error("backfill: NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN are required to open the site's portal store");
    return 2;
  }
  // First line of every run: which Stripe mode and which Netlify site this run reads (C1). The mode comes from the key's
  // prefix (live keys were refused above); the site id is not a secret. Neither value of a key or token is printed.
  const stripeMode = /^(sk|rk)_test_/.test(cfg.secret_key) ? "test" : "unknown";
  console.log(JSON.stringify({ kind: "target", stripe_mode: stripeMode, netlify_site: siteID, store: "portal", mode: apply ? "apply" : "dry-run" }));
  if (stripeMode !== "test") {
    console.error("backfill: the Stripe key is not a test-mode key; refusing");
    return 2;
  }
  installScriptStore(kvFromBlobStore(getStore({ name: "portal", siteID, token, consistency: "strong" })));
  const plan = await planBackfill(cfg);
  for (const r of plan.rows) console.log(JSON.stringify({ kind: "subscription", ...r }));
  for (const e of plan.estates) console.log(JSON.stringify({ kind: "estate", ...e }));
  const toWrite = plan.rows.filter((r) => r.action === "write").length;
  const outlook: Record<string, number> = {};
  for (const e of plan.estates) outlook[e.outlook] = (outlook[e.outlook] ?? 0) + 1;
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", estates: plan.estates.length, subscriptions: plan.rows.length, would_write: toWrite, outlook }));
    return 0;
  }
  const out = await applyBackfill(plan);
  console.log(JSON.stringify({ mode: "apply", estates: plan.estates.length, planned: toWrite, ...out, outlook }));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("backfill: stopped, nothing more written:", String(err?.message ?? err).slice(0, 300));
    process.exit(1);
  },
);
