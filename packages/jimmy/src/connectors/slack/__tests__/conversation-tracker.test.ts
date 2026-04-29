import { describe, it, expect } from "vitest";
import { ConversationTracker } from "../conversation-tracker.js";

describe("ConversationTracker.keyFor", () => {
  it("returns a thread key when thread_ts != ts", () => {
    expect(
      ConversationTracker.keyFor({ channel: "C1", threadTs: "T1", ts: "T2", userId: "U1" }),
    ).toBe("C1:thread:T1");
  });

  it("returns a user key when thread_ts is undefined", () => {
    expect(
      ConversationTracker.keyFor({ channel: "C1", ts: "T1", userId: "U1" }),
    ).toBe("C1:user:U1");
  });

  it("returns a user key when thread_ts equals ts (thread root, no replies)", () => {
    expect(
      ConversationTracker.keyFor({ channel: "C1", threadTs: "T1", ts: "T1", userId: "U1" }),
    ).toBe("C1:user:U1");
  });

  it("returns null when channel is missing", () => {
    expect(ConversationTracker.keyFor({ channel: "", ts: "T1", userId: "U1" })).toBeNull();
  });

  it("returns null when userId is missing", () => {
    expect(ConversationTracker.keyFor({ channel: "C1", ts: "T1", userId: "" })).toBeNull();
  });
});

describe("ConversationTracker — DM-equivalent gating", () => {
  it("starts non-DM-equivalent (bot has not engaged)", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "C1", ts: "T1", userId: "U1" });
    expect(t.isDmEquivalent({ channel: "C1", ts: "T1", userId: "U1" })).toBe(false);
  });

  it("becomes DM-equivalent after bot engages with single human", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "C1", ts: "T1", userId: "U1" });
    t.recordBotEngaged({ channel: "C1", ts: "T1", userId: "U1" });
    expect(t.isDmEquivalent({ channel: "C1", ts: "T2", userId: "U1" })).toBe(true);
  });

  it("breaks DM-equivalence when a third party speaks in the same thread", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "C1", threadTs: "T1", ts: "T2", userId: "U1" });
    t.recordBotEngaged({ channel: "C1", threadTs: "T1", ts: "T2", userId: "U1" });
    expect(t.isDmEquivalent({ channel: "C1", threadTs: "T1", ts: "T3", userId: "U1" })).toBe(true);

    t.recordHumanMessage({ channel: "C1", threadTs: "T1", ts: "T4", userId: "U2" });
    expect(t.isDmEquivalent({ channel: "C1", threadTs: "T1", ts: "T5", userId: "U1" })).toBe(false);
  });

  it("does not break user-key DM-equivalence when another user posts elsewhere in the channel", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "C1", ts: "T1", userId: "U1" });
    t.recordBotEngaged({ channel: "C1", ts: "T1", userId: "U1" });

    t.recordHumanMessage({ channel: "C1", ts: "T2", userId: "U2" });
    expect(t.isDmEquivalent({ channel: "C1", ts: "T3", userId: "U1" })).toBe(true);
  });

  it("permanence: DM-equivalence survives many follow-ups without TTL", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "C1", ts: "T1", userId: "U1" });
    t.recordBotEngaged({ channel: "C1", ts: "T1", userId: "U1" });
    for (let i = 0; i < 100; i += 1) {
      t.recordHumanMessage({ channel: "C1", ts: `T${i}`, userId: "U1" });
    }
    expect(t.isDmEquivalent({ channel: "C1", ts: "T999", userId: "U1" })).toBe(true);
  });
});

describe("ConversationTracker — thread/channel-user bridging", () => {
  it("primes the future thread key when the bot engages with a top-level message", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "C1", ts: "T1", userId: "U1" });
    t.recordBotEngaged({ channel: "C1", ts: "T1", userId: "U1" });

    expect(t.isDmEquivalent({ channel: "C1", threadTs: "T1", ts: "T2", userId: "U1" })).toBe(true);
  });

  it("user follow-up in thread inherits engagement primed at top level", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "C1", ts: "T1", userId: "U1" });
    t.recordBotEngaged({ channel: "C1", ts: "T1", userId: "U1" });

    t.recordHumanMessage({ channel: "C1", threadTs: "T1", ts: "T2", userId: "U1" });
    expect(t.isDmEquivalent({ channel: "C1", threadTs: "T1", ts: "T3", userId: "U1" })).toBe(true);
  });

  it("user-key still active after bot replied via thread (mixed top-level + thread follow-ups)", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "C1", ts: "T1", userId: "U1" });
    t.recordBotEngaged({ channel: "C1", ts: "T1", userId: "U1" });

    expect(t.isDmEquivalent({ channel: "C1", ts: "T99", userId: "U1" })).toBe(true);
  });
});

describe("ConversationTracker — bot-initiated threads", () => {
  it("treats first human reply in a bot-initiated thread as DM-equivalent", () => {
    const t = new ConversationTracker();
    t.recordBotInitiatedThread("C1", "T1");

    t.recordHumanMessage({ channel: "C1", threadTs: "T1", ts: "T2", userId: "U1" });
    expect(t.isDmEquivalent({ channel: "C1", threadTs: "T1", ts: "T3", userId: "U1" })).toBe(true);
  });

  it("reverts to triage in bot-initiated thread when a second human joins", () => {
    const t = new ConversationTracker();
    t.recordBotInitiatedThread("C1", "T1");

    t.recordHumanMessage({ channel: "C1", threadTs: "T1", ts: "T2", userId: "U1" });
    t.recordHumanMessage({ channel: "C1", threadTs: "T1", ts: "T3", userId: "U2" });
    expect(t.isDmEquivalent({ channel: "C1", threadTs: "T1", ts: "T4", userId: "U1" })).toBe(false);
  });
});

describe("ConversationTracker — robustness", () => {
  it("tolerates missing fields in keyFor inputs", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "", ts: "T1", userId: "U1" });
    t.recordBotEngaged({ channel: "C1", ts: "T1", userId: "" });
    expect(t.size()).toBe(0);
  });

  it("invalidate clears a specific key", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "C1", ts: "T1", userId: "U1" });
    t.recordBotEngaged({ channel: "C1", ts: "T1", userId: "U1" });
    expect(t.isDmEquivalent({ channel: "C1", ts: "T2", userId: "U1" })).toBe(true);

    t.invalidate("C1:user:U1");
    expect(t.isDmEquivalent({ channel: "C1", ts: "T3", userId: "U1" })).toBe(false);
  });
});
