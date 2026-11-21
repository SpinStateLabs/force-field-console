// Top-up packs (price book rev 2): POST /api/billing/packs {packs: n} sets the account's number of +20-agent packs on
// its CURRENT subscription (0 removes them). The pack is a second subscription item on the pack Price of the
// subscription's own interval (Stripe requires one interval per subscription). Only an ACTIVE paid subscription may
// buy packs (not trialing: a trial gets no free agents; not past_due). Bounds come from PRICE_BOOK.pack.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import handler from "../netlify/functions/billing.mts";
import { freshStore } from "./helpers";
import { createUser, saveUser, type User } from "../src/lib/users";
import { issueSession, sessionCookie } from "../src/lib/session";
import { PRICE_BOOK } from "../src/lib/pricebook";

const ctx = {} as any;
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_OPERATOR: "price_op", STRIPE_PRICE_SOVEREIGN: "price_sov",
  STRIPE_PRICE_SOVEREIGN_ANNUAL: "price_sov_y", STRIPE_PRICE_PACK: "price_pack", STRIPE_PRICE_PACK_ANNUAL: "price_pack_y",
};

type Call = { method: string; path: string; params: URLSearchParams; key: string | null };
let user: User;
let calls: Call[];
let sub: any;
const realFetch = globalThis.fetch;

function fakeStripe() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const params = new URLSearchParams(method === "GET" ? url.search : String(init?.body ?? ""));
    calls.push({ method, path: url.pathname, params, key: init?.headers?.["idempotency-key"] ?? null });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === "/v1/subscriptions/sub_1") return json(sub);
    if (method === "POST" && url.pathname === "/v1/subscription_items") return json({ id: "si_new", quantity: Number(params.get("quantity")) });
    if (method === "POST" && url.pathname.startsWith("/v1/subscription_items/")) return json({ id: url.pathname.split("/").pop(), quantity: Number(params.get("quantity")) });
    if (method === "DELETE" && url.pathname.startsWith("/v1/subscription_items/")) return json({ id: url.pathname.split("/").pop(), deleted: true });
    return json({ error: { message: "unexpected " + method + " " + url.pathname } }, 400);
  }) as any;
}

const item = (id: string, price: string, quantity: number) => ({ id, price: { id: price }, quantity });
async function subscribed(status = "active", items: any[] = [item("si_seat", "price_sov", 3)]) {
  sub = { id: "sub_1", status, customer: "cus_1", items: { data: items }, metadata: { user_id: user.id } };
  user.tier = "sovereign";
  user.billing = { customer_id: "cus_1", subscription_id: "sub_1", status, price_id: "price_sov", tier: "sovereign", current_period_end: null, updated_at: "t", seats: 3, packs: 0, agent_pool: 60 };
  await saveUser(user);
}
const post = async (b: unknown) => {
  const cookie = sessionCookie(await issueSession(user.id)).split(";")[0];
  return handler(new Request("http://portal.test/api/billing/packs", { method: "POST", headers: { cookie }, body: JSON.stringify(b) }), ctx);
};
const writes = () => calls.filter((c) => c.method !== "GET");

beforeEach(async () => {
  freshStore();
  Object.assign(process.env, STRIPE_ENV);
  user = await createUser("packs@example.com", "sufficiently-long-pass");
  calls = [];
  fakeStripe();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
});

describe("price book", () => {
  it("packs are +20 agents for 12 a month, at most max_packs", () => {
    expect(PRICE_BOOK.pack).toMatchObject({ agents: 20, month: 12, max_packs: 50 });
  });
});

