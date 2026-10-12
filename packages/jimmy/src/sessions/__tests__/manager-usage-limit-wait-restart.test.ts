import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { notifyDiscordChannel, notifyParentSession } from "../callbacks.js";
import { _resetUsageLimitAnnouncements } from "../engine-health-gate.js";
import { _resetEngineLoginKnowledge } from "../engine-login.js";
import { getSession, getSessionBySessionKey, initDb, recoverStaleSessions } from "../registry.js";
import {
  RESTART_LIMIT_RESET_BUFFER_MS,
  beginGatewayShutdown,
  interruptRunningSessionsForShutdown,
  prepareRestartResume,
  readRestartResumeState,
  restartResumeMessage,
  resumeRestartInterruptedSessions,
  type RestartResumeDeps,
} from "../restart-resume.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Connector, Engine, EngineResult, IncomingMessage, JinnConfig } from "../../shared/types.js";

// A turn that meets a usage limit with no engine to switch to is parked: the
// thread is told "I'll continue automatically", and the runner waits — in a
// loop inside the gateway process — for the reset before trying again.
//
// A restart ended that loop and nothing took its place. The connector path has
// no queue row to replay, so the session said "waiting" for good, nothing ever
// continued, and the next message was told the session was "still paused".

vi.mock("../context.js", () => ({ buildContext: () => "context" }));
vi.mock("../callbacks.js", async (original) => ({
  ...await original<typeof import("../callbacks.js")>(),
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));
vi.mock("../goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "verified" })) }));

// The wait itself, held open until a test lets it go — the way the process
// holds it until the limit resets, or until the process is gone.
const wait = vi.hoisted(() => ({ held: [] as Array<(carryOn: boolean) => void> }));
vi.mock("../engine-fallback.js", async (original) => ({
  ...await original<typeof import("../engine-fallback.js")>(),
  waitForEngineRetry: vi.fn(() => new Promise<boolean>((resolve) => { wait.held.push(resolve); })),
}));

const HEALTH_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const HOUR = 60 * 60_000;
const CONFIG = {
  engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-model", interactive: true }, codex: { bin: "codex-bin", model: "codex-model" } },
  sessions: { rateLimitStrategy: "wait" }, connectors: { slack: { goalExtraction: { enabled: false } } },
  logging: { level: "error", stdout: false },
} as unknown as JinnConfig;

/** The engine's answer to a turn it refuses for a usage limit that resets `msFromNow` from now. */
function limitedFor(msFromNow: number): { result: EngineResult; resetsAt: string } {
  const seconds = Math.floor((Date.now() + msFromNow) / 1000);
  return {
    result: { sessionId: "claude-thread", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1,
      rateLimit: { status: "rejected", rateLimitType: "interactive_detected", resetsAt: seconds, window: "5h" } },
    resetsAt: new Date(seconds * 1000).toISOString(),
  };
}

let sequence = 0;
function setup() {
  const claudeRun = vi.fn<Engine["run"]>();
  const manager = new SessionManager(CONFIG, new Map<string, Engine>([
    ["claude", { name: "claude", run: claudeRun }],
    ["codex", { name: "codex", run: vi.fn<Engine["run"]>() }],
  ]));
  const replyMessage = vi.fn(async (_target: unknown, _text: string) => undefined);
  const connector = {
    name: "slack", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}), setTypingStatus: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, reactions: true, attachments: false, messageEdits: false }),
    reconstructTarget: () => ({ channel: "C-wait", thread: "thread" }),
  } as unknown as Connector;
  const msg = {
    connector: "slack", source: "slack", sessionKey: `slack:wait-restart-${++sequence}`, channel: "C-wait", thread: "thread",
    text: "週次レポートを作成してください", user: "Test", userId: "U-test", messageId: "message", attachments: [],
    replyContext: { channel: "C-wait", thread: "thread" }, raw: {}, transportMeta: { channelExternal: false },
  } as IncomingMessage;
  const replies = () => replyMessage.mock.calls.map(([, text]) => text);
  return { manager, connector, msg, replies, claudeRun };
}

