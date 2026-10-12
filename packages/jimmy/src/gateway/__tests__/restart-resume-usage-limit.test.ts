import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Connector, Engine, EngineResult, JinnConfig, Session } from "../../shared/types.js";

// A turn that was waiting for a usage limit when the gateway restarted is
// nudged after the restart. The limit may still be on when that nudge runs —
// the reset moved, or nobody knew when it was. The nudged turn then goes
// through what any turn goes through (wait for a reset that is near, fail at
// once for one that is days away), and whichever it is, it must not turn every
// restart into another failure message in the customer's thread.
//
// Real registry, real /message route, real restart-resume module; only the
// engine, the Slack connector and the wait for the reset are fakes.
//
// RYOKO_HOME must point at a temp dir BEFORE any module import pulls in
// shared/paths.js, so every module here is imported dynamically.
process.env.RYOKO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "restart-resume-limit-home-"));

// The in-process wait for a reset, held open until a test lets it go.
const wait = vi.hoisted(() => ({ held: [] as Array<(carryOn: boolean) => void> }));
vi.mock("../../sessions/engine-fallback.js", async (original) => ({
  ...await original<typeof import("../../sessions/engine-fallback.js")>(),
  waitForEngineRetry: vi.fn(() => new Promise<boolean>((resolve) => { wait.held.push(resolve); })),
}));

const HOUR = 60 * 60_000;
const STUB_CONFIG = {
  jinn: { version: "0.0.0" },
  gateway: { port: 0, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "", interactive: true }, codex: { bin: "codex", model: "" } },
  connectors: {},
  sessions: { rateLimitStrategy: "wait" },
  logging: { level: "error", stdout: false, file: "" },
} as unknown as JinnConfig;

/** The engine's refusal of a turn for a usage limit that resets `msFromNow` from now. */
const limitedFor = (msFromNow: number): EngineResult => ({
  sessionId: "engine-limited", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1,
  rateLimit: { status: "rejected", rateLimitType: "interactive_detected", resetsAt: Math.floor((Date.now() + msFromNow) / 1000), window: msFromNow > 5 * HOUR ? "7d" : "5h" },
});