describe("setting the number of packs", () => {
  it("first pack: adds a pack item on the monthly pack price, prorated", async () => {
    await subscribed();
    const r = await post({ packs: 2 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ packs: 2 });
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0].path).toBe("/v1/subscription_items");
    expect(w[0].params.get("subscription")).toBe("sub_1");
    expect(w[0].params.get("price")).toBe("price_pack");
    expect(w[0].params.get("quantity")).toBe("2");
    expect(w[0].params.get("proration_behavior")).toBe("create_prorations");
    expect(w[0].key).toMatch(/^packs-[0-9a-f-]{36}$/); // one key per request (review r1 C1)
  });

  it("an annual subscription uses the annual pack price", async () => {
    await subscribed("active", [item("si_seat", "price_sov_y", 3)]);
    expect((await post({ packs: 1 })).status).toBe(200);
    expect(writes()[0].params.get("price")).toBe("price_pack_y");
  });

  it("an existing pack item: its quantity is updated", async () => {
    await subscribed("active", [item("si_seat", "price_sov", 3), item("si_pack", "price_pack", 1)]);
    expect((await post({ packs: 4 })).status).toBe(200);
    expect(writes()[0]).toMatchObject({ method: "POST", path: "/v1/subscription_items/si_pack" });
    expect(writes()[0].params.get("quantity")).toBe("4");
  });

  it("0 removes the pack item; 0 with none is a no-op", async () => {
    await subscribed("active", [item("si_seat", "price_sov", 3), item("si_pack", "price_pack", 2)]);
    expect((await post({ packs: 0 })).status).toBe(200);
    expect(writes()[0]).toMatchObject({ method: "DELETE", path: "/v1/subscription_items/si_pack" });
    calls = [];
    await subscribed();
    const r = await post({ packs: 0 });
    expect(r.status).toBe(200);
    expect(writes()).toEqual([]);
  });

  it("the same number as now: no Stripe write", async () => {
    await subscribed("active", [item("si_seat", "price_sov", 3), item("si_pack", "price_pack", 2)]);
    expect((await post({ packs: 2 })).status).toBe(200);
    expect(writes()).toEqual([]);
  });
});

describe("refusals (no Stripe write)", () => {
  it("not signed in: 401", async () => {
    const r = await handler(new Request("http://portal.test/api/billing/packs", { method: "POST", body: "{}" }), ctx);
    expect(r.status).toBe(401);
  });

  it("bad pack counts: 400 bad_packs", async () => {
    await subscribed();
    for (const packs of [-1, 1.5, "2", null, PRICE_BOOK.pack.max_packs + 1, undefined]) {
      const r = await post({ packs });
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe("bad_packs");
    }
    expect(calls).toEqual([]);
  });

  it("no subscription: 409 no_subscription", async () => {
    const r = await post({ packs: 1 });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("no_subscription");
  });

  it("trialing or past_due (checked LIVE at Stripe, not from the mirror): 409 subscription_not_active", async () => {
    for (const status of ["trialing", "past_due", "canceled"]) {
      await subscribed(status);
      user.billing!.status = "active"; // a stale mirror must not let a trial buy packs
      await saveUser(user);
      const r = await post({ packs: 1 });
      expect(r.status).toBe(409);
      expect((await r.json()).error.code).toBe("subscription_not_active");
    }
    expect(writes()).toEqual([]);
  });

  it("pack price for the subscription's interval not configured: 501 packs_not_configured", async () => {
    delete process.env.STRIPE_PRICE_PACK_ANNUAL;
    await subscribed("active", [item("si_seat", "price_sov_y", 3)]);
    const r = await post({ packs: 1 });
    expect(r.status).toBe(501);
    expect((await r.json()).error.code).toBe("packs_not_configured");
    expect(writes()).toEqual([]);
  });

  it("billing not configured: 501", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    await subscribed();
    expect((await post({ packs: 1 })).status).toBe(501);
  });
});

describe("dashboard and README", () => {
  it("the dashboard has a pack control that posts {packs}", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(__dirname, "..");
    expect(readFileSync(join(root, "public/app.html"), "utf8")).toContain('<input id="pack-count" type="number" min="0" max="50" step="1" value="0">');
    const js = readFileSync(join(root, "public/app.js"), "utf8");
    expect(js).toContain('api("/api/billing/packs", { method: "POST", body: { packs: Number($("pack-count").value) } })');
    expect(js).toContain('$("update-packs").addEventListener("click", updatePacks);');
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("`POST /api/billing/packs {packs}`");
  });
});