/** Route a message whose turn parks on the usage limit, and return once it is parked. */
async function park(f: ReturnType<typeof setup>, msFromNow: number) {
  const limited = limitedFor(msFromNow);
  f.claudeRun.mockResolvedValueOnce(limited.result);
  const turn = f.manager.route(f.msg, f.connector);
  await vi.waitFor(() => expect(getSessionBySessionKey(f.msg.sessionKey)?.status).toBe("waiting"));
  await vi.waitFor(() => expect(wait.held).toHaveLength(1));
  return { turn, sessionId: getSessionBySessionKey(f.msg.sessionKey)!.id, resetsAt: limited.resetsAt };
}

/** The process is gone, and the wait with it: nothing comes back from it. */
async function processGone(turn: Promise<unknown>) {
  for (const settle of wait.held.splice(0)) settle(false);
  await turn;
}

/** The next start's resume step, with what it would post and when captured instead. */
function nextStart() {
  const timers: Array<{ run: () => Promise<void>; delayMs: number }> = [];
  const post = vi.fn<NonNullable<RestartResumeDeps["post"]>>(async () => {});
  const summary = resumeRestartInterruptedSessions({ config: CONFIG, port: 0, post, schedule: (run, delayMs) => { timers.push({ run, delayMs }); } });
  return { summary, timers, post };
}

beforeEach(() => {
  vi.clearAllMocks();
  wait.held.length = 0;
  invalidateModelRegistry();
  _resetUsageLimitAnnouncements();
  _resetEngineLoginKnowledge();
  fs.rmSync(HEALTH_PATH, { force: true });
  const db = initDb();
  db.prepare("DELETE FROM queue_items").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM sessions").run();
});
afterEach(() => {
  prepareRestartResume(); // a boot: whatever "shutting down" a test set is over
});

describe("a connector turn parked on a usage limit, across a restart", () => {
  it("is marked at shutdown with the reset the thread was told, and resumed once that reset has passed", async () => {
    const f = setup();
    const parked = await park(f, HOUR);
    expect(f.replies().at(-1)).toContain("I'll continue automatically");

    interruptRunningSessionsForShutdown();

    // The reset comes from the runner's own note of what it is waiting for.
    expect(readRestartResumeState(getSession(parked.sessionId)!.transportMeta)).toMatchObject({
      interruptedAt: expect.any(String), limitWait: { resetsAt: parked.resetsAt },
    });
    expect(getSession(parked.sessionId)?.status).toBe("interrupted");
    await processGone(parked.turn);
    expect(getSession(parked.sessionId)?.status).toBe("interrupted"); // the dying wait changed nothing

    prepareRestartResume();
    recoverStaleSessions();
    const next = nextStart();

    // Not woken while the limit is on — it would only be refused again — but a moment after it resets.
    expect(next.summary).toMatchObject({ planned: 1, heldForLimit: 1, skipped: 0 });
    const untilReset = Date.parse(parked.resetsAt) - Date.now();
    expect(next.timers).toHaveLength(1);
    expect(next.timers[0].delayMs).toBeGreaterThan(untilReset);
    expect(next.timers[0].delayMs).toBeLessThanOrEqual(untilReset + RESTART_LIMIT_RESET_BUFFER_MS + 1_000);
    expect(next.post).not.toHaveBeenCalled();
    const held = getSession(parked.sessionId)!;
    const interruptedAt = readRestartResumeState(held.transportMeta).interruptedAt!; // kept until the nudge is accepted

    await next.timers[0].run();

    expect(next.post).toHaveBeenCalledTimes(1);
    const [, sessionId, body] = next.post.mock.calls[0];
    expect(sessionId).toBe(parked.sessionId);
    expect(body.message).toBe(restartResumeMessage(held, interruptedAt, { limitWait: true }));
    expect(body.message).toContain("waiting for a usage limit");
    // Nothing more was said in the thread meanwhile: no failure, no second notice.
    expect(f.replies().filter((text) => !text.includes("I'll continue automatically"))).toEqual([]);
  });

  it("is no longer shown as waiting after a crash: the next message is answered, not told the session is still paused", async () => {
    const f = setup();
    const parked = await park(f, HOUR);

    // The process dies with no shutdown at all. The next one starts:
    await processGone(parked.turn);
    expect(getSession(parked.sessionId)?.status).toBe("waiting"); // what the dead process left behind
    expect(prepareRestartResume().marked).toBe(1);
    expect(recoverStaleSessions()).toBe(1);

    expect(getSession(parked.sessionId)?.status).toBe("interrupted");
    expect(readRestartResumeState(getSession(parked.sessionId)!.transportMeta).limitWait).toEqual({ resetsAt: parked.resetsAt });

    // The user does not wait for the reset, and writes again. By now the limit happens to be off.
    fs.rmSync(HEALTH_PATH, { force: true });
    f.claudeRun.mockResolvedValueOnce({ sessionId: "claude-thread", result: "レポートを作成しました。", numTurns: 1 });
    await f.manager.route({ ...f.msg, text: "どうなりましたか", messageId: "message-2" }, f.connector);

    expect(f.replies().some((text) => text.includes("Still paused"))).toBe(false);
    expect(f.replies().at(-1)).toBe("レポートを作成しました。");
    expect(getSession(parked.sessionId)).toMatchObject({ status: "idle", lastError: null });
  });
});