describe("restart resume — a nudged turn that meets the usage limit again", () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;
  let engineRun: ReturnType<typeof vi.fn<Engine["run"]>>;
  let replyMessage: ReturnType<typeof vi.fn>;
  let registry: typeof import("../../sessions/registry.js");
  let restartResume: typeof import("../../sessions/restart-resume.js");
  let api: typeof import("../api.js");
  let sessionManager: import("../../sessions/manager.js").SessionManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let context: any;
  let thread = 0;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    api = await import("../api.js");
    registry = await import("../../sessions/registry.js");
    restartResume = await import("../../sessions/restart-resume.js");
    const { SessionManager } = await import("../../sessions/manager.js");
    const { ensureGatewayAuthToken } = await import("../auth.js");
    ensureGatewayAuthToken(process.env.RYOKO_HOME!);

    engineRun = vi.fn<Engine["run"]>();
    sessionManager = new SessionManager(STUB_CONFIG, new Map<string, Engine>([["claude", { name: "claude", run: engineRun }]]), ["slack"]);
    replyMessage = vi.fn(async () => "posted-ts");
    const fakeSlack = {
      name: "slack", replyMessage, addReaction: vi.fn(async () => {}),
      getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
      reconstructTarget: (rc: Record<string, unknown>) => ({
        channel: typeof rc.channel === "string" ? rc.channel : "",
        thread: typeof rc.thread === "string" ? rc.thread : undefined,
      }),
    } as unknown as Connector;
    context = { config: STUB_CONFIG, getConfig: () => STUB_CONFIG, sessionManager, startTime: 0, emit: () => {}, connectors: new Map([["slack", fakeSlack]]) };
    server = http.createServer((req, res) => { void api.handleApiRequest(req, res, context); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    // Fail closed: nothing in this suite may reach any other gateway.
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${baseUrl}/`)) throw new Error(`test attempted to reach ${url}`);
      return realFetch(input, init);
    }) as typeof fetch;
  });

  beforeEach(() => {
    engineRun.mockReset();
    replyMessage.mockClear();
    wait.held.length = 0;
    fs.rmSync(path.join(process.env.RYOKO_HOME!, "tmp", "engine-health.json"), { force: true });
  });

  afterEach(() => {
    for (const settle of wait.held.splice(0)) settle(false);
    restartResume.prepareRestartResume(); // a boot: whatever "shutting down" a test set is over
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(process.env.RYOKO_HOME!, { recursive: true, force: true });
  });

  /** A Slack conversation whose turn was parked on a usage limit — reset already passed — when the gateway shut down. */
  function waitedAndWasShutDown(): Session {
    const ts = `${++thread}.000`;
    const session = registry.createSession({
      engine: "claude", source: "slack", sourceRef: "C_LIMIT", connector: "slack", sessionKey: `slack:C_LIMIT:${ts}`,
      replyContext: { channel: "C_LIMIT", thread: ts }, transportMeta: { channelExternal: false }, prompt: "週次レポートを作成してください",
    });
    registry.insertMessage(session.id, "user", "週次レポートを作成してください");
    registry.updateSession(session.id, {
      status: "waiting", engineSessionId: "engine-before-restart",
      lastError: `claude usage limit — resumes ${new Date(Date.now() - 60_000).toISOString()}`,
    });
    restartResume.interruptRunningSessionsForShutdown();
    return registry.getSession(session.id)!;
  }

  /** The boot half of startGateway, in its order. Nudges that are due now are sent at once. */
  function start() {
    const prepared = restartResume.prepareRestartResume();
    registry.recoverStaleSessions();
    registry.recoverStaleQueueItems();
    api.resumePendingWebQueueItems(context);
    const summary = restartResume.resumeRestartInterruptedSessions({
      config: STUB_CONFIG, port, queue: sessionManager.getQueue(),
      schedule: (run, delayMs) => { if (delayMs === 0) void run(); },
    });
    return { prepared, summary };
  }

  it("fails once, without a word in the thread, when the limit now resets days away — and no later restart wakes it again", async () => {
    const session = waitedAndWasShutDown();
    engineRun.mockImplementation(async () => limitedFor(5 * 24 * HOUR));

    expect(start().summary).toMatchObject({ planned: 1, heldForLimit: 0 });

    await vi.waitFor(() => expect(registry.getSession(session.id)?.status).toBe("error"), { timeout: 10_000 });
    expect(registry.getSession(session.id)?.lastError).toContain("too far off to wait for");
    expect(engineRun).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(replyMessage).not.toHaveBeenCalled();

    // Restart after restart while the limit is on: the session is left alone.
    for (let restart = 0; restart < 3; restart++) {
      restartResume.interruptRunningSessionsForShutdown();
      expect(start().summary).toMatchObject({ planned: 0 });
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(engineRun).toHaveBeenCalledTimes(1);
    expect(replyMessage).not.toHaveBeenCalled();
  });

  it("parks again without a word in the thread when the limit resets soon — and a restart right after does not wake it to be refused once more", async () => {
    const session = waitedAndWasShutDown();
    engineRun.mockImplementation(async () => limitedFor(HOUR));

    expect(start().summary).toMatchObject({ planned: 1, heldForLimit: 0 });

    // The nudged turn is refused, and waits for the reset like any other turn.
    await vi.waitFor(() => expect(registry.getSession(session.id)?.status).toBe("waiting"), { timeout: 10_000 });
    await vi.waitFor(() => expect(wait.held).toHaveLength(1), { timeout: 10_000 });
    expect(engineRun).toHaveBeenCalledTimes(1);
    expect(replyMessage).not.toHaveBeenCalled();

    // The gateway restarts again while it waits.
    restartResume.interruptRunningSessionsForShutdown();
    for (const settle of wait.held.splice(0)) settle(false); // the process is gone, and that wait with it
    await vi.waitFor(() => expect(sessionManager.getQueue().isRunning(session.sessionKey)).toBe(false), { timeout: 10_000 });
    const next = start();

    // The session was nudged a moment ago and nothing new has reached it since: it is not woken again now.
    expect(next.prepared.cancelledNudges).toBe(0); // the nudge's row was closed when its turn let go: nothing to replay
    expect(next.summary).toMatchObject({ planned: 0, skipped: 1 });
    await new Promise((r) => setTimeout(r, 300));
    expect(engineRun).toHaveBeenCalledTimes(1);
    expect(replyMessage).not.toHaveBeenCalled();
    expect(registry.getSession(session.id)?.status).toBe("interrupted"); // not "waiting" for good
  });
});
