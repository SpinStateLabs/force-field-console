// The opt-in faithful mode of tests/model-fly.ts (defaults unchanged for every existing test).
import { describe, it, expect } from "vitest";
import { ModelFly } from "./model-fly";
import { FlyError } from "../src/lib/fly";

describe("ModelFly faithful mode", () => {
  it("strict: a destroyed / unknown machine answers 404 (null read, writes throw)", async () => {
    const f = new ModelFly();
    f.strict = true;
    expect(await f.getMachine("a", "nope")).toBeNull();
    f.machine("m1");
    f.destroy("m1");
    expect(await f.getMachine("a", "m1")).toBeNull();
    await expect(f.stopMachine("a", "m1")).rejects.toBeInstanceOf(FlyError);
    await expect(f.updateMachine("a", "m1", { image: "x", services: [] })).rejects.toMatchObject({ status: 404 });
  });
  it("update restarts a started machine unless skip_launch; the proxy wakes a stopped one with autostart on", async () => {
    const f = new ModelFly();
    f.machine("m1");
    await f.updateMachine("a", "m1", { image: "x", services: [{ autostart: true }] });
    expect(f.restarts).toBe(1);
    await f.stopMachine("a", "m1");
    await f.updateMachine("a", "m1", { image: "x", services: [{ autostart: true }] }, { skipLaunch: true });
    expect(f.machine("m1").state).toBe("stopped");
    expect(f.ping("m1")).toBe("started");
  });
  it("eventual reads: a read may return any version from the window", async () => {
    const f = new ModelFly();
    f.eventualMs = 60_000;
    f.eventualP = 1;
    let i = 0;
    f.rand = () => [0, 0, 0.99][i++ % 3];
    f.machine("m1");
    await f.stopMachine("a", "m1");
    await f.startMachine("a", "m1");
    const seen = new Set<string>();
    for (let k = 0; k < 6; k++) seen.add((await f.getMachine("a", "m1")).state);
    expect(seen.has("stopped")).toBe(true);
  });
  it("5xx / 429 before applying, and a wait that honours its timeout", async () => {
    const f = new ModelFly();
    f.p5xx = 1;
    f.rand = () => 0.9;
    f.machine("m1");
    await expect(f.stopMachine("a", "m1")).rejects.toMatchObject({ status: 429 });
    expect(f.machine("m1").state).toBe("started");
    const g = new ModelFly();
    g.honourWaitTimeout = true;
    g.waitDelay = 50_000;
    g.machine("m1");
    const t0 = Date.now();
    expect(await g.waitMachine("a", "m1", "started", 0.01)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
