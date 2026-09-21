import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { reviewGoal } from "../goal-review.js";
import { extractGoalCondition } from "../../connectors/slack/goal-extractor.js";
import type { Connector, Engine, IncomingMessage, JinnConfig } from "../../shared/types.js";

vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn() }));
vi.mock("../../connectors/slack/goal-extractor.js", async (original) => ({ ...await original<object>(), extractGoalCondition: vi.fn() }));
vi.mock("../context.js", () => ({ buildContext: () => "Test context" }));

beforeEach(() => vi.resetAllMocks());
let nextKey = 0;
function setup() {
  const config = {
    engines: { default: "codex", codex: { bin: "codex" } },
    connectors: { slack: {} }, logging: { level: "error", stdout: false }, sessions: {},
  } as unknown as JinnConfig;
  const run = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "codex-task", result: "承認を待っています。", numTurns: 1 });
  const manager = new SessionManager(config, new Map([["codex", { name: "codex", run }]]));
  const setConversationState = vi.fn();
  const replyMessage = vi.fn(async () => undefined);
  const connector = { name: "slack", replyMessage, sendMessage: replyMessage, setConversationState,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, messageEdits: false, reactions: true, attachments: false }),
    reconstructTarget: () => ({ channel: "C-outcome", thread: "root-outcome" }),
  } as unknown as Connector;
  const msg = { connector: "slack", source: "slack", sessionKey: `slack:conversation-outcome-${++nextKey}`,
    channel: "C-outcome", thread: "root-outcome", user: "Owner", userId: "U-outcome", text: "変更を反映してください",
    attachments: [], raw: {}, replyContext: { channel: "C-outcome", thread: "root-outcome" },
    transportMeta: { conversationType: "channel", channelExternal: false },
  } as IncomingMessage;
  vi.mocked(extractGoalCondition).mockResolvedValue("変更を反映済み");
  return { manager, run, connector, msg, setConversationState, replyMessage };
}

describe("SessionManager conversation state delivery", () => {
  it.each(["waiting", "blocked", "complete", "cancelled"] as const)("publishes fresh structured %s after successful reply", async (status) => {
    const { manager, connector, msg, setConversationState, replyMessage } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status, reason: "Structured assessment",
      waitingFor: status === "waiting" || status === "blocked" ? "user" : undefined });
    replyMessage.mockImplementation(async () => {
      expect(setConversationState).not.toHaveBeenCalled();
      return undefined;
    });
    await manager.route(msg, connector);
    expect(setConversationState).toHaveBeenCalledExactlyOnceWith(
      { channel: "C-outcome", thread: "root-outcome" },
      status === "waiting" || status === "blocked" ? "awaiting_input" : "completed", "U-outcome",
    );
  });

  it.each([undefined, "background", "external", "unknown"] as const)("does not create an input wait for %s dependencies", async (waitingFor) => {
    const { manager, connector, msg, setConversationState } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status: "waiting", reason: "Not awaiting user input", waitingFor });
    await manager.route(msg, connector);
    expect(setConversationState).not.toHaveBeenCalled();
  });

  it("does not reuse a completed goal for a later untracked question", async () => {
    const { manager, connector, msg, setConversationState, run } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status: "complete", reason: "Done" });
    await manager.route(msg, connector);
    expect(setConversationState).toHaveBeenCalledTimes(1);
    setConversationState.mockClear();
    vi.mocked(extractGoalCondition).mockResolvedValue(null);
    run.mockResolvedValue({ sessionId: "codex-task", result: "別の質問への回答です。" });
    await manager.route({ ...msg, text: "今日は何曜日？" }, connector);
    expect(setConversationState).not.toHaveBeenCalled();
  });

  it("does not publish state after failed text delivery", async () => {
    const { manager, connector, msg, setConversationState, replyMessage } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status: "waiting", reason: "Need input", waitingFor: "user" });
    replyMessage.mockRejectedValueOnce(new Error("Slack unavailable"));
    await manager.route(msg, connector);
    expect(setConversationState).not.toHaveBeenCalled();
  });

  it.each(["Interrupted: stopped", "engine failure"])("does not publish outcome after %s", async (error) => {
    const { manager, connector, msg, setConversationState, run } = setup();
    run.mockResolvedValue({ sessionId: "codex-task", result: "", error, retryable: false });
    await manager.route(msg, connector);
    expect(setConversationState).not.toHaveBeenCalled();
  });

  it("does not turn a reaction-only response into a pending-input conversation", async () => {
    const { manager, connector, msg, setConversationState, run } = setup();
    vi.mocked(reviewGoal).mockResolvedValue({ status: "waiting", reason: "Need input", waitingFor: "user" });
    const payload = Buffer.from(JSON.stringify({ suppressPublic: true, react: "thumbsup" })).toString("base64url");
    run.mockResolvedValue({ sessionId: "codex-task", result: `<!--RYOKO-DISPOSITION:v1:${payload}-->` });
    await manager.route(msg, connector);
    expect(setConversationState).not.toHaveBeenCalled();
  });
});