// When the wait is over the runner tries the turn again. A shutdown that lands
// during that retry stops the engine — and the runner took the engine's
// "Interrupted: gateway shutting down" for the turn's answer: it posted it into
// the thread, set the session to "error", and told the parent the child had failed.
describe("the retry after the wait, stopped by the gateway shutting down", () => {
  it.each([
    ["the gateway stopped the engine itself", { sessionId: "claude-thread", result: "", error: "Interrupted: gateway shutting down", interruptRequested: true as const }],
    // A supervisor that signals the whole control group: Claude's process is gone before the gateway's own kill.
    ["the engine's process was gone before the gateway's own stop", { sessionId: "claude-thread", result: "", error: "Interrupted: claude process exited" }],
  ])("is not posted as the answer, and the session is resumed after the restart: %s", async (_case, stopped) => {
    const f = setup();
    const parked = await park(f, HOUR);
    f.claudeRun.mockImplementationOnce(async () => {
      beginGatewayShutdown();
      interruptRunningSessionsForShutdown(); // server.ts cleanup: mark, then stop the engines
      return stopped;
    });

    for (const carryOn of wait.held.splice(0)) carryOn(true); // the limit has reset: try again
    await parked.turn;

    expect(f.claudeRun).toHaveBeenCalledTimes(2);
    expect(f.replies().filter((text) => text.includes("Interrupted"))).toEqual([]);
    const session = getSession(parked.sessionId)!;
    expect(session.status).toBe("interrupted"); // not "error": nothing failed
    expect(notifyParentSession).not.toHaveBeenCalled();
    expect(vi.mocked(notifyDiscordChannel).mock.calls.map(([text]) => text).filter((text) => /cleared|did not clear/.test(text))).toEqual([]);
    expect(readRestartResumeState(session.transportMeta).interruptedAt).toEqual(expect.any(String));

    prepareRestartResume();
    recoverStaleSessions();
    const next = nextStart();

    expect(next.summary).toMatchObject({ planned: 1, skipped: 0 });
    await next.timers[0].run();
    expect(next.post).toHaveBeenCalledTimes(1);
    expect(next.post.mock.calls[0][1]).toBe(parked.sessionId);
  });
});