// Review r1 (don.reviewer, PR 26 @ 082995d): findings (a)-(d), C2 route registration, DELETE body, copy vs PRICE_BOOK.
describe("review r1 fixes", () => {
  it("(a) a pack item on the OTHER interval than the subscription: 409 pack_items_ambiguous, no write", async () => {
    await subscribed("active", [item("si_seat", "price_sov", 3), item("si_pack_y", "price_pack_y", 1)]);
    const r = await post({ packs: 2 });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("pack_items_ambiguous");
    expect(writes()).toEqual([]);
  });

  it("(b) two pack items: 409 pack_items_ambiguous, no write", async () => {
    await subscribed("active", [item("si_seat", "price_sov", 3), item("si_p1", "price_pack", 1), item("si_p2", "price_pack", 2)]);
    const r = await post({ packs: 4 });
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("pack_items_ambiguous");
    expect(writes()).toEqual([]);
  });

  it("(c) 2 -> 0 -> 2 within one minute: every write carries its own idempotency key", async () => {
    await subscribed();
    expect((await post({ packs: 2 })).status).toBe(200);
    await subscribed("active", [item("si_seat", "price_sov", 3), item("si_new", "price_pack", 2)]);
    expect((await post({ packs: 0 })).status).toBe(200);
    await subscribed();
    expect((await post({ packs: 2 })).status).toBe(200);
    const keys = writes().map((w) => w.key);
    expect(keys).toHaveLength(3);
    expect(keys.every((k) => typeof k === "string" && k.length > 10)).toBe(true);
    expect(new Set(keys).size).toBe(3);
  });

  it("(d) concurrent first purchases: one write; the other gets 409 packs_in_progress", async () => {
    await subscribed();
    const [r1, r2] = await Promise.all([post({ packs: 2 }), post({ packs: 3 })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect((await loser.json()).error.code).toBe("packs_in_progress");
    expect(writes().filter((w) => w.path === "/v1/subscription_items")).toHaveLength(1);
  });

  it("(d) the claim is released after the write: a later change goes through", async () => {
    await subscribed();
    expect((await post({ packs: 2 })).status).toBe(200);
    await subscribed("active", [item("si_seat", "price_sov", 3), item("si_new", "price_pack", 2)]);
    expect((await post({ packs: 5 })).status).toBe(200);
  });

  it("(d) the claim is released when Stripe refuses the write", async () => {
    await subscribed();
    const ok = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(init?.method ?? "GET").toUpperCase() !== "GET") return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 400, headers: { "content-type": "application/json" } });
      return (ok as any)(input, init);
    }) as any;
    expect((await post({ packs: 2 })).status).toBe(502);
    globalThis.fetch = ok;
    expect((await post({ packs: 2 })).status).toBe(200);
  });

  it("C2: the route is registered", async () => {
    const mod = await import("../netlify/functions/billing.mts");
    expect((mod.config as any).path).toContain("/api/billing/packs");
  });

  it("DELETE carries proration_behavior in its body", async () => {
    await subscribed("active", [item("si_seat", "price_sov", 3), item("si_pack", "price_pack", 2)]);
    expect((await post({ packs: 0 })).status).toBe(200);
    expect(writes()[0].params.get("proration_behavior")).toBe("create_prorations");
  });

  it("copy follows PRICE_BOOK (max packs and pack price)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const html = readFileSync(join(__dirname, "..", "public/app.html"), "utf8");
    expect(html).toContain(`max="${PRICE_BOOK.pack.max_packs}"`);
    expect(html).toContain(`(+${PRICE_BOOK.pack.agents} agents for CA$${PRICE_BOOK.pack.month}/mo each)`);
  });
});
