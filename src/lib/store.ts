// Force-Field Console — storage + environment access.
//
// A minimal KV abstraction over Netlify Blobs so tests can swap in an
// in-memory store via setStoreForTesting(). The KV surface is deliberately
// restricted to the store methods this codebase uses:
//   get(key, {type}), setJSON(key, value), delete(key), list({prefix}).

export type KV = {
  get(key: string, opts?: { type?: "json" | "text" }): Promise<any>;
  setJSON(key: string, value: any): Promise<void>;
  /**
   * Create-only write (the store's own compare-and-set, `onlyIfNew` in
   * @netlify/blobs >= 10): true when the key was written, false when it
   * already existed — the caller then knows another writer got there first.
   */
  setJSONIfNew(key: string, value: any): Promise<boolean>;
  /** Read a JSON value together with its etag (null when the key is absent). */
  getWithEtag(key: string): Promise<{ data: any; etag: string } | null>;
  /**
   * Conditional write (the store's `onlyIfMatch`): true when the key still had
   * `etag` and was overwritten, false when another writer changed it first.
   */
  setJSONIfMatch(key: string, value: any, etag: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ blobs: { key: string }[] }>;
};

let testStore: KV | null = null;

/** Install (or clear, with null) a substitute store for tests. */
export function setStoreForTesting(s: KV | null): void {
  testStore = s;
}

/**
 * Read an environment variable. Prefers the Netlify runtime global
 * (Netlify.env.get) and falls back to process.env so tests and plain
 * Node tooling work unchanged.
 */
export function env(name: string): string | undefined {
  return (globalThis as any).Netlify?.env?.get?.(name) ?? process.env[name];
}

/**
 * The deploy context of the running code ("production", "deploy-preview",
 * "branch-deploy", "dev"). Netlify does NOT expose the build-time CONTEXT
 * variable to functions at runtime (only URL, SITE_NAME and SITE_ID:
 * docs.netlify.com/build/functions/environment-variables), so up to v0.2.1
 * production silently used a deploy-scoped store and every deploy started
 * with an empty one (found 2026-10-04: site store 0 keys, live deploy store 3).
 * The runtime source is the invocation's context, Netlify.context.deploy.context;
 * CONTEXT stays as the fallback for tests and local tooling.
 */
export function deployContext(): string | undefined {
  const ctx = (globalThis as any).Netlify?.context?.deploy?.context;
  return typeof ctx === "string" && ctx !== "" ? ctx : env("CONTEXT");
}

/** "site": the site-wide store (production deploys); "deploy": a deploy-scoped one (everything else). */
export function storeScope(): "site" | "deploy" {
  return deployContext() === "production" ? "site" : "deploy";
}

/**
 * The console's blob store (the store keeps its original name, "portal":
 * renaming it would orphan every record).
 * - testStore when installed (unit tests);
 * - the site-wide "portal" store in the production deploy context;
 * - a deploy-scoped "portal" store elsewhere (previews / branch deploys),
 *   so non-production deploys never touch production data.
 * @netlify/blobs is lazily imported so importing this module never requires
 * the Netlify runtime.
 */
export async function portalStore(): Promise<KV> {
  if (testStore) return testStore;
  const { getStore, getDeployStore } = await import("@netlify/blobs");
  // STRONG consistency: reads go to the origin, never a stale edge copy. The
  // default ("eventual") let a registration's own follow-up read miss the user
  // for ~13 s in production (measured 2026-09-14), and would let the estate
  // worker read a record older than the one it just saved. Latency is the price.
  const store =
    storeScope() === "site"
      ? getStore({ name: "portal", consistency: "strong" })
      : getDeployStore({ name: "portal", consistency: "strong" });
  return {
    get: (key, opts) => store.get(key, opts as any),
    setJSON: async (key, value) => {
      await store.setJSON(key, value);
    },
    setJSONIfNew: async (key, value) => (await store.setJSON(key, value, { onlyIfNew: true })).modified,
    getWithEtag: async (key) => {
      const r = await store.getWithMetadata(key, { type: "json" });
      return r && r.etag ? { data: r.data, etag: r.etag } : null;
    },
    setJSONIfMatch: async (key, value, etag) => (await store.setJSON(key, value, { onlyIfMatch: etag })).modified,
    delete: (key) => store.delete(key),
    list: (opts) => store.list(opts),
  };
}
