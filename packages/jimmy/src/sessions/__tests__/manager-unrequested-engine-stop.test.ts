import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connector, Engine, EngineResult, EngineRunOpts, IncomingMessage, JinnConfig } from "../../shared/types.js";

vi.mock("../context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context.js")>()),
  buildContext: () => "Test context",
}));
vi.mock("../goal-execution.js", () => ({
  sessionGoalOptions: () => ({}),
  runWithSessionGoal: (engine: Engine, opts: EngineRunOpts) => engine.run(opts),
}));
vi.mock("../callbacks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../callbacks.js")>()),
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(), notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));

import { notifyParentSession } from "../callbacks.js";
import { SessionManager } from "../manager.js";
import { createSession, getMessages, getSessionBySessionKey } from "../registry.js";
import { interruptRunningSessionsForShutdown, prepareRestartResume, readRestartResumeState, selectRestartResumeCandidates } from "../restart-resume.js";

// When Claude's process dies in the middle of a turn, the interactive engine
// reports "Interrupted: claude process exited". The connector runner used to
// settle that exactly like a turn a newer message had interrupted: no reply,
// status idle, lastError null. In Slack the thread simply never got an answer.
const PROCESS_DIED: EngineResult = { sessionId: "native-1", result: "", error: "Interrupted: claude process exited" };
const FAILURE = "claude stopped unexpectedly: claude process exited";
let sequence = 0;

function setup(result: EngineResult | (() => EngineResult)) {
  const config = {
    engines: { default: "claude", claude: { bin: "claude", fallback: [] }, codex: { bin: "codex", fallback: [] } },
    connectors: { slack: {} }, sessions: {}, logging: { level: "error", stdout: false },
  } as unknown as JinnConfig;
  const run = vi.fn<Engine["run"]>(async () => (typeof result === "function" ? result() : result));
  const manager = new SessionManager(config, new Map<string, Engine>([["claude", { name: "claude", run } as Engine]]));
  const replyMessage = vi.fn(async () => undefined);
  const connector = {
    name: "slack", replyMessage, sendMessage: replyMessage,
    addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}),
    getCapabilities: () => ({ threading: true, messageEdits: false, reactions: true, attachments: false }),
    reconstructTarget: () => ({ channel: "C-stop", thread: "1.1" }),
  } as unknown as Connector;
  const sessionKey = `slack:unrequested-stop-${++sequence}`;
  const msg = {
    connector: "slack", source: "slack", sessionKey, channel: "C-stop", thread: "1.1",
    messageId: "1.2", user: "Test", userId: "U-test", text: "本番にデプロイして", attachments: [], raw: {},
    replyContext: { channel: "C-stop", thread: "1.1" },
    transportMeta: { channelExternal: false },
  } as IncomingMessage;
  return { manager, connector, msg, run, replyMessage, sessionKey };
}

afterEach(() => {
  vi.mocked(notifyParentSession).mockClear();
  prepareRestartResume(); // a boot: whatever "shutting down" a test set is over
});

describe("a Slack turn whose engine process died", () => {
  it("is answered with the error and settled as a failure", async () => {
    const f = setup(PROCESS_DIED);

    await f.manager.route(f.msg, f.connector);

    const session = getSessionBySessionKey(f.sessionKey)!;
    expect(f.replyMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: "C-stop", thread: "1.1" }), FAILURE);
    expect(session.status).toBe("error");
    expect(session.lastError).toBe(FAILURE);
    expect(getMessages(session.id).at(-1)).toMatchObject({ role: "assistant", content: FAILURE });
    // Not run a second time on a fresh engine session: the dead turn may already have changed things.
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(session.engineSessionId).toBe("native-1");
  });

  it("is reported to the parent session as a failure, not as a reply with no output", async () => {
    const f = setup(PROCESS_DIED);
    const parent = createSession({ engine: "claude", source: "web", sourceRef: `web:parent-${sequence}` });
    createSession({
      engine: "claude", source: "slack", sourceRef: f.sessionKey, connector: "slack", sessionKey: f.sessionKey,
      replyContext: { channel: "C-stop", thread: "1.1" }, parentSessionId: parent.id, employee: "worker",
    });

    await f.manager.route(f.msg, f.connector);

    expect(notifyParentSession).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ parentSessionId: parent.id, status: "error", lastError: FAILURE }),
      expect.objectContaining({ error: FAILURE }),
      expect.anything(),
    );
  });
});

