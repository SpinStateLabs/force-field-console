// The portal's KV contract (Netlify Blobs: create-only, etag CAS, strong reads) over MemStore, with
// per-operation VIRTUAL latency and invocation kills. An operation issued before its invocation died
// still lands (the request reached Blobs); its answer is never delivered to the dead invocation.
// Assumption A13 (true CAS, read-your-writes) is MODELLED, not tested: reads are always fresh here.
import { MemStore } from "../helpers";
import { setStoreForTesting, type KV } from "../../src/lib/store";
import { NEVER, clock } from "./vclock";

export class ModelStore implements KV {
  inner = new MemStore();
  /** Returns the latency (ms) of the next operation; 0 = synchronous (no scheduling point). */
  latency: () => number = () => 0;
  ops = 0;

  private run<T>(op: () => Promise<T>): Promise<T> {
    if (!clock.ioAllowed()) return NEVER;
    this.ops += 1;
    const lat = this.latency();
    if (lat <= 0) return op();
    const inv = clock.current();
    return new Promise<T>((resolve, reject) => {
      clock.scheduleDetached(lat, () => {
        op().then(
          (v) => { if (!inv?.dead) resolve(v); },
          (e) => { if (!inv?.dead) reject(e); },
        );
      });
    });
  }

  get(key: string, opts?: { type?: "json" | "text" }) { return this.run(() => this.inner.get(key, opts)); }
  setJSON(key: string, value: any) { const v = structuredClone(value); return this.run(() => this.inner.setJSON(key, v)); }
  setJSONIfNew(key: string, value: any) { const v = structuredClone(value); return this.run(() => this.inner.setJSONIfNew(key, v)); }
  getWithEtag(key: string) { return this.run(() => this.inner.getWithEtag(key)); }
  setJSONIfMatch(key: string, value: any, etag: string) { const v = structuredClone(value); return this.run(() => this.inner.setJSONIfMatch(key, v, etag)); }
  delete(key: string) { return this.run(() => this.inner.delete(key)); }
  list(opts?: { prefix?: string }) { return this.run(() => this.inner.list(opts)); }

  /** Direct read for the checker (no latency, no kill accounting). */
  peek(key: string): Promise<any> { return this.inner.get(key); }
  keys(prefix = ""): Promise<string[]> { return this.inner.list({ prefix }).then((r) => r.blobs.map((b) => b.key)); }
}

export function installModelStore(): ModelStore {
  const s = new ModelStore();
  setStoreForTesting(s);
  process.env.SESSION_SECRET = "test-secret-0123456789";
  return s;
}
