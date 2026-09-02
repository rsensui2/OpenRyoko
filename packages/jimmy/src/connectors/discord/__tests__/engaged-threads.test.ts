import { describe, it, expect } from "vitest";
import { EngagedThreadTracker } from "../engaged-threads.js";

describe("EngagedThreadTracker", () => {
  it("remembers recorded threads and nothing else", () => {
    const tracker = new EngagedThreadTracker();
    tracker.record("t1");
    expect(tracker.has("t1")).toBe(true);
    expect(tracker.has("t2")).toBe(false);
  });

  it("evicts the least recently engaged thread past the cap", () => {
    const tracker = new EngagedThreadTracker(2);
    tracker.record("t1");
    tracker.record("t2");
    tracker.record("t3");
    expect(tracker.has("t1")).toBe(false);
    expect(tracker.has("t2")).toBe(true);
    expect(tracker.has("t3")).toBe(true);
  });

  it("re-recording refreshes recency", () => {
    const tracker = new EngagedThreadTracker(2);
    tracker.record("t1");
    tracker.record("t2");
    tracker.record("t1");
    tracker.record("t3");
    expect(tracker.has("t1")).toBe(true);
    expect(tracker.has("t2")).toBe(false);
    expect(tracker.has("t3")).toBe(true);
  });
});
