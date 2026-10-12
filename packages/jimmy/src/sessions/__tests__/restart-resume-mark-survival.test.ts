import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { getMessages, getSession, getSessionBySessionKey } from "../registry.js";
import { interruptRunningSessionsForShutdown, readRestartResumeState, restartResumeMessage, selectRestartResumeCandidates } from "../restart-resume.js";
import type { Connector, Engine, EngineRunOpts, IncomingMessage, JinnConfig } from "../../shared/types.js";

vi.mock("../context.js", () => ({ buildContext: () => "Test context" }));
vi.mock("../goal-execution.js", () => ({
  sessionGoalOptions: () => ({}),
  runWithSessionGoal: (engine: Engine, opts: EngineRunOpts) => engine.run(opts),
}));

afterEach(() => vi.restoreAllMocks());

// A graceful shutdown marks a running session "interrupted" and then kills its
// engine. The killed turn's own completion handler still runs in the dying
// process and — on the connector path — writes status "idle" over that. So the
// status cannot carry "a restart cut this turn off" to the next boot; the mark
// in transportMeta has to, and the completion's meta merge must keep it.
describe("restart interruption mark — survives the killed turn's completion", () => {
  it("is still on the session after the connector runner settles the turn it was stamped in", async () => {
    const config = {
      engines: { default: "codex", codex: { bin: "codex" } },
      connectors: { slack: {} }, sessions: {}, logging: { level: "error", stdout: false },
    } as unknown as JinnConfig;
    const sessionKey = "slack:restart-mark-survival";
    const shutdownAt = Date.parse("2026-10-12T03:00:00.000Z");
    const interruptedAt = new Date(shutdownAt).toISOString();
    let statusAtShutdown: string | undefined;

    // The engine turn during which the gateway shuts down.
    const run = vi.fn<Engine["run"]>(async (opts) => {
      // server.ts cleanup: mark every running session, then kill the engines.
      interruptRunningSessionsForShutdown(shutdownAt);
      statusAtShutdown = getSession(opts.sessionId!)?.status;
      return { sessionId: "native-1", result: "", error: "Interrupted: gateway shutting down" };
    });
    const manager = new SessionManager(config, new Map<string, Engine>([["codex", { name: "codex", run } as Engine]]));
    const replyMessage = vi.fn(async () => undefined);
    const connector = {
      name: "slack", replyMessage, sendMessage: replyMessage,
      addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, messageEdits: false, reactions: true, attachments: false }),
      reconstructTarget: () => ({ channel: "C-mark", thread: "1.1" }),
    } as unknown as Connector;
    const msg = {
      connector: "slack", source: "slack", sessionKey, channel: "C-mark", thread: "1.1",
      messageId: "1.2", user: "Test", userId: "U-test", text: "デプロイして", attachments: [], raw: {},
      replyContext: { channel: "C-mark", thread: "1.1" },
      transportMeta: { channelExternal: false, channelName: "ops" },
    } as IncomingMessage;

    await manager.route(msg, connector);

    const settled = getSessionBySessionKey(sessionKey)!;
    expect(run).toHaveBeenCalledTimes(1);
    expect(statusAtShutdown).toBe("interrupted");
    // The completion handler overwrote the shutdown status…
    expect(settled.status).toBe("idle");
    expect(settled.lastError).toBeNull();
    // …but not the mark, and the adapter's own keys were merged in beside it.
    expect(readRestartResumeState(settled.transportMeta).interruptedAt).toBe(interruptedAt);
    expect(settled.transportMeta).toMatchObject({ channelExternal: false, channelName: "ops" });
    // An interrupted turn is not delivered: the thread got no reply, which is what the boot nudge is for.
    expect(replyMessage).not.toHaveBeenCalled();
  });

  // The other half of the same handler: a connector turn stays "running" after
  // its engine has finished, until the reply has been delivered. A shutdown
  // that lands in that window used to stamp the mark as well — the reply went
  // out, the handler wrote idle, the mark stayed, and the next boot nudged a
  // conversation that had nothing left to do. The nudge turn's output is
  // posted into the original thread, so that was an unprompted message.
  it("is not stamped on a turn that has already answered, when the shutdown lands during delivery", async () => {
    const config = {
      engines: { default: "codex", codex: { bin: "codex" } },
      connectors: { slack: {} }, sessions: {}, logging: { level: "error", stdout: false },
    } as unknown as JinnConfig;
    const sessionKey = "slack:restart-mark-answered";
    const run = vi.fn<Engine["run"]>(async () => ({ sessionId: "native-2", result: "デプロイが完了しました。" }));
    const manager = new SessionManager(config, new Map<string, Engine>([["codex", { name: "codex", run } as Engine]]));
    let statusAtShutdown: string | undefined;
    // The engine is done and the reply is on its way out when the gateway shuts down.
    const replyMessage = vi.fn(async () => {
      interruptRunningSessionsForShutdown();
      statusAtShutdown = getSessionBySessionKey(sessionKey)?.status;
      return undefined;
    });
    const connector = {
      name: "slack", replyMessage, sendMessage: replyMessage,
      addReaction: vi.fn(async () => {}), removeReaction: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, messageEdits: false, reactions: true, attachments: false }),
      reconstructTarget: () => ({ channel: "C-mark", thread: "2.1" }),
    } as unknown as Connector;
    const msg = {
      connector: "slack", source: "slack", sessionKey, channel: "C-mark", thread: "2.1",
      messageId: "2.2", user: "Test", userId: "U-test", text: "デプロイして", attachments: [], raw: {},
      replyContext: { channel: "C-mark", thread: "2.1" },
      transportMeta: { channelExternal: false },
    } as IncomingMessage;

    await manager.route(msg, connector);

    const settled = getSessionBySessionKey(sessionKey)!;
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(replyMessage.mock.calls[0]).toEqual([expect.anything(), "デプロイが完了しました。"]);
    expect(statusAtShutdown).toBe("interrupted"); // the shutdown did see it as running
    expect(settled.status).toBe("idle");
    // Nothing is left to resume, so nothing is left for the next boot to find.
    expect(readRestartResumeState(settled.transportMeta).interruptedAt).toBeUndefined();
    const { candidates } = selectRestartResumeCandidates({ now: Date.now(), maxAgeMs: 120 * 60_000 });
    expect(candidates.map((session) => session.id)).not.toContain(settled.id);
  });

  // A message that waits behind the running turn makes the dying process do one
  // more thing after the kill: it starts that next turn, whose first act is to
  // record the user's message — and only after up to three Slack calls does the
  // session become "running" again. Exit in between, and the transcript holds a
  // user message newer than the mark with nothing behind it. That is not "the
  // conversation moved on": neither the turn that was cut off nor the message
  // that was waiting has been handled.
  it("is still honoured when the dying process had begun the next queued message", async () => {
    const config = {
      engines: { default: "codex", codex: { bin: "codex" } },
      connectors: { slack: {} }, sessions: {}, logging: { level: "error", stdout: false },
    } as unknown as JinnConfig;
    const sessionKey = "slack:restart-mark-queued-behind";
    let killEngine!: (result: { sessionId: string; result: string; error: string }) => void;
    const run = vi.fn<Engine["run"]>(() => new Promise((resolve) => { killEngine = resolve; }));
    const manager = new SessionManager(config, new Map<string, Engine>([["codex", { name: "codex", run } as Engine]]));
    let exiting = false;
    const replyMessage = vi.fn(async () => undefined);
    const connector = {
      name: "slack", replyMessage, sendMessage: replyMessage,
      addReaction: vi.fn(async () => {}),
      // The second turn's opening Slack call is where the process exits: it never returns.
      removeReaction: vi.fn(async (_target: unknown, emoji: string) => { if (exiting && emoji === "clock1") await new Promise(() => {}); }),
      getCapabilities: () => ({ threading: true, messageEdits: false, reactions: true, attachments: false }),
      reconstructTarget: () => ({ channel: "C-mark", thread: "3.1" }),
    } as unknown as Connector;
    const message = (text: string, messageId: string) => ({
      connector: "slack", source: "slack", sessionKey, channel: "C-mark", thread: "3.1",
      messageId, user: "Test", userId: "U-test", text, attachments: [], raw: {},
      replyContext: { channel: "C-mark", thread: "3.1" },
      transportMeta: { channelExternal: false },
    }) as IncomingMessage;

    const first = manager.route(message("本番にデプロイして", "3.2"), connector);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    void manager.route(message("ついでにログも見ておいて", "3.3"), connector); // waits behind the running turn
    await vi.waitFor(() => expect(manager.getQueue().getPendingCount(sessionKey)).toBe(1));

    // Graceful shutdown: mark, kill the engine, and the process is gone moments later.
    interruptRunningSessionsForShutdown();
    exiting = true;
    killEngine({ sessionId: "native-3", result: "", error: "Interrupted: gateway shutting down" });
    await first;
    const sessionId = getSessionBySessionKey(sessionKey)!.id;
    await vi.waitFor(() => expect(getMessages(sessionId).filter((m) => m.role === "user")).toHaveLength(2));

    // What the next boot finds: one engine run, no reply, an idle session, the mark, and a newer user message.
    const left = getSession(sessionId)!;
    expect(run).toHaveBeenCalledTimes(1);
    expect(replyMessage).not.toHaveBeenCalled();
    expect(left.status).toBe("idle");
    const interruptedAt = readRestartResumeState(left.transportMeta).interruptedAt!;
    expect(interruptedAt).toEqual(expect.any(String));

    const { candidates, skipped } = selectRestartResumeCandidates({ now: Date.now(), maxAgeMs: 120 * 60_000 });

    expect(skipped.filter((entry) => entry.sessionId === sessionId)).toEqual([]);
    expect(candidates.map((session) => session.id)).toContain(sessionId);
    expect(readRestartResumeState(getSession(sessionId)!.transportMeta).interruptedAt).toBe(interruptedAt);
  });
});
