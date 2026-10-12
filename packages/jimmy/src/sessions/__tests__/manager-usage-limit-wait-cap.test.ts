import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { failLimitThatOutlastsTheWait } from "../engine-fallback.js";
import { _resetUsageLimitAnnouncements, setEngineInstallProbe } from "../engine-health-gate.js";
import { _resetEngineLoginKnowledge } from "../engine-login.js";
import { getSessionBySessionKey } from "../registry.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import { MAX_USAGE_LIMIT_WAIT_MS } from "../../shared/rateLimit.js";
import type { Connector, Engine, EngineResult, IncomingMessage, JinnConfig } from "../../shared/types.js";

vi.mock("../context.js", () => ({ buildContext: () => "context" }));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "verified" })) }));

/**
 * A turn that hits a usage limit with nowhere to switch to is parked until the
 * limit resets. That was bounded while the interactive engine could not say
 * when the reset was: six hours, then the turn failed. Once it could, the turn
 * was parked until the stated reset however far away — five days for a weekly
 * window. Every cron firing is a new session, so on an install without a usable
 * fallback days of firings piled up in `waiting` and all ran at the reset.
 */

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const HOUR = 60 * 60_000;
const limitedUntil = (msFromNow: number | undefined): EngineResult => ({ sessionId: "claude-thread", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1,
  rateLimit: { status: "rejected", rateLimitType: "interactive_detected",
    ...(msFromNow === undefined ? {} : { resetsAt: Math.floor((Date.now() + msFromNow) / 1000), window: msFromNow > 5 * HOUR ? "7d" : "5h" }) } });

let sequence = 0;
function setup(sessions: JinnConfig["sessions"] = { rateLimitStrategy: "wait" }) {
  const config = { engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-model", interactive: true },
    codex: { bin: "codex-bin", model: "codex-model" } }, sessions, connectors: { slack: { goalExtraction: { enabled: false } } },
    logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  const claudeRun = vi.fn<Engine["run"]>();
  const codexRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "codex-thread", result: "Answered by codex." });
  const manager = new SessionManager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }]]));
  const replyMessage = vi.fn(async (_target: unknown, _text: string) => undefined);
  const connector = { name: "slack", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
    reconstructTarget: () => ({ channel: "C-wait", thread: "thread" }),
  } as unknown as Connector;
  const message = (source = "slack"): IncomingMessage => ({
    connector: "slack", source, sessionKey: `${source}:wait-${++sequence}`, channel: "C-wait", thread: "thread",
    text: "週次レポートを作成してください", user: "Test", userId: "U-test", messageId: "message", attachments: [],
    replyContext: { channel: "C-wait", thread: "thread" }, raw: {}, transportMeta: { channelExternal: false },
  } as IncomingMessage);
  const replies = () => replyMessage.mock.calls.map(([, text]) => text);
  return { manager, connector, message, replies, claudeRun, codexRun };
}

/** Route a message whose turn is expected to park, observe it parked, then call the wait off. */
async function parked(f: ReturnType<typeof setup>, msg: IncomingMessage) {
  const pending = f.manager.route(msg, f.connector);
  await vi.waitFor(() => expect(getSessionBySessionKey(msg.sessionKey)?.status).toBe("waiting"));
  f.manager.getQueue().clearQueue(msg.sessionKey);
  await vi.advanceTimersByTimeAsync(500);
  await pending;
}

beforeEach(() => {
  invalidateModelRegistry();
  _resetUsageLimitAnnouncements();
  _resetEngineLoginKnowledge();
  fs.rmSync(HEALTH_PATH, { force: true });
});
afterEach(() => {
  setEngineInstallProbe(undefined);
  vi.useRealTimers();
});

