import { describe, it, expect, afterEach } from "vitest";
import { HookRegistry } from "../hook-registry.js";

describe("HookRegistry", () => {
  // Centralized teardown — every `new HookRegistry()` in a test gets pushed
  // here and disposed in afterEach so the sweep timer never leaks across tests.
  const registries: HookRegistry[] = [];
  const make = (ttlMs?: number, sweepIntervalMs?: number): HookRegistry => {
    const r = ttlMs === undefined
      ? new HookRegistry()
      : sweepIntervalMs === undefined
        ? new HookRegistry(ttlMs)
        : new HookRegistry(ttlMs, sweepIntervalMs);
    registries.push(r);
    return r;
  };
  afterEach(() => {
    while (registries.length > 0) registries.pop()!.dispose();
  });

  it("delivers a hook that arrives AFTER registration", () => {
    const reg = make();
    const seen: string[] = [];
    reg.register("s1", (h) => seen.push(h.hook_event_name));
    reg.deliver("s1", { hook_event_name: "SessionStart" } as any);
    expect(seen).toEqual(["SessionStart"]);
  });

  it("buffers a hook that arrives BEFORE registration and drains on register", () => {
    const reg = make();
    const seen: string[] = [];
    reg.deliver("s2", { hook_event_name: "SessionStart" } as any);
    expect(seen).toEqual([]);
    reg.register("s2", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual(["SessionStart"]);
  });

  it("marks drained hooks as buffered and live hooks as current delivery", () => {
    const reg = make();
    const deliveries: Array<{ event: string; buffered: boolean }> = [];
    reg.deliver("meta", { hook_event_name: "PreToolUse" });
    reg.register("meta", (hook, delivery) => deliveries.push({ event: hook.hook_event_name, buffered: delivery.buffered }));
    reg.deliver("meta", { hook_event_name: "PostToolUse" });
    expect(deliveries).toEqual([
      { event: "PreToolUse", buffered: true },
      { event: "PostToolUse", buffered: false },
    ]);
  });

  it("unregister stops delivery and clears buffer", () => {
    const reg = make();
    const seen: string[] = [];
    reg.register("s3", (h) => seen.push(h.hook_event_name));
    reg.unregister("s3");
    reg.deliver("s3", { hook_event_name: "Stop" } as any);
    expect(seen).toEqual([]);
  });

  it("drops buffered hooks past TTL", async () => {
    const reg = make(20); // 20ms TTL
    reg.deliver("s4", { hook_event_name: "SessionStart" } as any);
    await new Promise((r) => setTimeout(r, 40));
    const seen: string[] = [];
    reg.register("s4", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual([]);
  });

  it("routes a Stop with no listener to the orphan handler and does NOT buffer it", () => {
    const reg = make();
    const orphans: string[] = [];
    reg.setOrphanHandler((sid, h) => orphans.push(`${sid}:${h.hook_event_name}`));
    reg.deliver("s6", { hook_event_name: "Stop", last_assistant_message: "done" } as any);
    expect(orphans).toEqual(["s6:Stop"]);
    // A later register must NOT drain the consumed Stop into the new resolver —
    // that would settle the next turn instantly with the previous turn's text.
    const seen: string[] = [];
    reg.register("s6", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual([]);
  });

  it("routes a StopFailure orphan to the handler and does not buffer it", () => {
    const reg = make();
    const orphans: string[] = [];
    reg.setOrphanHandler((sid, h) => orphans.push(h.hook_event_name));
    reg.deliver("s7", { hook_event_name: "StopFailure", error: "server_error" } as any);
    expect(orphans).toEqual(["StopFailure"]);
    const seen: string[] = [];
    reg.register("s7", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual([]);
  });

  it("still buffers non-terminal orphans (and surfaces them as activity)", () => {
    const reg = make();
    const orphans: string[] = [];
    reg.setOrphanHandler((_sid, h) => orphans.push(h.hook_event_name));
    reg.deliver("s8", { hook_event_name: "PostToolUse" } as any);
    expect(orphans).toEqual(["PostToolUse"]); // activity signal fired
    const seen: string[] = [];
    reg.register("s8", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual(["PostToolUse"]); // and it still drains on register
  });

  it("does not invoke the orphan handler when a listener is registered", () => {
    const reg = make();
    const orphans: string[] = [];
    reg.setOrphanHandler((_sid, h) => orphans.push(h.hook_event_name));
    const seen: string[] = [];
    reg.register("s9", (h) => seen.push(h.hook_event_name));
    reg.deliver("s9", { hook_event_name: "Stop" } as any);
    expect(seen).toEqual(["Stop"]);
    expect(orphans).toEqual([]);
  });

  it("swallows orphan-handler exceptions (terminal orphans stay consumed)", () => {
    const reg = make();
    reg.setOrphanHandler(() => { throw new Error("boom"); });
    expect(() => reg.deliver("s10", { hook_event_name: "Stop" } as any)).not.toThrow();
    const seen: string[] = [];
    reg.register("s10", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual([]);
  });

  it("periodic sweep evicts stale entries but keeps fresh ones", async () => {
    const reg = make(50, 10); // 50ms TTL, 10ms sweep
    // t=0: deliver a stale entry that should age past TTL by t=80ms.
    reg.deliver("s5_old", { hook_event_name: "SessionStart" } as any);
    // Access internal buffer for assertion — keep registry visibility minimal.
    const buf = (reg as unknown as { buffer: Map<string, unknown[]> }).buffer;
    expect(buf.has("s5_old")).toBe(true);

    // At t=70ms, just before the t=80ms check, deliver a fresh entry. With a
    // 50ms TTL it must still be buffered at t=80ms — proves the sweep is
    // age-aware, not "wipe everything on tick".
    await new Promise((r) => setTimeout(r, 70));
    reg.deliver("s5_fresh", { hook_event_name: "SessionStart" } as any);

    await new Promise((r) => setTimeout(r, 10)); // now t≈80ms — at least one sweep has run
    expect(buf.has("s5_old")).toBe(false);
    expect(buf.has("s5_fresh")).toBe(true);
  });
});
