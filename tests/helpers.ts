// Test helpers for the Force-Field Console test suite.
// MemStore is an in-memory stand-in for Netlify Blobs implementing the shared KV contract.

import { setStoreForTesting, type KV } from "../src/lib/store";

export class MemStore implements KV {
  private map = new Map<string, unknown>();
  private etags = new Map<string, number>();
  private clock = 0;
  private touch(key: string): void {
    this.etags.set(key, ++this.clock);
  }

  async get(key: string, _opts?: { type?: "json" | "text" }): Promise<any> {
    if (!this.map.has(key)) return null;
    // Deep-cloned JSON so callers can never mutate stored state by reference.
    return structuredClone(this.map.get(key));
  }

  async setJSON(key: string, value: any): Promise<void> {
    // Store a structured clone so later mutation of the caller's object has no effect.
    this.map.set(key, structuredClone(value));
    this.touch(key);
  }

  async setJSONIfNew(key: string, value: any): Promise<boolean> {
    if (this.map.has(key)) return false;
    this.map.set(key, structuredClone(value));
    this.touch(key);
    return true;
  }

  async getWithEtag(key: string): Promise<{ data: any; etag: string } | null> {
    if (!this.map.has(key)) return null;
    return { data: structuredClone(this.map.get(key)), etag: String(this.etags.get(key)) };
  }

  async setJSONIfMatch(key: string, value: any, etag: string): Promise<boolean> {
    if (!this.map.has(key) || String(this.etags.get(key)) !== etag) return false;
    this.map.set(key, structuredClone(value));
    this.touch(key);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
    this.etags.delete(key);
  }

  async list(opts?: { prefix?: string }): Promise<{ blobs: { key: string }[] }> {
    const prefix = opts?.prefix ?? "";
    const blobs = [...this.map.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key }));
    return { blobs };
  }
}

// Installs a fresh in-memory store and a deterministic session secret.
// Returns the store so tests can inspect raw blobs.
export function freshStore(): MemStore {
  const store = new MemStore();
  setStoreForTesting(store);
  process.env.SESSION_SECRET = "test-secret-0123456789";
  return store;
}
