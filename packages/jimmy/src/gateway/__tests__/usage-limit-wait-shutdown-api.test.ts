import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, JinnConfig } from "../../shared/types.js";
import type { ApiContext } from "../api.js";

vi.mock("../../sessions/callbacks.js", () => ({
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));
vi.mock("../../sessions/context.js", () => ({ buildContext: vi.fn(() => "context") }));
vi.mock("../../sessions/goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "Verified by test" })) }));

// The web runner has its own wait for a usage limit (see
// usage-limit-wait-cap-api.test.ts). When that wait is over it tries the turn
// again, and a shutdown landing during the retry stops the engine. The runner
// took the engine's "Interrupted: gateway shutting down" for the outcome of the
// turn: the session went to "error" and its parent was told the child had failed.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "web-limit-wait-shutdown-"));
process.env.JINN_HOME = scratch;
process.env.RYOKO_HOME = scratch;
let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let restartResume: typeof import("../../sessions/restart-resume.js");
let Manager: typeof import("../../sessions/manager.js").SessionManager;
let callbacks: typeof import("../../sessions/callbacks.js");

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  restartResume = await import("../../sessions/restart-resume.js");
  Manager = (await import("../../sessions/manager.js")).SessionManager;
  callbacks = await import("../../sessions/callbacks.js");
});
beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(path.join(scratch, "tmp", "engine-health.json"), { force: true });
});
afterEach(() => {
  vi.useRealTimers();
  restartResume.prepareRestartResume(); // a boot: whatever "shutting down" a test set is over
});
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const limitedFor = (msFromNow: number): EngineResult => ({ sessionId: "claude-limited", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1,
  rateLimit: { status: "rejected", rateLimitType: "interactive_detected", resetsAt: Math.floor((Date.now() + msFromNow) / 1000), window: "5h" } });

function setup() {
  const config = {
    jinn: { version: "test" }, gateway: { port: 0, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude-test", model: "opus", interactive: true }, codex: { bin: "codex-test", model: "gpt-5.4" } },
    connectors: {}, sessions: { rateLimitStrategy: "wait" }, logging: { level: "error", stdout: false, file: false },
  } as JinnConfig;
  const claudeRun = vi.fn<Engine["run"]>();
  const sessionManager = new Manager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: vi.fn<Engine["run"]>() }]]), []);
  const emit = vi.fn();
  const context: ApiContext = { config, getConfig: () => config, sessionManager, startTime: Date.now(), emit, connectors: new Map() };
  const id = randomUUID();
  const session = registry.createSession({ engine: "claude", source: "web", sourceRef: `web:${id}`, connector: "web", sessionKey: `web:${id}`, prompt: "Please continue" });
  const emitted = (event: string) => emit.mock.calls.filter(([name]) => name === event).map(([, payload]) => payload);
  /** Call the wait off, however the test ended, so no parked turn outlives it. */
  const release = async () => {
    sessionManager.getQueue().clearQueue(session.sessionKey);
    await vi.advanceTimersByTimeAsync(600);
  };
  return { config, context, session, claudeRun, emitted, release };
}

async function send(context: ApiContext, sessionId: string) {
  const req = Readable.from([Buffer.from(JSON.stringify({ message: "Please continue" }))]) as unknown as IncomingMessage;
  req.method = "POST";
  req.url = `/api/sessions/${sessionId}/message`;
  req.headers = { host: "127.0.0.1", "content-type": "application/json" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" } });
  let status = 0;
  const headers: Record<string, unknown> = {};
  const res = { writeHead(code: number) { status = code; return this; }, setHeader(name: string, value: unknown) { headers[name] = value; return this; },
    getHeader(name: string) { return headers[name]; }, end() {} } as unknown as ServerResponse;
  await api.handleApiRequest(req, res, context);
  expect(status).toBe(200);
}

describe("Web session — the retry after a usage-limit wait, stopped by the gateway shutting down", () => {
  it("is not settled as a failed turn, and the session is resumed after the restart", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.claudeRun
      .mockImplementationOnce(async () => limitedFor(5 * 60_000))
      .mockImplementationOnce(async () => {
        restartResume.beginGatewayShutdown();
        restartResume.interruptRunningSessionsForShutdown(); // server.ts cleanup: mark, then stop the engines
        return { sessionId: "claude-limited", result: "", error: "Interrupted: gateway shutting down", interruptRequested: true as const };
      });
    try {
      await send(f.context, f.session.id);
      await vi.waitFor(() => expect(registry.getSession(f.session.id)?.status).toBe("waiting"));

      await vi.advanceTimersByTimeAsync(6 * 60_000); // the limit resets: the turn is tried again

      expect(f.claudeRun).toHaveBeenCalledTimes(2);
      const session = registry.getSession(f.session.id)!;
      expect(session.status).toBe("interrupted"); // not "error": nothing failed
      expect(callbacks.notifyParentSession).not.toHaveBeenCalled();
      expect(callbacks.notifyRateLimitResumed).not.toHaveBeenCalled();
      expect(f.emitted("session:completed")).toEqual([]);
      expect(restartResume.readRestartResumeState(session.transportMeta).interruptedAt).toEqual(expect.any(String));

      // The next start. The turn's queue row was closed with it, so the nudge is what resumes the session.
      restartResume.prepareRestartResume();
      registry.recoverStaleSessions();
      registry.recoverStaleQueueItems();
      api.resumePendingWebQueueItems(f.context);
      const post = vi.fn(async () => {});
      const summary = restartResume.resumeRestartInterruptedSessions({ config: f.config, port: 0, post, schedule: (run) => { void run(); } });

      expect(summary).toMatchObject({ planned: 1, skipped: 0 });
      await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(f.claudeRun).toHaveBeenCalledTimes(2); // and nothing re-ran the prompt behind the nudge's back
    } finally {
      await f.release();
    }
  });
});