describe("a turn the gateway itself stopped", () => {
  it.each([
    "Interrupted: new message received",
    "Interrupted by user",
    "Interrupted: engine switched",
  ])("still ends quietly — no reply, no error: %s", async (error) => {
    const f = setup({ sessionId: "native-1", result: "", error, interruptRequested: true });

    await f.manager.route(f.msg, f.connector);

    const session = getSessionBySessionKey(f.sessionKey)!;
    expect(f.replyMessage).not.toHaveBeenCalled();
    expect(session.status).toBe("idle");
    expect(session.lastError).toBeNull();
    expect(notifyParentSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ error: null }), expect.anything());
  });

  it("is not a failure when the shutdown killed it — it is left for the restart nudge", async () => {
    const f = setup(() => {
      interruptRunningSessionsForShutdown(); // server.ts cleanup marks, then kills
      return { sessionId: "native-1", result: "", error: "Interrupted: gateway shutting down", interruptRequested: true };
    });

    await f.manager.route(f.msg, f.connector);

    const session = getSessionBySessionKey(f.sessionKey)!;
    expect(f.replyMessage).not.toHaveBeenCalled();
    expect(session.status).toBe("idle");
    expect(session.lastError).toBeNull();
    expect(readRestartResumeState(session.transportMeta).interruptedAt).toEqual(expect.any(String));
  });

  it("is not a failure when the shutdown reached the engine's process before the gateway's own kill did", async () => {
    // A supervisor that signals the whole control group: Claude's process is
    // gone before the gateway's cleanup has marked or killed anything.
    const f = setup(PROCESS_DIED);
    const { beginGatewayShutdown } = await import("../restart-resume.js");
    beginGatewayShutdown();

    await f.manager.route(f.msg, f.connector);

    const session = getSessionBySessionKey(f.sessionKey)!;
    expect(f.replyMessage).not.toHaveBeenCalled();
    expect(session.status).toBe("idle");
    expect(session.lastError).toBeNull();
    // Already idle by the time the shutdown would mark running sessions — marked here instead.
    expect(readRestartResumeState(session.transportMeta).interruptedAt).toEqual(expect.any(String));
  });

  it("is still resumed after the restart when the shutdown's own marking lands while that turn is winding down", async () => {
    // Same supervisor, a moment later: the turn has been settled as interrupted
    // and its runner is clearing the "eyes" reaction when the shutdown gets to
    // marking the sessions that are running. The interruption text that runner
    // just recorded is not a reply — the session must come out as cut off.
    const f = setup(PROCESS_DIED);
    const { beginGatewayShutdown } = await import("../restart-resume.js");
    beginGatewayShutdown();
    vi.mocked(f.connector.removeReaction).mockImplementation(async (_target, emoji) => {
      if (emoji === "eyes") interruptRunningSessionsForShutdown();
    });

    await f.manager.route(f.msg, f.connector);

    const session = getSessionBySessionKey(f.sessionKey)!;
    expect(session.status).toBe("idle");
    expect(readRestartResumeState(session.transportMeta)).toMatchObject({ interruptedAt: expect.any(String) });
    expect(readRestartResumeState(session.transportMeta).replyRecorded).toBeUndefined();
    const { candidates } = selectRestartResumeCandidates({ now: Date.now(), maxAgeMs: 120 * 60_000 });
    expect(candidates.map((candidate) => candidate.id)).toContain(session.id);
  });
});
