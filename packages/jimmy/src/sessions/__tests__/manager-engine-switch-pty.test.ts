import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { getMessages, getSession, getSessionBySessionKey } from "../registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Connector, Engine, EngineResult, IncomingMessage, InterruptibleEngine, JinnConfig } from "../../shared/types.js";

vi.mock("../context.js", () => ({ buildContext: () => "context" }));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "verified" })) }));

/**
 * When a session is moved to its fallback engine, the engine it left can still
 * hold a live process for it: the interactive Claude PTY stays warm for minutes
 * after a turn. A Stop hook that process sends later has no turn to settle, so
 * it used to be delivered as a late completion — a second answer, from the
 * engine the conversation had just left, after the fallback engine had replied.
 * The switch now stops that process, and a hook that was already on its way is
 * ignored for as long as the session is on another engine.
 */

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const SWITCH_NOTICE = "⚠️ claude usage limit reached. Switching to codex.";
const inMinutes = (minutes: number) => Math.floor(Date.now() / 1000) + minutes * 60;
const limited = (resetsAt: number): EngineResult => ({ sessionId: "claude-thread", result: "", error: "Interactive turn failed: rate_limit",
  numTurns: 1, rateLimit: { status: "rejected", rateLimitType: "interactive_detected", resetsAt, window: "5h" } });

let sequence = 0;
function setup() {
  const config = { engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-model", interactive: true },
    codex: { bin: "codex-bin", model: "codex-model" } }, sessions: {}, connectors: { slack: { goalExtraction: { enabled: false } } },
    logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  /** What happened, in order: which process was stopped, and when the fallback engine ran. */
  const events: string[] = [];
  const kill = vi.fn((sessionId: string, reason?: string) => { events.push(`kill ${sessionId} (${reason})`); });
  const claudeRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "claude-thread", result: "Answered by claude." });
  const claude: InterruptibleEngine & { isTurnRunning: (id: string) => boolean } = {
    name: "claude", run: claudeRun, kill, killAll: vi.fn(), isAlive: () => true, isTurnRunning: () => false,
  };
  const codexRun = vi.fn<Engine["run"]>(async () => {
    events.push("codex runs");
    return { sessionId: "codex-thread", result: "Answered by codex." };
  });
  const manager = new SessionManager(config, new Map<string, Engine>([["claude", claude], ["codex", { name: "codex", run: codexRun }]]));
  const replyMessage = vi.fn(async (_target: unknown, _text: string) => undefined);
  const connector = { name: "slack", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
    reconstructTarget: (context: Record<string, unknown>) => ({ channel: String(context.channel), thread: String(context.thread) }),
  } as unknown as Connector;
  manager.setConnectorProvider(() => new Map([["slack", connector]]));
  const message = (text = "今日の予定を教えてください"): IncomingMessage => ({
    connector: "slack", source: "slack", sessionKey: `slack:switch-${++sequence}`, channel: "C-switch", thread: "thread",
    text, user: "Test", userId: "U-test", messageId: "message", attachments: [],
    replyContext: { channel: "C-switch", thread: "thread" }, raw: {}, transportMeta: { channelExternal: false },
  } as IncomingMessage);
  const route = async (msg: IncomingMessage) => {
    await manager.route(msg, connector);
    return getSessionBySessionKey(msg.sessionKey)!;
  };
  const replies = () => replyMessage.mock.calls.map(([, text]) => text);
  const answers = (sessionId: string) => getMessages(sessionId).filter((entry) => entry.role === "assistant").map((entry) => entry.content);
  return { manager, message, route, replies, answers, events, kill, claudeRun, codexRun };
}

beforeEach(() => {
  invalidateModelRegistry();
  fs.rmSync(HEALTH_PATH, { force: true });
});
afterEach(() => vi.useRealTimers());

describe("the engine a session leaves when it switches on a usage limit", () => {
  it("has that session's process stopped before the fallback engine runs, and no other session's", async () => {
    const f = setup();
    const bystander = await f.route(f.message("別件です")); // a second conversation, served by Claude
    f.claudeRun.mockResolvedValueOnce(limited(inMinutes(60)));

    const switched = await f.route(f.message());

    expect(switched.engine).toBe("codex");
    expect(f.events).toEqual([`kill ${switched.id} (Interrupted: engine switched)`, "codex runs"]);
    expect(f.kill).not.toHaveBeenCalledWith(bystander.id, expect.anything());
  });

  it("cannot answer a second time: a Stop it sends after the switch is not delivered", async () => {
    const f = setup();
    f.claudeRun.mockResolvedValueOnce(limited(inMinutes(60)));
    const switched = await f.route(f.message());

    await f.manager.handleOrphanHook(switched.id, { hook_event_name: "Stop", last_assistant_message: "Late answer from the limited engine." });

    expect(f.replies()).toEqual([SWITCH_NOTICE, "Answered by codex."]);
    expect(f.answers(switched.id)).toEqual(["Answered by codex."]);
  });

  it("does not have a late failure of its own recorded against the session either", async () => {
    const f = setup();
    f.claudeRun.mockResolvedValueOnce(limited(inMinutes(60)));
    const switched = await f.route(f.message());

    await f.manager.handleOrphanHook(switched.id, { hook_event_name: "StopFailure", error: "rate_limit" });

    expect(getSession(switched.id)).toMatchObject({ engine: "codex", status: "idle", lastError: null });
  });
});

