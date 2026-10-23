// health.mts — Force-Field Console v0.2.0
// Liveness probe plus the deployment's capability flags. Each flag reports
// whether the variables for that capability are SET — it does not probe
// Stripe, Fly or the engine (Declared, not Enforced). The landing page renders
// its honest note from these flags, so the copy can never claim more than the
// deployment is configured for.
import type { Context, Config } from "@netlify/functions";
import { env, storeScope } from "../../src/lib/store";
import { stripeConfig } from "../../src/lib/stripe";
import { flyConfig } from "../../src/lib/fly";
import { listEstates } from "../../src/lib/estates";

export const PORTAL_VERSION = "0.2.2";

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: { code: "method_not_allowed", message: "Use GET for this endpoint." } }),
      { status: 405, headers: { "content-type": "application/json" } },
    );
  }

  // Estates whose suspension could not be completed (the machine still runs): a count only, null when unreadable.
  let suspendFailed: number | null = null;
  try {
    suspendFailed = (await listEstates()).filter((e) => e.suspend_pending?.failed).length;
  } catch {
    suspendFailed = null;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      suspend_failed_estates: suspendFailed,
      estate_attached: Boolean(env("ESTATE_URL")),
      billing_configured: stripeConfig() !== null,
      provisioning_configured: flyConfig() !== null,
      // Which blob store this invocation uses: "site" on production, "deploy" elsewhere.
      // "deploy" on the production URL means records will not survive the next deploy.
      store_scope: storeScope(),
      version: PORTAL_VERSION,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {
  path: "/api/health",
};
