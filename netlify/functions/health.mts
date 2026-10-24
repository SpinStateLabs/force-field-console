// health.mts — Force-Field Console v0.2.0
// Liveness probe plus the deployment's capability flags. Each flag reports
// whether the variables for that capability are SET — it does not probe
// Stripe, Fly or the engine (Declared, not Enforced). The landing page renders
// its honest note from these flags, so the copy can never claim more than the
// deployment is configured for.
import type { Context, Config } from "@netlify/functions";
import { env, portalStore, storeScope } from "../../src/lib/store";
import { stripeConfig } from "../../src/lib/stripe";
import { flyConfig } from "../../src/lib/fly";

export const PORTAL_VERSION = "0.2.2";

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "GET") {
    return new Response(
      JSON.stringify({ error: { code: "method_not_allowed", message: "Use GET for this endpoint." } }),
      { status: 405, headers: { "content-type": "application/json" } },
    );
  }

  // Whether any estate's suspension could not be completed (a machine still runs). One small
  // record kept by the scheduled tick; this unauthenticated endpoint never scans the estates and
  // exposes a boolean only. null when unknown (no tick has run yet / unreadable).
  let suspendFailed: boolean | null = null;
  let resumeFailed: boolean | null = null;
  let machineStopped: boolean | null = null;
  try {
    const rec = (await (await portalStore()).get("ops/suspend_failed", { type: "json" })) as { count?: number; resume_failed?: number; machine_stopped?: number } | null;
    suspendFailed = rec ? Number(rec.count ?? 0) > 0 : null;
    resumeFailed = rec ? Number(rec.resume_failed ?? 0) > 0 : null;
    machineStopped = rec ? Number(rec.machine_stopped ?? 0) > 0 : null;
  } catch {
    suspendFailed = null;
    resumeFailed = null;
    machineStopped = null;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      suspend_failed: suspendFailed,
      resume_failed: resumeFailed,
      machine_stopped: machineStopped,
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
