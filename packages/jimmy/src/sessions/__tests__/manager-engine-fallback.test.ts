import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { createSession, getMessages, getSessionBySessionKey, updateSession } from "../registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import type { Connector, Engine, EngineResult, IncomingMessage, JinnConfig } from "../../shared/types.js";

vi.mock("../context.js", () => ({ buildContext: (options: { processLifetime: string }) => `context: ${options.processLifetime}` }));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "verified" })) }));

let sequence = 0;
function setup(from: "claude" | "codex" = "codex") {
  const to = from === "claude" ? "codex" : "claude";
  const config = { engines: { default: from, claude: { bin: "claude-bin", model: "claude-model", interactive: true },
    codex: { bin: "codex-bin", model: "codex-model" } }, sessions: {}, connectors: { slack: { goalExtraction: { enabled: false } } },
    logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  const sourceRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: `${from}-source`, result: "", error: "Usage limit reached" });
  const targetRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: `${to}-target`, result: "代替エンジンで完了しました。", cost: 0.2 });
  const manager = new SessionManager(config, new Map([[from, { name: from, run: sourceRun }], [to, { name: to, run: targetRun }]]));
  const replyMessage = vi.fn(async () => undefined);
  const connector = { name: "slack", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
    reconstructTarget: () => ({ channel: "C-fallback", thread: "thread" }),
  } as unknown as Connector;
  const msg = { connector: "slack", source: "slack", sessionKey: `slack:fallback-${++sequence}`, channel: "C-fallback", thread: "thread",
    text: "草稿を確認してください", user: "Test", userId: "U-test", messageId: "message", attachments: [],
    replyContext: { channel: "C-fallback", thread: "thread" }, raw: {}, transportMeta: { channelExternal: false },
  } as IncomingMessage;
  return { config, manager, connector, msg, from, to, sourceRun, targetRun, replyMessage };
}

beforeEach(() => { invalidateModelRegistry(); });
afterEach(() => vi.useRealTimers());

