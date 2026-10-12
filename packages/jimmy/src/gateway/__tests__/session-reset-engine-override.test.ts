import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, JinnConfig, Session } from "../../shared/types.js";
import type { ApiContext } from "../api.js";

vi.mock("../../sessions/callbacks.js", () => ({
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));
vi.mock("../../sessions/context.js", () => ({ buildContext: vi.fn(() => "context") }));
vi.mock("../../sessions/goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "Verified by test" })) }));

/**
 * Resetting a session clears what it remembers about its engine sessions. For a
 * session held on a fallback engine it also deleted the override — the only
 * record of the engine, model and effort the session belongs on. The session
 * then stayed on the fallback engine for good, with nothing left to say it had
 * ever been anywhere else.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "session-reset-override-"));
process.env.JINN_HOME = scratch;
process.env.RYOKO_HOME = scratch;
let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let Manager: typeof import("../../sessions/manager.js").SessionManager;

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  Manager = (await import("../../sessions/manager.js")).SessionManager;
});
beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(path.join(scratch, "tmp", "engine-health.json"), { force: true });
});
afterEach(() => vi.useRealTimers());
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** The moment the session was moved to its fallback engine. It is held there for an hour. */
const SWITCHED = Date.parse("2026-10-12T03:00:00.000Z");
const at = (minutes: number) => new Date(SWITCHED + minutes * 60_000);
const answered = (name: string): EngineResult => ({ sessionId: `${name}-new`, result: `Answered by ${name}.`, cost: 0.1, numTurns: 1 });

function setup() {
  const config = {
    jinn: { version: "test" }, gateway: { port: 0, host: "127.0.0.1" },
    engines: { default: "codex", claude: { bin: "claude-test", model: "opus", interactive: true }, codex: { bin: "codex-test", model: "gpt-5.4" } },
    connectors: {}, sessions: {}, logging: { level: "error", stdout: false, file: false },
  } as JinnConfig;
  const claudeRun = vi.fn<Engine["run"]>(async () => answered("claude"));
  const codexRun = vi.fn<Engine["run"]>(async () => answered("codex"));
  const sessionManager = new Manager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }]]), []);
  const emit = vi.fn();
  const context: ApiContext = { config, getConfig: () => config, sessionManager, startTime: Date.now(), emit, connectors: new Map() };
  const id = randomUUID();
  const created = registry.createSession({ engine: "codex", source: "web", sourceRef: `web:${id}`, connector: "web", sessionKey: `web:${id}`, prompt: "Please continue" });
  /** Send a message and wait for its turn to finish. */
  const say = async (sessionId: string) => {
    await post(context, `/api/sessions/${sessionId}/message`, { message: "Please continue" });
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith("session:completed", expect.objectContaining({ sessionId })), { timeout: 3000 });
  };
  return { context, created, claudeRun, codexRun, say };
}

/** A Codex session that a usage limit moved to Claude, stuck there with an hour of the hold left. */
function heldOnClaude(session: Session): Session {
  return registry.updateSession(session.id, { engine: "claude", model: "opus", effortLevel: "medium", engineSessionId: "claude-temporary", status: "error", lastError: "stuck",
    transportMeta: { channelExternal: false, engineSessions: { codex: "codex-original", claude: "claude-temporary" }, engineSyncSince: { claude: at(0).toISOString() },
      engineOverride: { originalEngine: "codex", originalEngineSessionId: "codex-original", originalModel: "gpt-5.3-codex", originalEffortLevel: "xhigh",
        until: at(60).toISOString(), syncSince: at(0).toISOString() } },
  })!;
}

