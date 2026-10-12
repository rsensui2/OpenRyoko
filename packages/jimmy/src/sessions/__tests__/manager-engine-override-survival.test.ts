import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { createSession, getSession, getSessionBySessionKey, updateSession } from "../registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import type { Connector, Engine, EngineResult, IncomingMessage, JinnConfig } from "../../shared/types.js";

vi.mock("../context.js", () => ({ buildContext: () => "context" }));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "verified" })) }));

/**
 * A session that was moved to its fallback engine carries `engineOverride`:
 * the engine, model and effort to go back to, and when. Two cleanup paths used
 * to drop it along with the ids they meant to clear, and the session then
 * stayed on the fallback engine for good.
 */

let sequence = 0;

/** A Claude conversation currently held on Codex until `until`. */
function overriddenSession(until: string) {
  const config = { engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-model", interactive: true },
    // No further fallback from Codex, so a Codex limit has nowhere to go but the wait.
    codex: { bin: "codex-bin", model: "codex-model", fallback: [] } },
    sessions: {}, connectors: { slack: { goalExtraction: { enabled: false } } },
    logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  const claudeRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "claude-thread", result: "Answered by claude." });
  const codexRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "codex-thread", result: "Answered by codex." });
  const manager = new SessionManager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }]]));
  const connector = { name: "slack", replyMessage: vi.fn(async () => undefined), sendMessage: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
    reconstructTarget: () => ({ channel: "C-override", thread: "thread" }),
  } as unknown as Connector;
  const sessionKey = `slack:override-${++sequence}`;
  const session = createSession({ engine: "codex", source: "slack", sourceRef: sessionKey, sessionKey, model: "codex-model" });
  updateSession(session.id, { engineSessionId: "codex-thread", transportMeta: { engineOverride: {
    originalEngine: "claude", originalEngineSessionId: "claude-original", originalModel: null, originalEffortLevel: null,
    until, syncSince: new Date().toISOString() } } });
  const message = (text: string): IncomingMessage => ({
    connector: "slack", source: "slack", sessionKey, channel: "C-override", thread: "thread", text,
    user: "Test", userId: "U-test", messageId: "message", attachments: [],
    replyContext: { channel: "C-override", thread: "thread" }, raw: {}, transportMeta: { channelExternal: false },
  } as IncomingMessage);
  return { manager, connector, message, sessionKey, sessionId: session.id, claudeRun, codexRun };
}

const override = (sessionId: string) => (getSession(sessionId)!.transportMeta as { engineOverride?: Record<string, unknown> } | null)?.engineOverride;
const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();

beforeEach(() => invalidateModelRegistry());
afterEach(() => vi.useRealTimers());

describe("a session held on its fallback engine keeps its way back", () => {
  it("through a turn that waited out the fallback engine's own limit", async () => {
    vi.useFakeTimers();
    const until = inAnHour();
    const f = overriddenSession(until);
    f.codexRun.mockResolvedValueOnce({ sessionId: "codex-thread", result: "", error: "Usage limit reached" });

    const pending = f.manager.route(f.message("進捗を教えてください"), f.connector);
    await vi.waitFor(() => expect(getSessionBySessionKey(f.sessionKey)?.status).toBe("waiting"));
    await vi.advanceTimersByTimeAsync(61_000);
    await pending;

    expect(getSession(f.sessionId)).toMatchObject({ engine: "codex", status: "idle" });
    expect(f.codexRun).toHaveBeenCalledTimes(2);
    expect(override(f.sessionId)).toMatchObject({ originalEngine: "claude", until });

    vi.setSystemTime(Date.parse(until) + 1000);
    await f.manager.route(f.message("続きをお願いします"), f.connector);
    expect(getSession(f.sessionId)!.engine).toBe("claude");
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
  });

  it.each<[string, EngineResult]>([
    ["a stale engine session is cleared", { sessionId: "", result: "", error: "codex exited with code 1" }],
    ["an unresumable transcript is cleared", { sessionId: "codex-thread", result: "", cost: 0.4, numTurns: 3,
      error: "messages.1.content.13: thinking or redacted_thinking blocks in the latest assistant message cannot be modified." }],
  ])("when %s", async (_label, failure) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const until = inAnHour();
    const f = overriddenSession(until);
    f.codexRun.mockResolvedValueOnce(failure);

    await f.manager.route(f.message("進捗を教えてください"), f.connector);

    expect(getSession(f.sessionId)!.engine).toBe("codex");
    expect(override(f.sessionId)).toMatchObject({ originalEngine: "claude", originalEngineSessionId: "claude-original", until });

    vi.setSystemTime(Date.parse(until) + 1000);
    await f.manager.route(f.message("続きをお願いします"), f.connector);
    expect(getSession(f.sessionId)!.engine).toBe("claude");
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.claudeRun.mock.calls[0][0].resumeSessionId).toBe("claude-original");
  });
});
