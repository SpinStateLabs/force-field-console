// estate.mts — Force-Field Console v0.2.0
// The account's dedicated estate: status, one synchronous provisioning step
// (a fallback; the dashboard kicks the background worker instead), retry, the customer's
// Anthropic key placement (forwarded to Fly secrets, never stored, never
// logged) and the DOA roster row. Every mutation answers 501 when
// provisioning is not configured on this deployment.
import type { Context, Config } from "@netlify/functions";
import { readSession } from "../../src/lib/session";
import { getUserById } from "../../src/lib/users";
import type { User } from "../../src/lib/users";
import { flyClientOrNull, flyConfig, FlyError } from "../../src/lib/fly";
import {
  EstateError,
  advanceEstate,
  getEstate,
  publicEstate,
  retryEstate,
  setEstateAnthropicKey,
  updateEstateRoster,
} from "../../src/lib/estates";
import { kickWorker } from "../../src/lib/worker";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function err(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

const NOT_CONFIGURED = "Dedicated-estate provisioning is not configured on this deployment; paid estates are provisioned by hand until it is.";

async function requireUser(req: Request): Promise<User | null> {
  const userId = await readSession(req);
  return userId ? await getUserById(userId) : null;
}

export default async (req: Request, _context: Context): Promise<Response> => {
  const pathname = new URL(req.url).pathname;
  const user = await requireUser(req);
  if (!user) return err(401, "unauthenticated", "Sign in to manage your estate.");

  const estate = await getEstate(user.id);
  const configured = flyConfig() !== null;

  if (req.method === "GET" && pathname === "/api/estate") {
    return json(200, { estate: estate ? publicEstate(estate) : null, provisioning_configured: configured });
  }

  if (!estate) return err(404, "no_estate", "No dedicated estate on this account; estates come with the Operator and Sovereign tiers.");

  try {
    if (req.method === "POST" && pathname === "/api/estate/advance") {
      const r = await advanceEstate(estate, flyClientOrNull());
      return json(200, { outcome: r.outcome, note: r.note, estate: publicEstate(r.estate) });
    }

    if (req.method === "POST" && pathname === "/api/estate/retry") {
      if (!configured) return err(501, "provisioning_not_configured", NOT_CONFIGURED);
      await retryEstate(estate);
      // The background worker does the slow work; fall back to one synchronous step when it cannot be kicked.
      if (await kickWorker(user.id, "advance")) {
        return json(200, { outcome: "kicked", note: "worker started", estate: publicEstate(estate) });
      }
      const r = await advanceEstate(estate, flyClientOrNull());
      return json(200, { outcome: r.outcome, note: r.note, estate: publicEstate(r.estate) });
    }

    if (req.method === "POST" && pathname === "/api/estate/anthropic-key") {
      const fly = flyClientOrNull();
      if (!fly) return err(501, "provisioning_not_configured", NOT_CONFIGURED);
      let body: any;
      try {
        body = await req.json();
      } catch {
        return err(400, "bad_json", "Request body must be valid JSON.");
      }
      await setEstateAnthropicKey(estate, fly, body?.key);
      return json(200, { anthropic_key_set_at: estate.anthropic_key_set_at });
    }

    if (req.method === "PUT" && pathname === "/api/estate/roster") {
      const fly = flyClientOrNull();
      if (!fly) return err(501, "provisioning_not_configured", NOT_CONFIGURED);
      let body: any;
      try {
        body = await req.json();
      } catch {
        return err(400, "bad_json", "Request body must be valid JSON.");
      }
      await updateEstateRoster(estate, fly, body);
      return json(200, { roster: estate.roster, grantor: estate.grantor });
    }
  } catch (e: any) {
    if (e instanceof EstateError) return err(e.status, e.code, e.message);
    if (e instanceof FlyError) return err(502, "fly_error", `Fly refused the request: ${e.message}`);
    throw e;
  }

  return err(404, "not_found", "Unknown estate endpoint.");
};

export const config: Config = {
  path: ["/api/estate", "/api/estate/advance", "/api/estate/retry", "/api/estate/anthropic-key", "/api/estate/roster"],
};
