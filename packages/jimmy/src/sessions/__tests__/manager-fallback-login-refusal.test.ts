import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { _resetUsageLimitAnnouncements } from "../engine-health-gate.js";
import { _resetEngineLoginKnowledge, hasServedATurn } from "../engine-login.js";
import { getSession, getSessionBySessionKey } from "../registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Connector, Engine, EngineResult, IncomingMessage, JinnConfig } from "../../shared/types.js";

vi.mock("../context.js", () => ({ buildContext: () => "context" }));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "verified" })) }));

/**
 * The install this is about has Codex on PATH but never signed in — common
 * where only Claude is used. When Claude ran into its usage limit there, the
 * session was switched to Codex, got a login prompt for an answer, and stayed
 * pinned to Codex, failing every message, until the override ran out.
 */

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const SWITCH_NOTICE = "⚠️ claude usage limit reached. Switching to codex.";
const WAITING_NOTICE = /^⏳ claude usage limit reached\. Resets .+ — I'll continue automatically\.$/;
const NOT_SIGNED_IN: EngineResult = { sessionId: "", result: "", error: "Codex exited with code 1: Not logged in" };
const inMinutes = (minutes: number) => Math.floor(Date.now() / 1000) + minutes * 60;
const limited = (resetsAt: number): EngineResult => ({ sessionId: "claude-thread", result: "", error: "Interactive turn failed: rate_limit",
  numTurns: 1, rateLimit: { status: "rejected", rateLimitType: "interactive_detected", resetsAt, window: "5h" } });

let sequence = 0;
function setup() {
  const config = { engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-model", interactive: true },
    codex: { bin: "codex-bin", model: "codex-model" } }, sessions: {}, connectors: { slack: { goalExtraction: { enabled: false } } },
    logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  const claudeRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "claude-thread", result: "Answered by claude." });
  const codexRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "codex-thread", result: "Answered by codex." });
  const manager = new SessionManager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }]]));
  const replyMessage = vi.fn(async (_target: unknown, _text: string) => undefined);
  const connector = { name: "slack", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
    reconstructTarget: () => ({ channel: "C-login", thread: "thread" }),
  } as unknown as Connector;
  const message = (text = "今日の予定を教えてください"): IncomingMessage => ({
    connector: "slack", source: "slack", sessionKey: `slack:login-${++sequence}`, channel: "C-login", thread: "thread",
    text, user: "Test", userId: "U-test", messageId: "message", attachments: [],
    replyContext: { channel: "C-login", thread: "thread" }, raw: {}, transportMeta: { channelExternal: false },
  } as IncomingMessage);
  const route = async (msg: IncomingMessage) => {
    await manager.route(msg, connector);
    return getSessionBySessionKey(msg.sessionKey)!;
  };
  /** Route a message whose turn ends up waiting for Claude's limit, then call the wait off. */
  const routeUntilWaiting = async (msg: IncomingMessage) => {
    const pending = manager.route(msg, connector);
    await vi.waitFor(() => expect(getSessionBySessionKey(msg.sessionKey)?.status).toBe("waiting"));
    const waiting = getSessionBySessionKey(msg.sessionKey)!;
    manager.getQueue().clearQueue(msg.sessionKey);
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    return waiting;
  };
  const replies = () => replyMessage.mock.calls.map(([, text]) => text);
  return { manager, message, route, routeUntilWaiting, replies, claudeRun, codexRun };
}

const override = (sessionId: string) => (getSession(sessionId)!.transportMeta as { engineOverride?: Record<string, unknown> } | null)?.engineOverride;

beforeEach(() => {
  invalidateModelRegistry();
  _resetUsageLimitAnnouncements();
  _resetEngineLoginKnowledge();
  fs.rmSync(HEALTH_PATH, { force: true });
});
afterEach(() => vi.useRealTimers());