describe("late completions that are still the session's own", () => {
  it("are delivered as before for a session that never switched", async () => {
    const f = setup();
    const session = await f.route(f.message());

    await f.manager.handleOrphanHook(session.id, { hook_event_name: "Stop", last_assistant_message: "Background task finished." });

    expect(f.kill).not.toHaveBeenCalled();
    expect(f.replies()).toEqual(["Answered by claude.", "Background task finished."]);
    expect(f.answers(session.id)).toEqual(["Answered by claude.", "Background task finished."]);
  });

  it("are delivered again once the limit has cleared and the session is back on its own engine, with its conversation intact", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    const reopensAt = inMinutes(60);
    f.claudeRun.mockResolvedValueOnce(limited(reopensAt));
    const msg = f.message();
    await f.route(msg);

    vi.setSystemTime(reopensAt * 1000 + 2000);
    const back = await f.route({ ...msg, text: "続きをお願いします" });

    // Claude picks its own conversation up where the limit cut it off, and is
    // told what the fallback engine did in the meantime.
    expect(back.engine).toBe("claude");
    expect(f.claudeRun).toHaveBeenCalledTimes(2);
    expect(f.claudeRun.mock.calls[1][0].resumeSessionId).toBe("claude-thread");
    expect(f.claudeRun.mock.calls[1][0].prompt).toContain("Answered by codex.");
    expect(f.claudeRun.mock.calls[1][0].prompt).toContain("続きをお願いします");

    await f.manager.handleOrphanHook(back.id, { hook_event_name: "Stop", last_assistant_message: "Background task finished." });
    expect(f.replies().at(-1)).toBe("Background task finished.");
  });
});

describe("a conversation that only borrowed Claude for a while", () => {
  // Codex is this conversation's own engine. It returned nothing once, so the
  // turn went to Claude for five minutes — and Claude's PTY is not stopped when
  // the conversation goes back, so work it started in the background still
  // finishes and still has to reach the conversation.
  it("still receives what Claude finishes in the background after it has gone back to Codex", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    const codexRun = vi.fn<Engine["run"]>()
      .mockResolvedValueOnce({ sessionId: "codex-thread", result: "" })
      .mockResolvedValue({ sessionId: "codex-thread", result: "Answered by codex." });
    const claudeRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "claude-thread", result: "バックグラウンドで進めて、終わったら報告します。" });
    const config = { engines: { default: "codex", claude: { bin: "claude-bin", model: "claude-model", interactive: true },
      codex: { bin: "codex-bin", model: "codex-model" } }, sessions: {}, connectors: { slack: { goalExtraction: { enabled: false } } },
      logging: { level: "error", stdout: false } } as unknown as JinnConfig;
    const manager = new SessionManager(config, new Map<string, Engine>([
      ["codex", { name: "codex", run: codexRun }],
      ["claude", { name: "claude", run: claudeRun, kill: f.kill, killAll: vi.fn(), isAlive: () => true, isTurnRunning: () => false } as InterruptibleEngine],
    ]));
    const replyMessage = vi.fn(async (_target: unknown, _text: string) => undefined);
    const connector = { name: "slack", replyMessage, sendMessage: replyMessage,
      addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
      reconstructTarget: (context: Record<string, unknown>) => ({ channel: String(context.channel), thread: String(context.thread) }),
    } as unknown as Connector;
    manager.setConnectorProvider(() => new Map([["slack", connector]]));
    const msg = f.message("レポートを作ってください");

    await manager.route(msg, connector);
    expect(getSessionBySessionKey(msg.sessionKey)!.engine).toBe("claude"); // borrowed, for five minutes

    vi.setSystemTime(Date.now() + 6 * 60_000);
    await manager.route({ ...msg, text: "進み具合はどうですか" }, connector);
    const back = getSessionBySessionKey(msg.sessionKey)!;
    expect(back.engine).toBe("codex");

    await manager.handleOrphanHook(back.id, { hook_event_name: "Stop", last_assistant_message: "レポートが完成しました。" });

    expect(replyMessage).toHaveBeenLastCalledWith(expect.anything(), "レポートが完成しました。");
    expect(getMessages(back.id).filter((entry) => entry.role === "assistant").map((entry) => entry.content)).toContain("レポートが完成しました。");
  });
});
