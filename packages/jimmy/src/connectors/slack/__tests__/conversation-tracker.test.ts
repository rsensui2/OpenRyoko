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
  it("does NOT prime the future thread key from receipt-time engagement (outbound is responsible)", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "C1", ts: "T1", userId: "U1" });
    t.recordBotEngaged({ channel: "C1", ts: "T1", userId: "U1" });

    // Thread key has not been touched yet — the user follow-up in thread
    // should fall through to triage until the outbound path marks the
    // thread (which the connector does at replyMessage time).
    expect(t.isDmEquivalent({ channel: "C1", threadTs: "T1", ts: "T2", userId: "U1" })).toBe(false);
  });

  it("full flow: user top-level → bot replies in thread (outbound marks thread) → user follow-up in thread is DM-equivalent", () => {
    const t = new ConversationTracker();
    // 1. User posts top-level
    t.recordHumanMessage({ channel: "C1", ts: "T1", userId: "U1" });
    // 2. Bot decides to engage at receipt time — marks user-key engaged
    t.recordBotEngaged({ channel: "C1", ts: "T1", userId: "U1" });
    // 3. Bot calls replyMessage → outbound marks the thread anchor
    t.recordBotInitiatedThread("C1", "T1");
    // 4. User follows up in the thread
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

describe("ConversationTracker — eviction policy", () => {
  it("never evicts an engaged conversation when pruning under cap pressure", () => {
    const t = new ConversationTracker();
    // Engage one conversation early — this is the entry we must NOT lose.
    t.recordHumanMessage({ channel: "C-engaged", ts: "T1", userId: "U1" });
    t.recordBotEngaged({ channel: "C-engaged", ts: "T1", userId: "U1" });

    // Flood with 6000 distinct non-engaged (channel, user) pairs to push
    // the tracker past the prune threshold.
    for (let i = 0; i < 6000; i += 1) {
      t.recordHumanMessage({ channel: `C-noise-${i}`, ts: `T${i}`, userId: `U-noise-${i}` });
    }

    // The engaged conversation must still be DM-equivalent.
    expect(t.isDmEquivalent({ channel: "C-engaged", ts: "T-late", userId: "U1" })).toBe(true);
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

describe("ConversationTracker.isBotEngagedThread", () => {
  it("is true after the bot replies in the thread (recordBotInitiatedThread)", () => {
    const t = new ConversationTracker();
    t.recordBotInitiatedThread("C1", "T1");
    expect(t.isBotEngagedThread("C1", "T1")).toBe(true);
  });

  it("is true after recordBotEngaged on a threaded message", () => {
    const t = new ConversationTracker();
    t.recordBotEngaged({ channel: "C1", threadTs: "T1", ts: "T2", userId: "U1" });
    expect(t.isBotEngagedThread("C1", "T1")).toBe(true);
  });

  it("is false for threads the bot never engaged", () => {
    const t = new ConversationTracker();
    t.recordHumanMessage({ channel: "C1", threadTs: "T1", ts: "T2", userId: "U1" });
    expect(t.isBotEngagedThread("C1", "T1")).toBe(false);
  });

  it("is false for user-key engagement (top-level messages, no thread)", () => {
    const t = new ConversationTracker();
    t.recordBotEngaged({ channel: "C1", ts: "T1", userId: "U1" });
    expect(t.isBotEngagedThread("C1", "T1")).toBe(false);
  });

  it("tolerates missing fields", () => {
    const t = new ConversationTracker();
    expect(t.isBotEngagedThread("", "T1")).toBe(false);
    expect(t.isBotEngagedThread("C1", "")).toBe(false);
  });
});
