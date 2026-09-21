import { describe, it, expect } from "vitest";
import { ConversationTracker, type ConversationKeyInput } from "../conversation-tracker.js";

const userMessage: ConversationKeyInput = { channel: "C1", ts: "T1", userId: "U1" };
const threadMessage: ConversationKeyInput = { ...userMessage, threadTs: "ROOT" };

function fixture(options: { maxEntries?: number; idleTimeoutMs?: number } = {}) {
  let now = 1000;
  return {
    tracker: new ConversationTracker({ now: () => now, idleTimeoutMs: 100, ...options }),
    advance: (ms: number) => { now += ms; },
  };
}

describe("ConversationTracker.keyFor", () => {
  it("shares a thread key for replies", () => {
    expect(ConversationTracker.keyFor(threadMessage)).toBe("C1:thread:ROOT");
    expect(ConversationTracker.keyFor({ ...threadMessage, userId: "U2" })).toBe("C1:thread:ROOT");
  });
  it("uses channel + user for top-level messages and thread roots", () => {
    expect(ConversationTracker.keyFor(userMessage)).toBe("C1:user:U1");
    expect(ConversationTracker.keyFor({ ...userMessage, threadTs: "T1" })).toBe("C1:user:U1");
  });
  it("rejects missing channel or user", () => {
    expect(ConversationTracker.keyFor({ ...userMessage, channel: "" })).toBeNull();
    expect(ConversationTracker.keyFor({ ...userMessage, userId: "" })).toBeNull();
  });
});

describe("ConversationTracker — conversational permission", () => {
  it("starts with no bypass and acceptance alone does not create one", () => {
    const { tracker: t } = fixture();
    expect(t.getContext(userMessage).status).toBe("none");
    t.recordHumanMessage(userMessage);
    t.recordAcceptedMessage(userMessage);
    expect(t.isDmEquivalent(userMessage)).toBe(false);
  });
  it("reactions alone never grant either DM bypass or thread engagement", () => {
    const { tracker: t, advance } = fixture();
    t.recordHumanMessage(userMessage);
    t.recordBotReaction(userMessage);
    t.recordBotReaction(threadMessage);
    expect(t.getContext(userMessage).status).toBe("reacted");
    expect(t.isDmEquivalent(userMessage)).toBe(false);
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
    expect(t.isBotEngagedThread("C1", "ROOT")).toBe(false);
    advance(24 * 60 * 60 * 1000);
    t.recordHumanMessage({ ...userMessage, ts: "unrelated-next-day" });
    expect(t.isDmEquivalent(userMessage)).toBe(false);
  });
  it("an actual reply grants time-limited followup bypass", () => {
    const { tracker: t, advance } = fixture();
    t.recordBotEngaged(userMessage);
    advance(99);
    t.recordHumanMessage({ ...userMessage, ts: "followup" });
    expect(t.isDmEquivalent(userMessage)).toBe(true);
    t.recordAcceptedMessage(userMessage);
    advance(99);
    expect(t.isDmEquivalent(userMessage)).toBe(true);
    advance(1);
    expect(t.isDmEquivalent(userMessage)).toBe(false);
    expect(t.getContext(userMessage).status).toBe("none");
  });
  it("passively observed messages do not extend a conversation", () => {
    const { tracker: t, advance } = fixture();
    t.recordBotReply(userMessage);
    advance(90);
    t.recordHumanMessage({ ...userMessage, ts: "addressed-to-somebody-else" });
    advance(10);
    expect(t.isDmEquivalent(userMessage)).toBe(false);
  });
  it("a human message cannot revive an already expired conversation", () => {
    const { tracker: t, advance } = fixture();
    t.recordBotReply(userMessage);
    advance(101);
    t.recordHumanMessage({ ...userMessage, ts: "new-topic" });
    t.recordAcceptedMessage(userMessage);
    expect(t.isDmEquivalent(userMessage)).toBe(false);
  });
  it("a reaction does not renew an existing conversation", () => {
    const { tracker: t, advance } = fixture();
    t.recordBotReply(userMessage);
    advance(90);
    t.recordBotReaction(userMessage);
    expect(t.isDmEquivalent(userMessage)).toBe(true);
    advance(10);
    expect(t.isDmEquivalent(userMessage)).toBe(false);
  });
  it("a reaction does not reopen a completed conversation", () => {
    const { tracker: t } = fixture();
    t.recordBotReply(userMessage);
    t.recordCompleted(userMessage);
    t.recordBotReaction(userMessage);
    t.recordHumanMessage(userMessage);
    expect(t.getContext(userMessage).status).toBe("completed");
    expect(t.isDmEquivalent(userMessage)).toBe(false);
  });
  it("third-party speech in the same thread breaks one-to-one bypass", () => {
    const { tracker: t } = fixture();
    t.recordBotReply(threadMessage);
    expect(t.isDmEquivalent(threadMessage)).toBe(true);
    expect(t.isDmEquivalent({ ...threadMessage, userId: "U2" })).toBe(false);
    t.recordHumanMessage({ ...threadMessage, userId: "U2" });
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
    expect(t.isBotEngagedThread("C1", "ROOT")).toBe(true);
  });
  it("keeps independent users and channels separate", () => {
    const { tracker: t } = fixture();
    t.recordBotReply(userMessage);
    t.recordHumanMessage({ ...userMessage, userId: "U2" });
    expect(t.isDmEquivalent(userMessage)).toBe(true);
    expect(t.isDmEquivalent({ ...userMessage, userId: "U2" })).toBe(false);
    expect(t.isDmEquivalent({ ...userMessage, channel: "C2" })).toBe(false);
  });
});