describe("SessionManager actual fallback routing", () => {
  it.each([
    ["claude", "rate"], ["codex", "rate"], ["claude", "empty"], ["codex", "empty"],
    ["claude", "timeout"], ["codex", "timeout"],
  ] as const)("routes %s %s failure to the other engine and cleans processing state", async (from, failure) => {
    const f = setup(from);
    const result: EngineResult = { sessionId: `${from}-source`, result: "", cost: 0.1 };
    if (failure === "rate") result.error = "Usage limit reached"; // no provider-specific metadata
    if (failure === "timeout") result.error = "Engine response timeout";
    f.sourceRun.mockResolvedValue(result);
    await f.manager.route(f.msg, f.connector);
    expect(f.sourceRun).toHaveBeenCalledTimes(1);
    expect(f.targetRun).toHaveBeenCalledTimes(1);
    expect(f.targetRun.mock.calls[0][0]).toMatchObject({ model: `${f.to}-model`, bin: `${f.to}-bin`, systemPrompt: `context: ${f.to === "claude" ? "persistent" : "one-shot"}` });
    const stored = getSessionBySessionKey(f.msg.sessionKey)!;
    expect(stored.engine).toBe(f.to);
    expect(stored.status).toBe("idle");
    expect(stored.totalCost).toBeCloseTo(0.3);
    expect(f.replyMessage).toHaveBeenLastCalledWith(expect.anything(), "代替エンジンで完了しました。");
    expect(f.connector.removeReaction).toHaveBeenCalledWith(expect.anything(), "eyes");
    expect(f.connector.setTypingStatus).toHaveBeenLastCalledWith("C-fallback", "thread", "");
    expect(getMessages(stored.id).filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("finishes with a visible error when both engines are limited instead of waiting or bouncing", async () => {
    const f = setup();
    f.targetRun.mockResolvedValue({ sessionId: "target", result: "", error: "Rate limited" });
    await f.manager.route(f.msg, f.connector);
    expect(f.sourceRun).toHaveBeenCalledTimes(1);
    expect(f.targetRun).toHaveBeenCalledTimes(1);
    expect(getSessionBySessionKey(f.msg.sessionKey)?.status).toBe("error");
    expect(f.replyMessage).toHaveBeenLastCalledWith(expect.anything(), "Rate limited");
  });

  it("hands an existing Codex goal to native Claude after a failure", async () => {
    const f = setup("codex");
    const session = createSession({ engine: "codex", source: "slack", sourceRef: f.msg.sessionKey, sessionKey: f.msg.sessionKey });
    updateSession(session.id, { goal: { id: "goal", condition: "草稿を確認済みにする", request: f.msg.text, status: "active", updatedAt: new Date().toISOString() } });
    await f.manager.route(f.msg, f.connector);
    expect(f.targetRun.mock.calls[0][0].prompt).toContain("/goal 草稿を確認済みにする");
  });

  it("keeps proactive contributions eligible for intentional silence without invoking a fallback", async () => {
    const f = setup();
    const payload = Buffer.from(JSON.stringify({ suppressPublic: true })).toString("base64url");
    f.sourceRun.mockResolvedValue({ sessionId: "source", result: `<!--RYOKO-DISPOSITION:v1:${payload}-->` });
    f.msg.transportMeta = { ...f.msg.transportMeta, proactiveContribution: true };
    await f.manager.route(f.msg, f.connector);
    expect(f.targetRun).not.toHaveBeenCalled();
    expect(f.replyMessage).not.toHaveBeenCalled();
  });

  it("does not interpret a successful native command's deliberate empty output as a failure", async () => {
    const f = setup("claude");
    f.msg.text = "/compact";
    f.sourceRun.mockResolvedValue({ sessionId: "native", result: "", responseExpected: false });
    await f.manager.route(f.msg, f.connector);
    expect(f.targetRun).not.toHaveBeenCalled();
    expect(f.replyMessage).not.toHaveBeenCalled();
    expect(getSessionBySessionKey(f.msg.sessionKey)?.status).toBe("idle");
  });

  it("leaves a tracked goal untouched during a single unsolicited suggestion", async () => {
    const f = setup("claude");
    const session = createSession({ engine: "claude", source: "slack", sourceRef: f.msg.sessionKey, sessionKey: f.msg.sessionKey });
    const goal = { id: "goal", condition: "Existing task", request: "Do existing task", status: "waiting" as const, updatedAt: new Date().toISOString() };
    updateSession(session.id, { goal });
    f.msg.transportMeta = { proactiveContribution: true };
    f.sourceRun.mockResolvedValue({ sessionId: "source", result: "必要なら資料を整えられます。" });
    await f.manager.route(f.msg, f.connector);
    expect(f.sourceRun).toHaveBeenCalledTimes(1);
    expect(f.sourceRun.mock.calls[0][0].prompt).not.toContain("/goal");
    expect(getSessionBySessionKey(f.msg.sessionKey)!.goal).toEqual(goal);
    expect(f.targetRun).not.toHaveBeenCalled();
  });

  it("does not switch or deliver after the queue is cancelled during the source run", async () => {
    const f = setup();
    f.sourceRun.mockImplementation(async () => {
      f.manager.getQueue().clearQueue(f.msg.sessionKey);
      return { sessionId: "source", result: "", error: "Usage limit reached" };
    });
    await f.manager.route(f.msg, f.connector);
    expect(f.targetRun).not.toHaveBeenCalled();
    expect(f.replyMessage).not.toHaveBeenCalled();
  });

  it("cancels a distant quota-reset wait promptly and removes the waiting indicator", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.config.sessions!.rateLimitStrategy = "wait";
    f.sourceRun.mockResolvedValue({ sessionId: "source", result: "", error: "Rate limited",
      rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    const pending = f.manager.route(f.msg, f.connector);
    await vi.waitFor(() => expect(getSessionBySessionKey(f.msg.sessionKey)?.status).toBe("waiting"));
    f.manager.getQueue().clearQueue(f.msg.sessionKey);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(f.sourceRun).toHaveBeenCalledTimes(1);
    expect(f.targetRun).not.toHaveBeenCalled();
    expect(f.connector.removeReaction).toHaveBeenCalledWith(expect.anything(), "hourglass_flowing_sand");
    expect(getSessionBySessionKey(f.msg.sessionKey)?.status).toBe("idle");
  });
});
