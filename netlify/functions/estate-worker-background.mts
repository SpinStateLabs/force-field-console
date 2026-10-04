// estate-worker-background.mts — Force-Field Console v0.2.0
// BACKGROUND function — the `-background` filename suffix is what Netlify
// honours (a `background: true` config alone deployed as a synchronous
// function, verified 2026-09-14); it answers 202 at once and may run 15 min.
// Served only at /.netlify/functions/estate-worker-background (custom paths
// are not applied to background functions).
// drives one estate's provisioning to completion, or renews its self-agent
// tokens. Kicked by the dashboard (session cookie → that user's estate) and by
// the scheduled tick / retry endpoint (internal HMAC of the user id). Logs
// counts and outcomes only.
import type { Context, Config } from "@netlify/functions";
import { readSession } from "../../src/lib/session";
import { flyClientOrNull } from "../../src/lib/fly";
import { runWorker, verifyInternalToken, type WorkerAction } from "../../src/lib/worker";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== "POST") return json(405, { error: { code: "method_not_allowed", message: "Use POST." } });
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const requested = typeof body?.user_id === "string" ? body.user_id : "";
  let userId: string | null = null;
  const internal = req.headers.get("x-ff-internal");
  if (internal && requested && verifyInternalToken(internal, requested)) {
    userId = requested;
  } else {
    userId = await readSession(req);
  }
  if (!userId) return json(401, { error: { code: "unauthenticated", message: "Session or internal token required." } });

  const fly = flyClientOrNull();
  if (!fly) return json(501, { error: { code: "provisioning_not_configured", message: "Provisioning is not configured on this deployment." } });

  const action: WorkerAction = body?.action === "renew" ? "renew" : body?.action === "upgrade" ? "upgrade" : "advance";
  const result = await runWorker(userId, action, fly);
  console.log(`estate-worker: action ${action}, iterations ${result.iterations}, last ${result.last}, status ${result.status}`);
  return json(200, result);
};

export const config: Config = {
  background: true,
} as Config;