describe("ConversationTracker — explicit pending input", () => {
  it("keeps next-day GO eligible and consumes it only when accepted", () => {
    const { tracker: t, advance } = fixture();
    t.recordAwaitingInput(userMessage);
    advance(24 * 60 * 60 * 1000);
    t.recordHumanMessage({ ...userMessage, ts: "next-day-GO" });
    expect(t.getContext(userMessage).status).toBe("awaiting_input");
    expect(t.isDmEquivalent(userMessage)).toBe(true);
    t.recordAcceptedMessage(userMessage);
    expect(t.getContext(userMessage).status).toBe("conversing");
    expect(t.getContext(userMessage).awaitingUserId).toBeNull();
    expect(t.isDmEquivalent(userMessage)).toBe(true);
    advance(100);
    expect(t.isDmEquivalent(userMessage)).toBe(false);
  });
  it("observing a gated-out message or reacting does not clear pending input", () => {
    const { tracker: t, advance } = fixture();
    t.recordAwaitingInput(userMessage);
    advance(1000);
    t.recordHumanMessage({ ...userMessage, ts: "addressed-to-somebody-else" });
    t.recordBotReaction(userMessage);
    advance(1000);
    expect(t.getContext(userMessage).status).toBe("awaiting_input");
    expect(t.isDmEquivalent(userMessage)).toBe(true);
  });
  it("third party cannot consume another human's pending input", () => {
    const { tracker: t } = fixture();
    t.recordAwaitingInput(threadMessage);
    const other = { ...threadMessage, userId: "U2" };
    t.recordHumanMessage(other);
    t.recordAcceptedMessage(other);
    expect(t.getContext(threadMessage).status).toBe("awaiting_input");
    expect(t.getContext(threadMessage).awaitingUserId).toBe("U1");
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
    expect(t.isDmEquivalent(other)).toBe(false);
  });
  it("closing a pending conversation removes bypass but preserves actual membership", () => {
    const { tracker: t, advance } = fixture();
    t.recordAwaitingInput(threadMessage);
    t.recordCompleted(threadMessage);
    advance(1000);
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
    expect(t.isBotEngagedThread("C1", "ROOT")).toBe(true);
    expect(t.getContext(threadMessage).awaitingUserId).toBeNull();
  });
  it("ordinary engagement never invents awaiting-input state", () => {
    const { tracker: t } = fixture();
    t.recordBotEngaged(userMessage);
    expect(t.getContext(userMessage).status).toBe("conversing");
    expect(t.getContext(userMessage).awaitingUserId).toBeNull();
  });
  it("reply options record explicit pending input or completion", () => {
    const { tracker: t } = fixture();
    t.recordBotReply(userMessage, { awaitingInput: true });
    expect(t.getContext(userMessage).status).toBe("awaiting_input");
    t.recordBotReply(userMessage, { completed: true, awaitingInput: true });
    expect(t.getContext(userMessage).status).toBe("completed");
    expect(t.getContext(userMessage).awaitingUserId).toBeNull();
  });
  it("applies structured state to the original channel/user key without a fabricated reply", () => {
    const { tracker: t, advance } = fixture();
    t.recordBotReply(userMessage, { messageTs: "actual-reply" });
    advance(50);
    t.setConversationState(userMessage, "awaiting_input");
    expect(t.getContext(userMessage)).toMatchObject({
      status: "awaiting_input", lastBotMessageAt: 1000, lastMessageTs: "actual-reply",
    });
    t.setConversationState(userMessage, "completed");
    expect(t.isDmEquivalent(userMessage)).toBe(false);
  });
  it("runtime state updates do not invent bot messages or thread membership", () => {
    const { tracker: t } = fixture();
    t.recordHumanMessage(threadMessage);
    t.setThreadState("C1", "ROOT", "awaiting_input", "U1");
    expect(t.getContext(threadMessage)).toMatchObject({ status: "awaiting_input", lastActor: "human", lastBotMessageAt: null });
    expect(t.isBotEngagedThread("C1", "ROOT")).toBe(false);
    t.setThreadState("C1", "ROOT", "completed");
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
  });
});

