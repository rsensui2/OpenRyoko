import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackConnector } from "../index.js";
import { ConversationTracker } from "../conversation-tracker.js";
import { runTriage } from "../triage.js";

vi.mock("../triage.js", () => ({ runTriage: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); });

async function fixture(mentionOnly = false) {
  let now = 0;
  let receive: (args: { event: Record<string, unknown> }) => Promise<void>;
  let receiveReaction: (args: { event: Record<string, unknown> }) => Promise<void>;
  const tracker = new ConversationTracker({ now: () => now, idleTimeoutMs: 1000 });
  const handler = vi.fn();
  const replies = vi.fn().mockResolvedValue({ messages: [] });
  const reactions = vi.fn().mockResolvedValue({ ok: true });
  const reactionMessage = vi.fn().mockResolvedValue({ message: {
    ts: "3.000", thread_ts: "1.000", user: "URYOKO", bot_id: "B1", text: "資料をお渡ししました。",
  } });
  const postMessage = vi.fn().mockResolvedValue({ ts: "3.000" });
  const connector = Object.create(SlackConnector.prototype) as SlackConnector;
  Object.assign(connector, {
    app: {
      message: (callback: typeof receive) => { receive = callback; },
      event: (_name: string, callback: typeof receiveReaction) => { receiveReaction = callback; }, start: vi.fn(),
      client: {
        auth: { test: vi.fn().mockResolvedValue({ user_id: "URYOKO" }) },
        conversations: { replies, history: vi.fn().mockResolvedValue({ messages: [] }), info: vi.fn().mockResolvedValue({ channel: { name: "test" } }) },
        users: { info: vi.fn().mockResolvedValue({ user: { name: "Taro" } }) },
        reactions: { add: reactions, get: reactionMessage }, chat: { postMessage },
      },
    },
    conversations: tracker, triageConfig: { enabled: true, backend: "jev" },
    respondTo: mentionOnly ? { channel: "mention" } : undefined,
    handler, allowedUsers: null, ignoreOldMessagesOnBoot: false,
    userInfoCache: new Map(), channelNameCache: new Map(), agentsCanvas: null,
  });
  vi.mocked(runTriage).mockResolvedValue({ action: "reply" });
  await connector.start();
  const event = (text: string, extra: Record<string, unknown> = {}) => receive!({ event: {
    channel: "C1", user: "U1", ts: "4.000", thread_ts: "1.000", channel_type: "channel", text, ...extra,
  } });
  const reaction = (emoji: string, extra: Record<string, unknown> = {}) => receiveReaction!({ event: {
    item: { type: "message", channel: "C1", ts: "3.000" }, user: "U1", reaction: emoji, event_ts: "4.000", ...extra,
  } });
  return { connector, tracker, handler, replies, reactions, reactionMessage, reaction, postMessage, event, advance: () => { now += 2000; } };
}

