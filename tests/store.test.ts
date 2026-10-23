// The production store adapter: which Netlify Blobs store is opened, with which
// consistency, and how the create-only write maps the client's answer. The
// blobs module is mocked at the import boundary; nothing here touches Netlify.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const opened: { fn: string; opts: any }[] = [];
const setJSON = vi.fn(async (_key: string, _value: unknown, _opts?: any) => ({ modified: true }));
const getWithMetadata = vi.fn(async (_key: string, _opts?: any): Promise<any> => ({ data: { a: 1 }, etag: "etag-1", metadata: {} }));
const fake = { get: vi.fn(async () => null), getWithMetadata, setJSON, delete: vi.fn(async () => undefined), list: vi.fn(async () => ({ blobs: [], directories: [] })) };

vi.mock("@netlify/blobs", () => ({
  getStore: (opts: any) => {
    opened.push({ fn: "getStore", opts });
    return fake;
  },
  getDeployStore: (opts: any) => {
    opened.push({ fn: "getDeployStore", opts });
    return fake;
  },
}));

import { portalStore, setStoreForTesting, storeScope } from "../src/lib/store";

describe("portalStore (production adapter)", () => {
  beforeEach(() => {
    setStoreForTesting(null);
    opened.length = 0;
    setJSON.mockClear();
  });
  afterEach(() => {
    delete process.env.CONTEXT;
    delete (globalThis as any).Netlify;
  });

  it("takes the deploy context from the invocation (Netlify.context), because CONTEXT is not a runtime variable on Netlify", async () => {
    // As on Netlify at runtime: no CONTEXT in the environment, only the invocation context.
    delete process.env.CONTEXT;
    (globalThis as any).Netlify = { context: { deploy: { context: "production" } } };
    expect(storeScope()).toBe("site");
    await portalStore();
    expect(opened).toEqual([{ fn: "getStore", opts: { name: "portal", consistency: "strong" } }]);
    opened.length = 0;
    (globalThis as any).Netlify = { context: { deploy: { context: "deploy-preview" } } };
    expect(storeScope()).toBe("deploy");
    await portalStore();
    expect(opened).toEqual([{ fn: "getDeployStore", opts: { name: "portal", consistency: "strong" } }]);
    // Outside an invocation the context is null: never guess production.
    (globalThis as any).Netlify = { context: null };
    expect(storeScope()).toBe("deploy");
  });

  it("falls back to CONTEXT (tests, local tooling): site-wide 'portal' store with STRONG consistency in production, a deploy-scoped one elsewhere", async () => {
    process.env.CONTEXT = "production";
    await portalStore();
    expect(opened).toEqual([{ fn: "getStore", opts: { name: "portal", consistency: "strong" } }]);
    opened.length = 0;
    process.env.CONTEXT = "deploy-preview";
    await portalStore();
    expect(opened).toEqual([{ fn: "getDeployStore", opts: { name: "portal", consistency: "strong" } }]);
  });

  it("setJSONIfNew is a create-only write (onlyIfNew) and reports the client's `modified` flag", async () => {
    process.env.CONTEXT = "production";
    const store = await portalStore();
    setJSON.mockResolvedValueOnce({ modified: true });
    expect(await store.setJSONIfNew("k", { a: 1 })).toBe(true);
    expect(setJSON).toHaveBeenLastCalledWith("k", { a: 1 }, { onlyIfNew: true });
    setJSON.mockResolvedValueOnce({ modified: false });
    expect(await store.setJSONIfNew("k", { a: 2 })).toBe(false);
    await store.setJSON("k", { a: 3 });
    expect(setJSON).toHaveBeenLastCalledWith("k", { a: 3 });
  });

  it("a stored value that comes back without an etag is a hard error, never 'absent'", async () => {
    process.env.CONTEXT = "production";
    const store = await portalStore();
    getWithMetadata.mockResolvedValueOnce({ data: { a: 1 }, etag: undefined, metadata: {} });
    await expect(store.getWithEtag("k")).rejects.toThrow(/etag/);
  });

  it("getWithEtag / setJSONIfMatch map to getWithMetadata and an onlyIfMatch write", async () => {
    process.env.CONTEXT = "production";
    const store = await portalStore();
    expect(await store.getWithEtag("k")).toEqual({ data: { a: 1 }, etag: "etag-1" });
    expect(getWithMetadata).toHaveBeenLastCalledWith("k", { type: "json" });
    getWithMetadata.mockResolvedValueOnce(null);
    expect(await store.getWithEtag("gone")).toBeNull();
    setJSON.mockResolvedValueOnce({ modified: true });
    expect(await store.setJSONIfMatch("k", { a: 2 }, "etag-1")).toBe(true);
    expect(setJSON).toHaveBeenLastCalledWith("k", { a: 2 }, { onlyIfMatch: "etag-1" });
    setJSON.mockResolvedValueOnce({ modified: false });
    expect(await store.setJSONIfMatch("k", { a: 3 }, "stale")).toBe(false);
  });
});