describe("Claude runs into its limit where Codex is installed but not signed in", () => {
  it("does not leave the session on Codex: the switch is taken back and the turn waits for Claude", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.claudeRun.mockResolvedValue(limited(inMinutes(60)));
    f.codexRun.mockResolvedValue(NOT_SIGNED_IN);

    const session = await f.routeUntilWaiting(f.message());

    expect(session.engine).toBe("claude");
    expect(session.model).toBeNull();
    expect(override(session.id)).toBeUndefined();
    expect(session.lastError).toMatch(/^claude usage limit — resumes /);
    expect(f.codexRun).toHaveBeenCalledTimes(2); // asked twice before it was believed
    expect(f.replies()).toEqual([SWITCH_NOTICE, expect.stringMatching(WAITING_NOTICE)]);
  });

  it("does not send the next conversations to Codex either, for the half hour that follows", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.claudeRun.mockResolvedValue(limited(inMinutes(60)));
    f.codexRun.mockResolvedValue(NOT_SIGNED_IN);
    await f.routeUntilWaiting(f.message());

    // Claude is known to be out now — but a new session is not started on an
    // engine that has never answered, and the switch is not tried again yet.
    const next = await f.routeUntilWaiting(f.message());

    expect(next.engine).toBe("claude");
    expect(f.codexRun).toHaveBeenCalledTimes(2);
    expect(f.replies().filter((text) => text === SWITCH_NOTICE)).toHaveLength(1);
  });

  it("uses Codex again once it has been signed in", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.claudeRun.mockResolvedValue(limited(inMinutes(120)));
    f.codexRun.mockResolvedValue(NOT_SIGNED_IN);
    await f.routeUntilWaiting(f.message());

    vi.setSystemTime(Date.now() + 31 * 60_000);
    f.codexRun.mockResolvedValue({ sessionId: "codex-thread", result: "Answered by codex." });
    const switched = await f.route(f.message());

    expect(switched).toMatchObject({ engine: "codex", status: "idle" });
    expect(override(switched.id)).toMatchObject({ originalEngine: "claude" });
    expect(hasServedATurn("codex")).toBe(true);

    // And now that it has answered, new sessions are started on it outright.
    const calls = f.claudeRun.mock.calls.length;
    expect((await f.route(f.message())).engine).toBe("codex");
    expect(f.claudeRun).toHaveBeenCalledTimes(calls);
  });

  it("carries on with Codex when it only failed to sign in once", async () => {
    const f = setup();
    f.claudeRun.mockResolvedValue(limited(inMinutes(60)));
    f.codexRun.mockResolvedValueOnce(NOT_SIGNED_IN);

    const session = await f.route(f.message());

    expect(session).toMatchObject({ engine: "codex", status: "idle" });
    expect(f.replies()).toEqual([SWITCH_NOTICE, "Answered by codex."]);
  });
});

describe("a session held on Codex when Codex stops being able to sign in", () => {
  it("is sent back to Claude instead of failing every message until the hold runs out", async () => {
    const f = setup();
    f.claudeRun.mockResolvedValueOnce(limited(inMinutes(60)));
    const msg = f.message();
    const held = await f.route(msg); // switched to Codex, which answered
    expect(held.engine).toBe("codex");

    // Codex's login goes away. The session's own turn is refused — the first
    // attempt, and the fresh-session retry a zero-work failure always gets.
    f.codexRun.mockResolvedValue(NOT_SIGNED_IN);
    const refused = await f.route({ ...msg, text: "続きをお願いします" });

    expect(refused).toMatchObject({ engine: "claude", status: "error", engineSessionId: "claude-thread" });
    expect(override(refused.id)).toBeUndefined();
    expect(f.replies().at(-1)).toBe(NOT_SIGNED_IN.error);

    // The next message is Claude's again, with its own conversation and what
    // happened on Codex handed over — not another login prompt.
    const back = await f.route({ ...msg, text: "もう一度お願いします" });
    expect(back).toMatchObject({ engine: "claude", status: "idle" });
    expect(f.claudeRun).toHaveBeenCalledTimes(2);
    expect(f.claudeRun.mock.calls[1][0].resumeSessionId).toBe("claude-thread");
    expect(f.claudeRun.mock.calls[1][0].prompt).toContain("Answered by codex.");
    expect(f.replies().at(-1)).toBe("Answered by claude.");
  });
});
