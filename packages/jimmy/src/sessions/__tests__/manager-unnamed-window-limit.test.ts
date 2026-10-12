import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type RouteOptions } from "../manager.js";
import { _resetUsageLimitAnnouncements } from "../engine-health-gate.js";
import { _resetEngineLoginKnowledge, noteLoginWorked } from "../engine-login.js";
import { getSession, getSessionBySessionKey } from "../registry.js";
import { claudeUsageProbe, startEngineHealthMonitor, type EngineHealthMonitor } from "../../gateway/engine-health-monitor.js";
import type { ClaudeUsageResponse } from "../../shared/claude-usage.js";
import { readEngineHealth } from "../../shared/engine-health.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Connector, Engine, EngineResult, IncomingMessage, JinnConfig } from "../../shared/types.js";

vi.mock("../context.js", () => ({ buildContext: () => "context" }));
vi.mock("../callbacks.js", () => ({ notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn() }));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "verified" })) }));

/**
 * `claude -p` reports a usage limit with the reset but without saying which
 * window ran out. When that window is one scoped to a model — Opus's weekly
 * allowance, with the shared windows wide open — the record it left could be
 * neither confirmed nor refuted by a usage reading, and was cleared on one
 * anyway: the shared windows were all the re-check looked at. A conversation
 * that had been switched on that record was then sent back to Claude on its
 * next message, failed again, and was switched again — every message.
 */

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = new Date("2026-10-12T03:00:00.000Z");
const OPUS_RESETS = Math.floor((START.getTime() + 3 * 24 * HOUR) / 1000);

/** What the headless engine returns for it: a declared rejection, a reset, no window. */
const opusWeeklyLimit = (): EngineResult => ({ sessionId: "claude-headless", result: "", error: "You've hit your limit · resets Oct 15, 3am",
  cost: 0, numTurns: 1, rateLimit: { status: "rejected", resetsAt: OPUS_RESETS, rateLimitType: "seven_day_opus" } });

/** What the account's usage shows meanwhile: only the Opus window is spent. */
const usage = (): ClaudeUsageResponse => ({ available: true, source: "claude-oauth-usage", refreshedAt: new Date().toISOString(), windows: [
  { name: "5h", usedPercent: 20, resetsAt: Math.floor((START.getTime() + 2 * HOUR) / 1000) },
  { name: "7d", usedPercent: 40, resetsAt: OPUS_RESETS },
  { name: "7d Opus", usedPercent: 100, resetsAt: OPUS_RESETS },
] });

let sequence = 0;
let monitor: EngineHealthMonitor | undefined;

function setup() {
  const config = { engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-opus-5" },
    codex: { bin: "codex-bin", model: "codex-model" } }, sessions: {}, connectors: { slack: { goalExtraction: { enabled: false } } },
    logging: { level: "error", stdout: false } } as unknown as JinnConfig;
  const claudeRun = vi.fn<Engine["run"]>(async () => opusWeeklyLimit());
  const codexRun = vi.fn<Engine["run"]>().mockResolvedValue({ sessionId: "codex-thread", result: "Answered by codex." });
  const manager = new SessionManager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }]]));
  const replyMessage = vi.fn(async (_target: unknown, _text: string) => undefined);
  const connector = { name: "slack", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
    reconstructTarget: () => ({ channel: "C-opus", thread: "thread" }),
  } as unknown as Connector;
  const sessionKey = `slack:opus-${++sequence}`;
  const message = (text: string, key = sessionKey): IncomingMessage => ({
    connector: "slack", source: "slack", sessionKey: key, channel: "C-opus", thread: "thread",
    text, user: "Test", userId: "U-test", messageId: "message", attachments: [],
    replyContext: { channel: "C-opus", thread: "thread" }, raw: {}, transportMeta: { channelExternal: false },
  } as IncomingMessage);
  const say = async (text: string, key = sessionKey, opts?: RouteOptions) => {
    await manager.route(message(text, key), connector, opts);
    return getSessionBySessionKey(key)!;
  };
  const switchNotices = () => replyMessage.mock.calls.map(([, text]) => text).filter((text) => /usage limit reached/.test(text));
  return { say, claudeRun, codexRun, switchNotices };
}

const override = (sessionId: string) => (getSession(sessionId)!.transportMeta as { engineOverride?: Record<string, unknown> } | null)?.engineOverride;

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  invalidateModelRegistry();
  _resetUsageLimitAnnouncements();
  _resetEngineLoginKnowledge();
  noteLoginWorked("claude");
  noteLoginWorked("codex");
  fs.rmSync(HEALTH_PATH, { force: true });
});
afterEach(() => {
  monitor?.stop();
  monitor = undefined;
  vi.useRealTimers();
});

describe("a conversation switched on a limit whose window the engine did not name", () => {
  it("stays on the fallback engine from message to message, instead of going back to fail on each one", async () => {
    monitor = startEngineHealthMonitor({ probes: { claude: claudeUsageProbe(async () => usage()) } });
    const f = setup();

    for (const text of ["Summarise the thread.", "And the open questions?", "Draft a reply.", "Shorter, please."]) {
      const session = await f.say(text);
      expect(session.engine).toBe("codex");
      await vi.advanceTimersByTimeAsync(5 * MINUTE); // the re-check has its say in between
    }

    expect(f.claudeRun).toHaveBeenCalledTimes(1); // the turn that found the limit, and no other
    expect(f.switchNotices()).toHaveLength(1);
    expect(f.codexRun).toHaveBeenCalledTimes(4);
    expect(readEngineHealth().claude).toMatchObject({ state: "exhausted", until: new Date(OPUS_RESETS * 1000).toISOString() });
  });

  // Without a window there is no telling which model the record is about, so a
  // turn served on another model clears it. The conversation that was switched
  // does not go back on the strength of that: it keeps the hold its own failed
  // turn was given.
  it("does not go back when the record is cleared by a turn it says nothing about", async () => {
    const f = setup();
    const switched = await f.say("Summarise the thread.");
    expect(switched.engine).toBe("codex");
    expect(override(switched.id)).toMatchObject({ originalEngine: "claude" });
    expect(override(switched.id)!.source).toBeUndefined();

    f.claudeRun.mockResolvedValueOnce({ sessionId: "claude-sonnet", result: "Answered on another model." });
    await f.say("A quick question.", `slack:opus-other-${++sequence}`, { engine: "claude", model: "claude-sonnet-5" });
    expect(readEngineHealth().claude).toBeUndefined();

    expect((await f.say("And the open questions?")).engine).toBe("codex");
    expect(f.claudeRun).toHaveBeenCalledTimes(2); // the limit, and the other session's turn

    // Its own hold is what ends it: twelve hours, for a reset days away.
    vi.setSystemTime(START.getTime() + 12 * HOUR + MINUTE);
    f.claudeRun.mockResolvedValueOnce({ sessionId: "claude-back", result: "Answered by claude." });
    expect((await f.say("Draft a reply.")).engine).toBe("claude");
  });
});
