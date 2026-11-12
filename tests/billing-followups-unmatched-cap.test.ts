// Billing audit follow-up (review of PR 15): the unmatched-event id list in ops/billing_flags is bounded.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import healthHandler from "../netlify/functions/health.mts";
import { freshStore } from "./helpers";
import { BILLING_FLAGS_KEY, MAX_UNMATCHED_EVENT_IDS, recordUnmatchedEvent, updateBillingFlags } from "../src/lib/billing";
import { portalStore } from "../src/lib/store";

const ctx = {} as any;
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  freshStore();
  spy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => spy.mockRestore());

const health = async () => (await healthHandler(new Request("http://portal.test/api/health"), ctx)).json();
const flags = async () => (await (await portalStore()).get(BILLING_FLAGS_KEY, { type: "json" })) as any;

describe("unmatched events: the id list in ops/billing_flags is capped", () => {
  it("keeps the newest MAX_UNMATCHED_EVENT_IDS ids, counts the dropped ones, keeps every per-event record, health stays true and booleans-only", async () => {
    const total = MAX_UNMATCHED_EVENT_IDS + 5;
    for (let i = 0; i < total; i++) await recordUnmatchedEvent(`evt_${i}`, "customer.subscription.updated", "sub_1");
    const f = await flags();
    expect(f.unmatched_events).toHaveLength(MAX_UNMATCHED_EVENT_IDS);
    expect(f.unmatched_events[0]).toBe("evt_5");
    expect(f.unmatched_events.at(-1)).toBe(`evt_${total - 1}`);
    expect(f.unmatched_events_dropped).toBe(5);
    expect((await (await portalStore()).list({ prefix: "ops/unmatched_events/" })).blobs).toHaveLength(total);
    const h = await health();
    expect(h.unmatched_events).toBe(true);
    expect(JSON.stringify(h)).not.toContain("evt_");
  });

  it("health stays true when the ids were all cleared by an operator but the dropped counter is still set", async () => {
    await updateBillingFlags((f) => ((f.unmatched_events = []), (f.unmatched_events_dropped = 3), true));
    expect((await health()).unmatched_events).toBe(true);
    await updateBillingFlags((f) => (delete f.unmatched_events_dropped, true));
    expect((await health()).unmatched_events).toBe(false);
  });

  it("below the cap the record has no dropped counter", async () => {
    await recordUnmatchedEvent("evt_a", "customer.subscription.updated", "sub_1");
    expect(await flags()).toEqual({ unmatched_price_users: [], unmatched_events: ["evt_a"] });
  });
});