async function post(context: ApiContext, route: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = "POST";
  req.url = route;
  req.headers = { host: "127.0.0.1", "content-type": "application/json" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" } });
  let status = 0;
  const headers: Record<string, unknown> = {};
  const res = { writeHead(code: number) { status = code; return this; }, setHeader(name: string, value: unknown) { headers[name] = value; return this; },
    getHeader(name: string) { return headers[name]; }, end() {} } as unknown as ServerResponse;
  await api.handleApiRequest(req, res, context);
  expect(status).toBe(200);
}

describe("POST /api/sessions/:id/reset — a session held on a fallback engine", () => {
  it("keeps its way back, and nothing of the engine sessions it had", async () => {
    vi.useFakeTimers({ now: at(10), toFake: ["Date"] });
    const f = setup();
    const held = heldOnClaude(f.created);

    await post(f.context, `/api/sessions/${held.id}/reset`, {});

    const reset = registry.getSession(held.id)!;
    expect(reset).toMatchObject({ engine: "claude", model: "opus", effortLevel: "medium", status: "idle", engineSessionId: null, lastError: null });
    expect(reset.transportMeta).toEqual({ channelExternal: false, engineOverride: {
      originalEngine: "codex", originalModel: "gpt-5.3-codex", originalEffortLevel: "xhigh", until: at(60).toISOString(),
      originalEngineSessionId: null, syncSince: at(10).toISOString(), // the session it had on Codex is abandoned with the rest
    } });
  });

  it("answers on the fallback engine while the hold lasts, in a new engine session", async () => {
    vi.useFakeTimers({ now: at(10), toFake: ["Date"] });
    const f = setup();
    const held = heldOnClaude(f.created);
    await post(f.context, `/api/sessions/${held.id}/reset`, {});

    vi.setSystemTime(at(11));
    await f.say(held.id);

    expect(f.codexRun).not.toHaveBeenCalled();
    expect(f.claudeRun).toHaveBeenCalledTimes(1);
    expect(f.claudeRun.mock.calls[0][0]).toMatchObject({ model: "opus", prompt: "Please continue" });
    expect(f.claudeRun.mock.calls[0][0].resumeSessionId).toBeUndefined();
  });

  it("returns to its own engine, model and effort when the hold ends, told only what happened since the reset", async () => {
    vi.useFakeTimers({ now: at(5), toFake: ["Date"] });
    const f = setup();
    const held = heldOnClaude(f.created);
    registry.insertMessage(held.id, "assistant", "An answer from before the reset");
    vi.setSystemTime(at(10));
    await post(f.context, `/api/sessions/${held.id}/reset`, {});
    vi.setSystemTime(at(20));
    registry.insertMessage(held.id, "assistant", "An answer from after the reset");

    vi.setSystemTime(at(61));
    await f.say(held.id);

    expect(f.claudeRun).not.toHaveBeenCalled();
    expect(f.codexRun).toHaveBeenCalledTimes(1);
    const run = f.codexRun.mock.calls[0][0];
    expect(run).toMatchObject({ model: "gpt-5.3-codex", effortLevel: "xhigh" });
    expect(run.resumeSessionId).toBeUndefined(); // not the Codex session the reset abandoned
    expect(run.prompt).toContain("An answer from after the reset");
    expect(run.prompt).not.toContain("An answer from before the reset");
    const back = registry.getSession(held.id)!;
    expect(back).toMatchObject({ engine: "codex", model: "gpt-5.3-codex", effortLevel: "xhigh", engineSessionId: "codex-new", status: "idle" });
    expect(back.transportMeta?.engineOverride).toBeUndefined();
  });

  // What a reset is usually for: the turn on the fallback engine is stuck.
  it("keeps its way back when the fallback turn that was running at the reset settles afterwards", async () => {
    const f = setup();
    registry.updateSession(f.created.id, { model: "gpt-5.3-codex" });
    let finish!: (result: EngineResult) => void;
    f.codexRun.mockImplementationOnce(async () => ({ sessionId: "codex-limited", result: "", error: "Usage limit reached", rateLimit: { status: "rejected" }, cost: 0.2, numTurns: 1 }));
    f.claudeRun.mockImplementationOnce(() => new Promise<EngineResult>((resolve) => { finish = resolve; }));
    await post(f.context, `/api/sessions/${f.created.id}/message`, { message: "Please continue" });
    await vi.waitFor(() => expect(f.claudeRun).toHaveBeenCalledTimes(1));

    await post(f.context, `/api/sessions/${f.created.id}/reset`, {});
    finish(answered("claude"));
    await vi.waitFor(() => expect(f.context.sessionManager.getQueue().isRunning(f.created.sessionKey)).toBe(false));

    const reset = registry.getSession(f.created.id)!;
    expect(reset).toMatchObject({ engine: "claude", status: "idle", engineSessionId: null, lastError: null });
    expect(reset.transportMeta?.engineOverride).toMatchObject({ originalEngine: "codex", originalModel: "gpt-5.3-codex", originalEngineSessionId: null });
    expect(reset.transportMeta?.engineSessions).toBeUndefined();
    expect(registry.getMessages(f.created.id).some((item) => item.role === "assistant")).toBe(false);
  });
});

describe("POST /api/sessions/:id/reset — a session that is not held anywhere", () => {
  it("is reset as before: same engine, model and effort, no engine session", async () => {
    const f = setup();
    registry.updateSession(f.created.id, { model: "gpt-5.3-codex", effortLevel: "high", engineSessionId: "codex-stale", status: "error", lastError: "stuck",
      transportMeta: { channelExternal: false, engineSessions: { codex: "codex-stale" } } });

    await post(f.context, `/api/sessions/${f.created.id}/reset`, {});

    const reset = registry.getSession(f.created.id)!;
    expect(reset).toMatchObject({ engine: "codex", model: "gpt-5.3-codex", effortLevel: "high", status: "idle", engineSessionId: null, lastError: null });
    expect(reset.transportMeta).toEqual({ channelExternal: false });
  });

  it("still drops an override that names no way back", async () => {
    const f = setup();
    registry.updateSession(f.created.id, { engine: "claude", model: "opus", engineSessionId: "claude-temporary",
      transportMeta: { engineOverride: { until: at(60).toISOString() } } });

    await post(f.context, `/api/sessions/${f.created.id}/reset`, {});

    const reset = registry.getSession(f.created.id)!;
    expect(reset).toMatchObject({ engine: "claude", model: "opus", engineSessionId: null });
    expect(reset.transportMeta?.engineOverride).toBeUndefined();
  });
});