describe("ConversationTracker — thread routing", () => {
  it("top-level engagement does not fabricate a future thread", () => {
    const { tracker: t } = fixture();
    t.recordBotReply(userMessage);
    expect(t.isDmEquivalent({ ...userMessage, threadTs: "T1", ts: "T2" })).toBe(false);
    expect(t.isBotEngagedThread("C1", "T1")).toBe(false);
  });
  it("actual thread replies retain membership after idle expiry without bypass", () => {
    const { tracker: t, advance } = fixture();
    t.recordHumanMessage(threadMessage);
    t.recordBotThreadReply("C1", "ROOT");
    expect(t.isDmEquivalent(threadMessage)).toBe(true);
    expect(t.getContext(threadMessage).botCreatedThread).toBe(false);
    advance(100);
    expect(t.isBotEngagedThread("C1", "ROOT")).toBe(true);
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
  });
  it("an unattributed reply in a human-root thread does not adopt the first observed human", () => {
    const { tracker: t } = fixture();
    t.recordBotThreadReply("C1", "ROOT");
    t.recordHumanMessage(threadMessage);
    expect(t.isBotEngagedThread("C1", "ROOT")).toBe(true);
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
    t.recordAcceptedMessage(threadMessage);
    expect(t.isDmEquivalent(threadMessage)).toBe(true);
  });
  it("an explicit recipient establishes bypass for an existing human-root thread", () => {
    const { tracker: t } = fixture();
    t.recordBotThreadReply("C1", "ROOT");
    t.recordBotReply(threadMessage);
    expect(t.isDmEquivalent(threadMessage)).toBe(true);
    t.recordHumanMessage({ ...threadMessage, userId: "U2" });
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
  });
  it("bot-created roots keep respondTo eligibility but late replies get triaged", () => {
    const { tracker: t, advance } = fixture();
    t.recordBotInitiatedThread("C1", "ROOT");
    t.recordHumanMessage(threadMessage);
    expect(t.isDmEquivalent(threadMessage)).toBe(true);
    advance(100);
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
    expect(t.isBotEngagedThread("C1", "ROOT")).toBe(true);
    t.recordCompleted(threadMessage);
    expect(t.isBotEngagedThread("C1", "ROOT")).toBe(true);
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
  });
  it("supports explicit input request in an unattributed bot-created thread", () => {
    const { tracker: t, advance } = fixture();
    t.recordBotInitiatedThread("C1", "ROOT", { awaitingInput: true });
    advance(1000);
    t.recordHumanMessage(threadMessage);
    expect(t.isDmEquivalent(threadMessage)).toBe(true);
    t.recordAcceptedMessage(threadMessage);
    expect(t.getContext(threadMessage).status).toBe("conversing");
  });
});