describe("a usage limit with nowhere to switch to", () => {
  it.each(["slack", "cron"])("fails a %s turn at once, saying when the limit resets, when that is days away", async (source) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup();
    const resetsAt = new Date(Date.now() + 5 * 24 * HOUR);
    f.claudeRun.mockResolvedValue(limitedUntil(5 * 24 * HOUR));
    const msg = f.message(source);

    await f.manager.route(msg, f.connector); // returns: nothing is left parked

    const session = getSessionBySessionKey(msg.sessionKey)!;
    expect(session.status).toBe("error");
    expect(session.lastError).toContain("claude usage limit reached");
    expect(session.lastError).toContain(new Date(Math.floor(resetsAt.getTime() / 1000) * 1000).toISOString());
    expect(f.replies()).toEqual([session.lastError]);
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
  });

  it("does the same when a fallback is configured but cannot be used", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = setup({});
    setEngineInstallProbe((bin) => bin !== "codex-bin"); // Codex is not installed
    f.claudeRun.mockResolvedValue(limitedUntil(5 * 24 * HOUR));
    const msg = f.message();

    await f.manager.route(msg, f.connector);

    expect(getSessionBySessionKey(msg.sessionKey)).toMatchObject({ status: "error", engine: "claude" });
    expect(f.codexRun).not.toHaveBeenCalled();
  });

  it("still waits for a reset that is hours away, as before", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.claudeRun.mockResolvedValue(limitedUntil(2 * HOUR));

    await parked(f, f.message());

    expect(f.replies()).toEqual([expect.stringMatching(/^⏳ claude usage limit reached\. Resets .+ — I'll continue automatically\.$/)]);
  });

  it("still waits when the engine could not say when the limit resets, as before", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.claudeRun.mockResolvedValue(limitedUntil(undefined));

    await parked(f, f.message());

    expect(f.replies()).toEqual(["⏳ claude usage limit reached — I'll continue automatically."]);
  });

  // The 5h window reopens, the parked turn is tried again, and the engine now
  // names the weekly window: a reset no longer worth waiting for either.
  it("stops waiting when the retry after the reset is told the next reset is days away", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.claudeRun.mockImplementationOnce(async () => limitedUntil(2 * HOUR)).mockImplementationOnce(async () => limitedUntil(5 * 24 * HOUR));
    const msg = f.message();
    const pending = f.manager.route(msg, f.connector);
    try {
      await vi.waitFor(() => expect(getSessionBySessionKey(msg.sessionKey)?.status).toBe("waiting"));

      await vi.advanceTimersByTimeAsync(2 * HOUR + 60_000);

      expect(f.claudeRun).toHaveBeenCalledTimes(2);
      expect(getSessionBySessionKey(msg.sessionKey)).toMatchObject({ status: "error", lastError: "claude usage limit did not clear in time" });
      expect(f.replies().at(-1)).toBe("Usage limit didn't reset in time. Please try again later.");
    } finally {
      f.manager.getQueue().clearQueue(msg.sessionKey);
      await vi.advanceTimersByTimeAsync(600);
      await pending;
    }
  });
});

describe("failLimitThatOutlastsTheWait", () => {
  const claude: Engine = { name: "claude", run: vi.fn() };
  const NOW = Date.parse("2026-10-12T03:00:00.000Z");
  const limitedAt = (msFromNow: number): EngineResult => ({ sessionId: "s", result: "", error: "Interactive turn failed: rate_limit",
    rateLimit: { status: "rejected", resetsAt: Math.floor((NOW + msFromNow) / 1000) } });

  it("leaves a limit alone when its reset is within the longest wait", () => {
    const result = limitedAt(MAX_USAGE_LIMIT_WAIT_MS);
    expect(failLimitThatOutlastsTheWait({ result, engine: claude, attempted: false }, NOW)).toBe(result);
  });

  it("fails one that resets later than that, and says when", () => {
    const failed = failLimitThatOutlastsTheWait({ result: limitedAt(MAX_USAGE_LIMIT_WAIT_MS + 60_000), engine: claude, attempted: false }, NOW);
    expect(failed.retryable).toBe(false);
    expect(failed.error).toContain(new Date(NOW + MAX_USAGE_LIMIT_WAIT_MS + 60_000).toISOString());
  });

  it("leaves alone a result that is not a parked limit: a fallback already ran, or the reset is unknown, or it is no limit", () => {
    const far = limitedAt(5 * 24 * HOUR);
    const unknown: EngineResult = { sessionId: "s", result: "", error: "Usage limit reached" };
    const answered: EngineResult = { sessionId: "s", result: "Done." };
    expect(failLimitThatOutlastsTheWait({ result: far, engine: claude, attempted: true }, NOW)).toBe(far);
    expect(failLimitThatOutlastsTheWait({ result: unknown, engine: claude, attempted: false }, NOW)).toBe(unknown);
    expect(failLimitThatOutlastsTheWait({ result: answered, engine: claude, attempted: false }, NOW)).toBe(answered);
  });
});
