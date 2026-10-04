// me.mts — Force-Field Console v0.2.0
// Returns the authenticated user's profile, Declared tier limits, the billing
// mirror (status only — never card data) and the estate summary.
import type { Context, Config } from "@netlify/functions";
import { readSession } from "../../src/lib/session";
import { getUserById } from "../../src/lib/users";
import { TIERS } from "../../src/lib/tiers";
import { getEstate } from "../../src/lib/estates";

function err(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "GET") {
    return err(405, "method_not_allowed", "Use GET for this endpoint.");
  }

  const userId = await readSession(req);
  const user = userId ? await getUserById(userId) : null;
  if (!user) {
    return err(401, "unauthenticated", "Sign in to access this endpoint.");
  }

  const tier = TIERS[user.tier];
  const estate = await getEstate(user.id);
  return new Response(
    JSON.stringify({
      email: user.email,
      tier: user.tier,
      created_at: user.created_at,
      limits: { rpm: tier.rpm, rpd: tier.rpd },
      billing: user.billing
        ? {
            status: user.billing.status,
            tier: user.billing.tier,
            current_period_end: user.billing.current_period_end,
            has_customer: Boolean(user.billing.customer_id),
          }
        : null,
      estate: estate ? { status: estate.status, url: estate.url, step: estate.step } : null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

export const config: Config = {
  path: "/api/me",
};
