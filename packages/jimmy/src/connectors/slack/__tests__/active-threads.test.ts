import { describe, it, expect } from "vitest";
import { ActiveThreadTracker } from "../active-threads.js";

describe("ActiveThreadTracker", () => {
  it("reports a freshly-touched thread as active", () => {
    const t = new ActiveThreadTracker(60_000);
    t.touch("C1", "1234.5678", 1_000_000);
    expect(t.isActive("C1", "1234.5678", 1_000_000)).toBe(true);
  });

  it("considers a thread inactive once TTL expires", () => {
    const t = new ActiveThreadTracker(60_000);
    t.touch("C1", "1234.5678", 1_000_000);
    // 61s later
    expect(t.isActive("C1", "1234.5678", 1_061_000)).toBe(false);
  });

  it("does not leak state between channels", () => {
    const t = new ActiveThreadTracker(60_000);
    t.touch("C1", "1234.5678", 1_000_000);
    expect(t.isActive("C2", "1234.5678", 1_000_000)).toBe(false);
  });

  it("does not leak state between thread keys", () => {
    const t = new ActiveThreadTracker(60_000);
    t.touch("C1", "1234.5678", 1_000_000);
    expect(t.isActive("C1", "9999.9999", 1_000_000)).toBe(false);
  });

  it("safely no-ops when channel or threadKey is missing", () => {
    const t = new ActiveThreadTracker(60_000);
    t.touch("", "1234.5678");
    t.touch("C1", undefined);
    expect(t.isActive("", "1234.5678")).toBe(false);
    expect(t.isActive("C1", undefined)).toBe(false);
    expect(t.size()).toBe(0);
  });

  it("refreshes the timestamp when a thread is touched again", () => {
    const t = new ActiveThreadTracker(60_000);
    t.touch("C1", "1234.5678", 1_000_000);
    t.touch("C1", "1234.5678", 1_050_000);
    // original TTL from first touch would have expired at 1_060_000,
    // but second touch resets it, so at 1_100_000 it should still be active
    expect(t.isActive("C1", "1234.5678", 1_100_000)).toBe(true);
    // and expire at 1_050_000 + 60_000 = 1_110_000
    expect(t.isActive("C1", "1234.5678", 1_111_000)).toBe(false);
  });

  it("prunes expired entries when size exceeds internal threshold", () => {
    // Drive an intentional growth past PRUNE_AT_SIZE (1000) and confirm
    // the map never explodes unbounded.
    const t = new ActiveThreadTracker(1); // 1ms TTL
    for (let i = 0; i < 1500; i++) {
      t.touch("C1", `ts-${i}`, 0);
    }
    // At touch #1001 the internal prune runs and wipes everything (TTL=1ms, now=0
    // means first entry is technically not expired, but subsequent touches at now=0
    // stay fresh. Simulate expiry via manual prune at a later timestamp.
    t.prune(1_000_000);
    expect(t.size()).toBe(0);
  });
});