describe("Slack conversation routing integration", () => {
  it("a triage reaction does not bypass triage for the next human message", async () => {
    const f = await fixture();
    vi.mocked(runTriage).mockResolvedValueOnce({ action: "react", emoji: "pray" });
    await f.event("ありがとう！");
    expect(f.handler).not.toHaveBeenCalled();
    await f.event("これは別の話です", { ts: "5.000" });
    expect(runTriage).toHaveBeenCalledTimes(2);
    expect(f.tracker.isBotEngagedThread("C1", "1.000")).toBe(false);
  });

  it("processing reactions never grant mention-scope membership, even on failure", async () => {
    const f = await fixture(true);
    f.reactions.mockRejectedValueOnce(new Error("failed"));
    await f.connector.addReaction({ channel: "C1", thread: "1.000", messageTs: "2.000" }, "eyes");
    await f.connector.addReaction({ channel: "C1", thread: "1.000", messageTs: "2.000" }, "eyes");
    await f.event("お願いします");
    expect(f.handler).not.toHaveBeenCalled();
    expect(runTriage).not.toHaveBeenCalled();
  });

  it("actual reply grants membership; idle expiry returns followups to triage", async () => {
    const f = await fixture(true);
    await f.event("<@URYOKO> 調査して");
    await f.connector.replyMessage({ channel: "C1", thread: "1.000" }, "調べました");
    await f.event("補足して");
    expect(runTriage).not.toHaveBeenCalled();
    f.advance();
    await f.event("次の話です");
    expect(runTriage).toHaveBeenCalledTimes(1);
    expect(f.handler).toHaveBeenCalledTimes(3);
  });

  it("successful replies attribute both a root author and the short-lived channel conversation", async () => {
    const f = await fixture();
    await f.event("<@URYOKO> 集計して", { thread_ts: undefined, ts: "1.000" });
    const incoming = f.handler.mock.calls[0][0];
    await f.connector.replyMessage(f.connector.reconstructTarget(incoming.replyContext), "集計できました");
    await f.event("その数字をもう少し詳しく", { thread_ts: undefined, ts: "5.000" });
    expect(runTriage).not.toHaveBeenCalled();
    // The original root author must remain known when another human joins.
    await f.event("花子さん、確認できますか", { user: "U2", ts: "6.000" });
    expect(runTriage).toHaveBeenCalledTimes(1);
    f.advance();
    await f.event("別の話です", { thread_ts: undefined, ts: "7.000" });
    expect(runTriage).toHaveBeenCalledTimes(2);
  });

  it("pending input survives idle and an observation addressed to another user", async () => {
    const f = await fixture(true);
    await f.connector.replyMessage({ channel: "C1", thread: "1.000" }, "どちらにしますか");
    f.connector.setConversationState({ channel: "C1", thread: "1.000" }, "awaiting_input", "U1");
    f.advance();
    await f.event("<@UOTHER> これは別件です");
    expect(f.tracker.getContext({ channel: "C1", threadTs: "1.000", userId: "U1" }).status).toBe("awaiting_input");
    await f.event("A案でお願いします");
    expect(runTriage).not.toHaveBeenCalled();
    expect(f.handler).toHaveBeenCalledTimes(1);
  });

  it("structured outcomes update the original channel conversation and its thread together", async () => {
    const f = await fixture();
    await f.event("<@URYOKO> 調査して", { thread_ts: undefined, ts: "1.000" });
    const target = f.connector.reconstructTarget(f.handler.mock.calls[0][0].replyContext);
    await f.connector.replyMessage(target, "A案とB案、どちらですか？");
    f.connector.setConversationState(target, "awaiting_input", "U1");
    f.advance();
    expect(f.tracker.isDmEquivalent({ channel: "C1", userId: "U1" })).toBe(true);
    expect(f.tracker.isDmEquivalent({ channel: "C1", threadTs: "1.000", userId: "U1" })).toBe(true);
    f.connector.setConversationState(target, "completed", "U1");
    expect(f.tracker.getContext({ channel: "C1", userId: "U1" }).status).toBe("completed");
    expect(f.tracker.isDmEquivalent({ channel: "C1", userId: "U1" })).toBe(false);
    expect(f.tracker.isDmEquivalent({ channel: "C1", threadTs: "1.000", userId: "U1" })).toBe(false);
  });

  it("a thread answer consumes and completes its original root conversation", async () => {
    const f = await fixture();
    await f.event("<@URYOKO> 調査して", { thread_ts: undefined, ts: "1.000" });
    const root = f.connector.reconstructTarget(f.handler.mock.calls[0][0].replyContext);
    await f.connector.replyMessage(root, "A案とB案、どちらですか？");
    f.connector.setConversationState(root, "awaiting_input", "U1");
    f.advance();
    await f.event("A案で進めて", { ts: "5.000" });
    expect(f.tracker.getContext({ channel: "C1", userId: "U1" }).status).toBe("conversing");
    const answer = f.connector.reconstructTarget(f.handler.mock.calls[1][0].replyContext);
    await f.connector.replyMessage(answer, "完了しました");
    f.connector.setConversationState(answer, "completed", "U1");
    expect(f.tracker.getContext({ channel: "C1", userId: "U1" }).status).toBe("completed");
    expect(f.tracker.getContext({ channel: "C1", threadTs: "1.000", userId: "U1" }).status).toBe("completed");
    await f.event("これは別の話", { thread_ts: undefined, ts: "6.000" });
    expect(runTriage).toHaveBeenCalledTimes(1);
  });

  it("completing an older thread preserves the same user's newer pending root", async () => {
    const f = await fixture();
    for (const ts of ["1.000", "2.000"]) {
      await f.event("<@URYOKO> 調査して", { thread_ts: undefined, ts });
      const root = f.connector.reconstructTarget(f.handler.mock.calls.at(-1)![0].replyContext);
      await f.connector.replyMessage(root, "どちらにしますか？");
      f.connector.setConversationState(root, "awaiting_input", "U1");
    }
    await f.event("A案で", { thread_ts: "1.000", ts: "5.000" });
    const answer = f.connector.reconstructTarget(f.handler.mock.calls.at(-1)![0].replyContext);
    await f.connector.replyMessage(answer, "完了しました");
    f.connector.setConversationState(answer, "completed", "U1");
    expect(f.tracker.getContext({ channel: "C1", threadTs: "1.000", userId: "U1" }).status).toBe("completed");
    expect(f.tracker.getContext({ channel: "C1", threadTs: "2.000", userId: "U1" }).status).toBe("awaiting_input");
    expect(f.tracker.getContext({ channel: "C1", userId: "U1" }).status).toBe("awaiting_input");
  });

  it("completion and another human prevent unconditional conversation bypass", async () => {
    const f = await fixture();
    await f.connector.replyMessage({ channel: "C1", thread: "1.000" }, "完了しました");
    f.connector.setConversationState({ channel: "C1", thread: "1.000" }, "completed", "U1");
    await f.event("次の話です");
    expect(runTriage).toHaveBeenCalledTimes(1);
    await f.connector.replyMessage({ channel: "C1", thread: "1.000" }, "どうぞ");
    await f.event("人間同士の相談です", { user: "U2" });
    expect(runTriage).toHaveBeenCalledTimes(2);
  });

  it("only our own immediately preceding reply protects a continuation", async () => {
    for (const user of ["UOTHERBOT", "URYOKO"]) {
      const f = await fixture();
      f.replies.mockResolvedValue({ messages: [{ ts: "3.000", user, bot_id: "B1", text: "進めますか？" }] });
      vi.mocked(runTriage).mockResolvedValue({ action: "silent" });
      await f.event("はい");
      expect(f.handler.mock.calls.length).toBe(user === "URYOKO" ? 1 : 0);
      const input = vi.mocked(runTriage).mock.calls.at(-1)![0];
      expect(input.previousWasSelf).toBe(user === "URYOKO");
    }
  });

  it("DMs and explicit mentions route directly without Jev", async () => {
    const f = await fixture();
    await f.event("調査して", { channel_type: "im" });
    await f.event("<@URYOKO> お願い");
    expect(f.handler).toHaveBeenCalledTimes(2);
    expect(runTriage).not.toHaveBeenCalled();
  });

  it("shows eyes before dispatching accepted work, but only the chosen emoji for acknowledgment", async () => {
    const f = await fixture();
    await f.event("<@URYOKO> 調査して");
    expect(f.reactions.mock.calls[0][0].name).toBe("eyes");
    expect(f.reactions.mock.invocationCallOrder[0]).toBeLessThan(f.handler.mock.invocationCallOrder[0]);
    f.reactions.mockClear();
    vi.mocked(runTriage).mockResolvedValue({ action: "react", emoji: "pray" });
    await f.event("ありがとう");
    expect(f.reactions.mock.calls.map((call) => call[0].name)).toEqual(["pray"]);
    f.reactions.mockClear();
    vi.mocked(runTriage).mockResolvedValue({ action: "silent" });
    await f.event("人間同士の話です");
    expect(f.reactions).not.toHaveBeenCalled();
  });

  it("acknowledges a reaction on completed work without starting a session or adding eyes", async () => {
    const f = await fixture();
    vi.mocked(runTriage).mockResolvedValue({ action: "react", emoji: "pray" });
    await f.reaction("thumbsup");
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.reactions.mock.calls.map((call) => call[0].name)).toEqual(["pray"]);
    expect(vi.mocked(runTriage).mock.calls[0][0]).toMatchObject({ isReaction: true, previousWasSelf: true });
  });

  it("routes a pending approval reaction to its existing thread session after eyes", async () => {
    const f = await fixture();
    await f.connector.replyMessage({ channel: "C1", thread: "1.000" }, "A案でよいですか？");
    f.connector.setConversationState({ channel: "C1", thread: "1.000" }, "awaiting_input", "U1");
    vi.mocked(runTriage).mockResolvedValue({ action: "react", emoji: "pray" });
    await f.reaction("white_check_mark");
    expect(f.handler).toHaveBeenCalledTimes(1);
    expect(f.handler.mock.calls[0][0]).toMatchObject({ sessionKey: "slack:C1:1.000", thread: "1.000" });
    expect(f.reactions.mock.calls.at(-1)![0].name).toBe("eyes");
    expect(vi.mocked(runTriage).mock.calls.at(-1)![0].reactionAnswersPendingQuestion).toBe(true);
  });

  it.each([
    ["another user", "silent"], ["another user", "react"],
    ["an old bot message", "silent"], ["an old bot message", "react"],
    ["an unknown recipient", "silent"], ["an unknown recipient", "react"],
  ] as const)("does not force a %s reaction over the model's %s result", async (scenario, action) => {
    const f = await fixture();
    if (scenario === "an old bot message") f.postMessage.mockResolvedValue({ ts: "9.000" });
    await f.connector.replyMessage({ channel: "C1", thread: "1.000" }, "A案でよいですか？");
    f.connector.setConversationState(
      { channel: "C1", thread: "1.000" }, "awaiting_input",
      scenario === "an unknown recipient" ? undefined : "U1",
    );
    vi.mocked(runTriage).mockResolvedValue({ action, ...(action === "react" ? { emoji: "pray" } : {}) });
    await f.reaction("white_check_mark", scenario === "another user" ? { user: "U2" } : {});
    expect(vi.mocked(runTriage).mock.calls.at(-1)![0].reactionAnswersPendingQuestion).toBe(false);
    expect(f.handler).not.toHaveBeenCalled();
    expect(f.reactions.mock.calls.map((call) => call[0].name)).toEqual(action === "react" ? ["pray"] : []);
    expect(f.tracker.getContext({ channel: "C1", threadTs: "1.000", userId: "U1" }).status).toBe("awaiting_input");
  });

  it("stays invisible for another participant's reaction and ignores its own reactions", async () => {
    const f = await fixture();
    f.reactionMessage.mockResolvedValue({ message: { ts: "3.000", user: "UOTHERBOT", bot_id: "B2", text: "承認しますか？" } });
    vi.mocked(runTriage).mockResolvedValue({ action: "silent" });
    await f.reaction("thumbsup");
    expect(f.reactions).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
    const before = vi.mocked(runTriage).mock.calls.length;
    await f.reaction("pray", { user: "URYOKO" });
    expect(runTriage).toHaveBeenCalledTimes(before);
  });
});
