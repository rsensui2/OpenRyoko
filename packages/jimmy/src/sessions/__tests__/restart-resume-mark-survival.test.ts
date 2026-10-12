import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../manager.js";
import { getSession, getSessionBySessionKey } from "../registry.js";
import { interruptRunningSessionsForShutdown, readRestartResumeState } from "../restart-resume.js";
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
});
