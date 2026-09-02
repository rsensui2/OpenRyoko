import { describe, it, expect } from "vitest";
import { EngagedThreadTracker } from "../engaged-threads.js";

describe("EngagedThreadTracker", () => {
  it("remembers recorded ids and nothing else", () => {
    const tracker = new EngagedThreadTracker();
    tracker.record("t1");
    expect(tracker.has("t1")).toBe(true);
    expect(tracker.has("t2")).toBe(false);
  });

  it("never evicts — engagement is a promise for the life of the process", () => {
    const tracker = new EngagedThreadTracker();
    tracker.record("first");
    for (let i = 0; i < 10_000; i++) tracker.record(`m${i}`);
    expect(tracker.has("first")).toBe(true);
    expect(tracker.has("m0")).toBe(true);
    expect(tracker.has("m9999")).toBe(true);
  });
});
