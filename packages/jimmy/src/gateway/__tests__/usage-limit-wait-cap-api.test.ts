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

// The web runner has its own wait branch. It parks and refuses the same turns
// as the connector path (see manager-usage-limit-wait-cap.test.ts).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "web-limit-wait-cap-"));
process.env.JINN_HOME = scratch;
process.env.RYOKO_HOME = scratch;
let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let Manager: typeof import("../../sessions/manager.js").SessionManager;
let callbacks: typeof import("../../sessions/callbacks.js");

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  Manager = (await import("../../sessions/manager.js")).SessionManager;
  callbacks = await import("../../sessions/callbacks.js");
});
beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(path.join(scratch, "tmp", "engine-health.json"), { force: true });
});
afterEach(() => vi.useRealTimers());
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const HOUR = 60 * 60_000;
const limitedUntil = (msFromNow: number): EngineResult => ({ sessionId: "claude-limited", result: "", error: "Interactive turn failed: rate_limit", cost: 0.2, numTurns: 1,
  rateLimit: { status: "rejected", rateLimitType: "interactive_detected", resetsAt: Math.floor((Date.now() + msFromNow) / 1000), window: msFromNow > 5 * HOUR ? "7d" : "5h" } });

function setup() {
  const config = {
    jinn: { version: "test" }, gateway: { port: 0, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude-test", model: "opus", interactive: true }, codex: { bin: "codex-test", model: "gpt-5.4" } },
    connectors: {}, sessions: { rateLimitStrategy: "wait" }, logging: { level: "error", stdout: false, file: false },
  } as JinnConfig;
  const claudeRun = vi.fn<Engine["run"]>();
  const codexRun = vi.fn<Engine["run"]>();
  const sessionManager = new Manager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }]]), []);
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
  return { context, session, claudeRun, codexRun, emitted, release };
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

describe("Web session — a usage limit with nowhere to switch to", () => {
  it("fails the turn at once, saying when the limit resets, when that is days away", async () => {
    vi.useFakeTimers();
    const f = setup();
    // Read off the turn itself: the clock moves while the test waits for it.
    let resetsAt = 0;
    f.claudeRun.mockImplementation(async () => {
      const weekly = limitedUntil(5 * 24 * HOUR);
      resetsAt = weekly.rateLimit!.resetsAt!;
      return weekly;
    });
    try {
      await send(f.context, f.session.id);
      await vi.waitFor(() => expect(f.emitted("session:completed")).toHaveLength(1));

      const failed = registry.getSession(f.session.id)!;
      expect(failed).toMatchObject({ status: "error", engine: "claude", totalCost: 0.2, totalTurns: 1 }); // the limited turn, counted once
      expect(failed.lastError).toContain("claude usage limit reached");
      expect(failed.lastError).toContain(new Date(resetsAt * 1000).toISOString());
      expect(f.emitted("session:completed")[0]).toMatchObject({ sessionId: f.session.id, error: failed.lastError });
      expect(f.emitted("session:rate-limited")).toEqual([]);
      expect(f.claudeRun).toHaveBeenCalledTimes(1);
    } finally {
      await f.release();
    }
  });

  it("still waits for a reset that is hours away, as before", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.claudeRun.mockImplementation(async () => limitedUntil(2 * HOUR));
    try {
      await send(f.context, f.session.id);
      await vi.waitFor(() => expect(registry.getSession(f.session.id)?.status).toBe("waiting"));

      expect(registry.getSession(f.session.id)!.lastError).toMatch(/^claude usage limit — resumes /);
      expect(f.emitted("session:rate-limited")).toHaveLength(1);
      expect(f.emitted("session:completed")).toEqual([]);
    } finally {
      await f.release();
    }
  });

  // The wait ends the way a turn that starts on such a limit does: failed, with
  // the reset time for its error, and whoever started the session told so.
  // (The first reset is five minutes off rather than hours: every half-second
  // of a simulated wait is a timer to run, and hours of them made this test
  // time out on a loaded machine.)
  it("stops waiting when the retry after the reset is told the next reset is days away, and says when that is", async () => {
    vi.useFakeTimers();
    const f = setup();
    let nextReset = 0;
    f.claudeRun.mockImplementationOnce(async () => limitedUntil(5 * 60_000)).mockImplementationOnce(async () => {
      const weekly = limitedUntil(5 * 24 * HOUR);
      nextReset = weekly.rateLimit!.resetsAt!;
      return weekly;
    });
    try {
      await send(f.context, f.session.id);
      await vi.waitFor(() => expect(registry.getSession(f.session.id)?.status).toBe("waiting"));

      await vi.advanceTimersByTimeAsync(6 * 60_000);

      expect(f.claudeRun).toHaveBeenCalledTimes(2);
      const failed = registry.getSession(f.session.id)!;
      expect(failed).toMatchObject({ status: "error", totalCost: 0.4, totalTurns: 2 }); // both limited turns, once each
      expect(failed.lastError).toContain("claude usage limit reached");
      expect(failed.lastError).toContain(new Date(nextReset * 1000).toISOString());
      expect(f.emitted("session:completed")).toEqual([expect.objectContaining({ sessionId: f.session.id, error: failed.lastError })]);
      expect(callbacks.notifyParentSession).toHaveBeenCalledWith(expect.objectContaining({ id: f.session.id }), expect.objectContaining({ error: failed.lastError }), expect.anything());
      expect(callbacks.notifyRateLimitResumed).not.toHaveBeenCalled();
      const operatorNotices = vi.mocked(callbacks.notifyDiscordChannel).mock.calls.map(([text]) => text);
      expect(operatorNotices.at(-1)).toContain("has been stopped");
      expect(operatorNotices.some((text) => text.includes("usage limit cleared"))).toBe(false);
    } finally {
      await f.release();
    }
  });

  it("ends a wait whose reset never became known the way it always has, after six hours", async () => {
    vi.useFakeTimers();
    const f = setup();
    f.claudeRun.mockImplementation(async () => ({ ...limitedUntil(0), rateLimit: { status: "rejected", rateLimitType: "interactive_detected" } }));
    try {
      await send(f.context, f.session.id);
      await vi.waitFor(() => expect(registry.getSession(f.session.id)?.status).toBe("waiting"));

      // A few of the minute-by-minute retries, each told the same thing …
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(registry.getSession(f.session.id)?.status).toBe("waiting");
      expect(f.claudeRun.mock.calls.length).toBeGreaterThanOrEqual(3);
      // … then most of the six hours in one step. The wait is bounded by the
      // clock, so moving the clock is enough; running every half-second of six
      // hours made this test time out on a loaded machine.
      vi.setSystemTime(Date.now() + 5 * HOUR + 50 * 60_000);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(registry.getSession(f.session.id)?.status).toBe("waiting"); // five minutes short of six hours
      vi.setSystemTime(Date.now() + 10 * 60_000);
      await vi.advanceTimersByTimeAsync(2 * 60_000);

      const timedOut = "claude usage limit did not clear in time";
      expect(registry.getSession(f.session.id)).toMatchObject({ status: "error", lastError: timedOut });
      expect(f.emitted("session:completed")).toEqual([expect.objectContaining({ sessionId: f.session.id, result: null, error: timedOut })]);
      expect(callbacks.notifyParentSession).toHaveBeenCalledWith(expect.objectContaining({ id: f.session.id }), { error: timedOut }, expect.anything());
    } finally {
      await f.release();
    }
  });
});
