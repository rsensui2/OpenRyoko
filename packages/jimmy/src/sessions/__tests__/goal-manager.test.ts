import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { getSession } from "../registry.js";
import { reviewGoal } from "../goal-review.js";
import { extractGoalCondition } from "../../connectors/slack/goal-extractor.js";
import type { Connector, Engine, IncomingMessage, JinnConfig } from "../../shared/types.js";

vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn() }));
vi.mock("../../connectors/slack/goal-extractor.js", async (original) => ({ ...await original<object>(), extractGoalCondition: vi.fn() }));
vi.mock("../context.js", () => ({ buildContext: () => "Test context" }));

beforeEach(() => vi.resetAllMocks());

describe("Slack task completion through SessionManager", () => {
  it("tracks a natural request, resumes the thread, and posts only the completed answer", async () => {
    const config = {
      engines: { default: "codex", codex: { bin: "codex", model: "configured-model" } },
      connectors: { slack: {} }, logging: { level: "error", stdout: false }, sessions: {},
    } as unknown as JinnConfig;
    const run = vi.fn<Engine["run"]>()
      .mockResolvedValueOnce({ sessionId: "codex-81", result: "招待を反映します", numTurns: 1 })
      .mockResolvedValueOnce({ sessionId: "codex-81", result: "招待と読み返し確認が完了しました。", numTurns: 1 });
    const manager = new SessionManager(config, new Map([["codex", { name: "codex", run }]]));
    const replyMessage = vi.fn(async () => undefined);
    const connector = { name: "slack", replyMessage, sendMessage: replyMessage,
      getCapabilities: () => ({ threading: true, messageEdits: false, reactions: false, attachments: false }),
      reconstructTarget: () => ({ channel: "C81", thread: "1.81" }),
    } as unknown as Connector;
    const msg = { connector: "slack", source: "slack", sessionKey: "slack:goal-81", channel: "C81", thread: "1.81",
      user: "Owner", userId: "U81", text: "合意した正式日程で招待を反映して、確認まで終えてください", attachments: [], raw: {},
      replyContext: { channel: "C81", thread: "1.81" }, transportMeta: { conversationType: "im", channelExternal: false },
    } as IncomingMessage;
    vi.mocked(extractGoalCondition).mockResolvedValue("正式日程と参加者を確認済み");
    vi.mocked(reviewGoal).mockResolvedValueOnce({ status: "continue", reason: "まだ未実行" })
      .mockResolvedValueOnce({ status: "complete", reason: "更新と確認済み" });
    const routed = await manager.route(msg, connector);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].resumeSessionId).toBe("codex-81");
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(replyMessage.mock.calls[0]).toContain("招待と読み返し確認が完了しました。");
    expect(extractGoalCondition).toHaveBeenCalledWith(msg.text, expect.objectContaining({ model: "configured-model", enabled: true }));
    expect(getSession(routed!.sessionId)?.goal?.status).toBe("complete");
    expect(getSession(routed!.sessionId)?.engineSessionId).toBe("codex-81");
  });
});