describe("ConversationTracker — bounded memory", () => {
  it("preserves active and pending entries ahead of passive observations", () => {
    const { tracker: t } = fixture({ maxEntries: 3 });
    t.recordBotReply(userMessage);
    t.recordAwaitingInput(threadMessage);
    for (let i = 0; i < 10; i += 1) {
      t.recordHumanMessage({ ...userMessage, channel: `noise-${i}` });
      expect(t.size()).toBeLessThanOrEqual(3);
    }
    expect(t.isDmEquivalent(userMessage)).toBe(true);
    expect(t.isDmEquivalent(threadMessage)).toBe(true);
  });
  it("evicts a conversation before a pending question when all entries are active", () => {
    const { tracker: t } = fixture({ maxEntries: 2 });
    t.recordAwaitingInput(userMessage);
    t.recordBotReply(threadMessage);
    t.recordBotReply({ ...userMessage, channel: "C2" });
    expect(t.size()).toBe(2);
    expect(t.isDmEquivalent(userMessage)).toBe(true);
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
  });
  it("maintains a hard cap even when every entry awaits input", () => {
    const { tracker: t } = fixture({ maxEntries: 2 });
    t.recordAwaitingInput(userMessage);
    t.recordAwaitingInput(threadMessage);
    t.recordAwaitingInput({ ...userMessage, channel: "C2" });
    expect(t.size()).toBe(2);
    expect(t.isDmEquivalent(userMessage)).toBe(false);
    expect(t.isDmEquivalent(threadMessage)).toBe(true);
  });
  it("bounds per-thread speaker memory as well as conversation entries", () => {
    const { tracker: t } = fixture();
    t.recordBotReply(threadMessage);
    for (let i = 0; i < 100; i += 1) t.recordHumanMessage({ ...threadMessage, userId: `U-${i}` });
    expect(t.getContext(threadMessage).humanSpeakerCount).toBe(2);
    expect(t.isDmEquivalent(threadMessage)).toBe(false);
  });
  it("does not claim pending context survives process restart", () => {
    const { tracker: t } = fixture();
    t.recordAwaitingInput(userMessage);
    const restarted = new ConversationTracker();
    expect(restarted.isDmEquivalent(userMessage)).toBe(false);
    expect(restarted.getContext(userMessage).status).toBe("none");
  });
});

describe("ConversationTracker — context and robustness", () => {
  it("reports observed actors separately from conversational activity", () => {
    const { tracker: t, advance } = fixture();
    t.recordHumanMessage(userMessage);
    t.recordBotReply(userMessage, { messageTs: "BOT-TS" });
    expect(t.getContext(userMessage)).toMatchObject({
      lastActor: "bot", lastHumanUserId: "U1", lastBotMessageAt: 1000,
      lastMessageTs: "BOT-TS", idleMs: 0,
    });
    advance(50);
    t.recordHumanMessage({ ...userMessage, ts: "FOLLOWUP-TS" });
    expect(t.getContext(userMessage)).toMatchObject({
      lastActor: "human", lastMessageTs: "FOLLOWUP-TS", lastMessageAt: 1050,
      lastBotMessageAt: 1000, idleMs: 50,
    });
  });
  it("tolerates missing key fields", () => {
    const { tracker: t } = fixture();
    for (const input of [{ ...userMessage, channel: "" }, { ...userMessage, userId: "" }]) {
      t.recordHumanMessage(input);
      t.recordAcceptedMessage(input);
      t.recordBotReply(input);
      t.recordBotReaction(input);
      t.recordAwaitingInput(input);
      t.recordCompleted(input);
      expect(t.isDmEquivalent(input)).toBe(false);
    }
    t.recordBotInitiatedThread("", "ROOT");
    t.recordBotThreadReply("C1", "");
    t.setThreadState("", "ROOT", "completed");
    expect(t.isBotEngagedThread("", "ROOT")).toBe(false);
    expect(t.isBotEngagedThread("C1", "")).toBe(false);
    expect(t.size()).toBe(0);
  });
  it("invalidation removes the conversation", () => {
    const { tracker: t } = fixture();
    t.recordAwaitingInput(userMessage);
    t.invalidate("C1:user:U1");
    expect(t.isDmEquivalent(userMessage)).toBe(false);
  });
  it("rejects invalid limits", () => {
    expect(() => new ConversationTracker({ maxEntries: 0 })).toThrow();
    expect(() => new ConversationTracker({ maxEntries: 1.5 })).toThrow();
    expect(() => new ConversationTracker({ idleTimeoutMs: -1 })).toThrow();
    expect(() => new ConversationTracker({ idleTimeoutMs: Infinity })).toThrow();
  });
});
