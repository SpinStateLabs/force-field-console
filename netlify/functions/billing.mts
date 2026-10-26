// billing.mts — Force-Field Console v0.2.0
// Stripe billing: Checkout Session creation, Customer Portal sessions, and the
// signed webhook that is the only writer of paid tiers. Every endpoint answers
// 501 billing_not_configured until the four STRIPE_* variables are set — never
// a half-wired path. Never log request bodies, signatures or keys.
import type { Context, Config } from "@netlify/functions";
import { readSession } from "../../src/lib/session";
import { getUserById } from "../../src/lib/users";
import type { User } from "../../src/lib/users";
import { env } from "../../src/lib/store";
import {
  GRANTING_STATUSES,
  StripeError,
  createCheckoutSession,
  createPortalSession,
  stripeConfig,
  verifyStripeSignature,
} from "../../src/lib/stripe";
import { checkoutIdempotencyKey, claimCheckout, claimEvent, eventDone, handleStripeEvent, markProcessed, releaseCheckout, releaseEvent } from "../../src/lib/billing";
import { flyClientOrNull } from "../../src/lib/fly";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function err(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

const NOT_CONFIGURED = "Payments are not configured on this deployment yet; paid tiers are not for sale here.";

async function requireUser(req: Request): Promise<User | null> {
  const userId = await readSession(req);
  return userId ? await getUserById(userId) : null;
}

/** The site's own origin for Stripe redirects: Netlify's URL variable, else the request origin. */
export function siteOrigin(req: Request): string {
  const configured = env("URL");
  if (configured && /^https?:\/\//.test(configured)) return configured.replace(/\/+$/, "");
  return new URL(req.url).origin;
}

export default async (req: Request, _context: Context): Promise<Response> => {
  const pathname = new URL(req.url).pathname;
  if (req.method !== "POST") {
    return err(405, "method_not_allowed", "Use POST for this endpoint.");
  }
  const cfg = stripeConfig();

  // --- Stripe -> portal: signed webhook (no session; signature is the auth) ---
  if (pathname === "/api/billing/webhook") {
    if (!cfg) return err(501, "billing_not_configured", NOT_CONFIGURED);
    const raw = await req.text();
    if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), cfg.webhook_secret)) {
      return err(400, "bad_signature", "Stripe-Signature verification failed.");
    }
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return err(400, "bad_json", "Webhook body must be JSON.");
    }
    if (typeof event?.id !== "string" || typeof event?.type !== "string") {
      return err(400, "bad_event", "Webhook body is not a Stripe event.");
    }
    // Create-only claim: a redelivery (or a concurrent delivery) of the same event id is a no-op.
    if (!(await claimEvent(event.id, event.type))) {
      // Only a "done" record is a duplicate. A claim still "processing" may belong to a delivery
      // that was killed (no finally runs); a 2xx here would make Stripe stop retrying and lose the
      // event. Answer non-2xx so Stripe retries; once the claim is stale its retry takes it over.
      if (await eventDone(event.id)) return json(200, { received: true, duplicate: true });
      return err(409, "event_in_progress", "This event is still being applied; Stripe will retry.");
    }
    try {
      const outcome = await handleStripeEvent(event, { cfg, fly: flyClientOrNull() });
      await markProcessed(event.id, event.type);
      return json(200, { received: true, ...outcome });
    } catch (e: any) {
      // A 5xx makes Stripe retry; release the claim so that retry can apply the event.
      await releaseEvent(event.id).catch((re: any) =>
        console.error("billing webhook: RELEASE of the claim failed for", event.id, "- the retry takes it over after 10 min:", re?.message ?? re),
      );
      console.error("billing webhook: handling failed for", event.type, "-", e?.message ?? e);
      return err(500, "webhook_failed", "The event could not be applied; Stripe will retry.");
    }
  }

  // --- portal user -> Stripe: session-authenticated ---
  const user = await requireUser(req);
  if (!user) return err(401, "unauthenticated", "Sign in to manage billing.");
  if (!cfg) return err(501, "billing_not_configured", NOT_CONFIGURED);
  const origin = siteOrigin(req);

  try {
    if (pathname === "/api/billing/checkout") {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return err(400, "bad_json", "Request body must be valid JSON.");
      }
      const tier = body?.tier;
      if (tier !== "operator" && tier !== "sovereign") {
        return err(400, "bad_tier", "tier must be \"operator\" or \"sovereign\".");
      }
      if (user.billing?.subscription_id && GRANTING_STATUSES.has(user.billing.status)) {
        return err(409, "already_subscribed", "You already have a subscription; use Manage billing to change plans.");
      }
      // Create-only, short-TTL claim per user: two concurrent requests (a double click, two tabs)
      // must not each open a Stripe Checkout Session and risk two subscriptions.
      const claim = await claimCheckout(user.id);
      if (!claim) {
        return err(409, "checkout_in_progress", "A checkout for this account was just started; finish it, or try again in a minute.");
      }
      try {
        const session = await createCheckoutSession(cfg, {
          user_id: user.id,
          email: user.email,
          customer_id: user.billing?.customer_id ?? null,
          tier,
          success_url: origin + "/app.html?checkout=success",
          cancel_url: origin + "/app.html?checkout=cancelled",
          idempotency_key: checkoutIdempotencyKey(user.id, tier, user.billing?.customer_id ?? null),
        });
        return json(200, { url: session.url });
      } catch (e) {
        // No session was created: free the claim so the user can retry at once.
        await releaseCheckout(user.id, claim).catch(() => {});
        throw e;
      }
    }

    if (pathname === "/api/billing/portal") {
      if (!user.billing?.customer_id) {
        return err(404, "no_billing_account", "No billing account yet; start a subscription first.");
      }
      const portal = await createPortalSession(cfg, user.billing.customer_id, origin + "/app.html");
      return json(200, { url: portal.url });
    }
  } catch (e: any) {
    if (e instanceof StripeError) {
      return err(502, "stripe_error", `Stripe refused the request: ${e.message}`);
    }
    throw e;
  }

  return err(404, "not_found", "Unknown billing endpoint.");
};

export const config: Config = {
  path: ["/api/billing/checkout", "/api/billing/portal", "/api/billing/webhook"],
};
