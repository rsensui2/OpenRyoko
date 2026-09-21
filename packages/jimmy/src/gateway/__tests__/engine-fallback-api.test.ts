import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, Engine, EngineResult, EngineRunOpts, JinnConfig, Session } from "../../shared/types.js";
import type { ApiContext } from "../api.js";

vi.mock("../../sessions/callbacks.js", () => ({
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));
vi.mock("../../sessions/context.js", () => ({ buildContext: vi.fn((input) => `Context for ${input.source}; lifetime=${input.processLifetime}`) }));
vi.mock("../../sessions/goal-review.js", () => ({ reviewGoal: vi.fn(async () => ({ status: "complete", reason: "Verified by test" })) }));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "web-engine-fallback-"));
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
beforeEach(() => vi.clearAllMocks());
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function setup(source: "claude" | "codex", initial: (opts: EngineRunOpts) => Promise<EngineResult>, fallback: (opts: EngineRunOpts) => Promise<EngineResult>, sessions: JinnConfig["sessions"] = {}) {
  const target = source === "claude" ? "codex" : "claude";
  const config = {
    jinn: { version: "test" }, gateway: { port: 0, host: "127.0.0.1" },
    engines: { default: source, claude: { bin: "claude-test", model: "opus", interactive: true }, codex: { bin: "codex-test", model: "gpt-5.4" } },
    connectors: {}, sessions, logging: { level: "error", stdout: false, file: false },
  } as JinnConfig;
  const firstRun = vi.fn(initial);
  const fallbackRun = vi.fn(fallback);
  const engines = new Map<string, Engine>([[source, { name: source, run: firstRun }], [target, { name: target, run: fallbackRun }]]);
  const sessionManager = new Manager(config, engines, []);
  const emit = vi.fn();
  const context: ApiContext = { config, getConfig: () => config, sessionManager, startTime: Date.now(), emit, connectors: new Map() };
  const id = randomUUID();
  const session = registry.createSession({ engine: source, source: "web", sourceRef: `web:${id}`, connector: "web", sessionKey: `web:${id}`, prompt: "Please continue" });
  registry.updateSession(session.id, { engineSessionId: `${source}-original`, model: source === "claude" ? "sonnet" : "gpt-5.3-codex" });
  return { context, session: registry.getSession(session.id)!, firstRun, fallbackRun, source, target };
}

async function post(context: ApiContext, route: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = "POST";
  req.url = route;
  req.headers = { host: "127.0.0.1", "content-type": "application/json" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" } });
  let status = 0;
  const chunks: string[] = [];
  const headers: Record<string, unknown> = {};
  const res = { writeHead(code: number) { status = code; return this; }, setHeader(name: string, value: unknown) { headers[name] = value; return this; }, getHeader(name: string) { return headers[name]; }, end(value?: unknown) { if (value) chunks.push(String(value)); } } as unknown as ServerResponse;
  await api.handleApiRequest(req, res, context);
  expect(status).toBe(200);
  return chunks.length ? JSON.parse(chunks.join("")) : undefined;
}

async function send(context: ApiContext, session: Session, extra: Record<string, unknown> = {}) {
  return post(context, `/api/sessions/${session.id}/message`, { message: "Please continue", ...extra });
}

async function completed(context: ApiContext, session: Session) {
  await vi.waitFor(() => expect(context.emit).toHaveBeenCalledWith("session:completed", expect.objectContaining({ sessionId: session.id })), { timeout: 3000 });
  return registry.getSession(session.id)!;
}

const limited = (name: string, cost = 0.2): EngineResult => ({ sessionId: `${name}-limited`, result: "", error: "Usage limit reached", rateLimit: { status: "rejected" }, cost, numTurns: 1 });
const answered = (name: string, cost = 0.3): EngineResult => ({ sessionId: `${name}-continued`, result: "Completed the requested work", cost, numTurns: 1, contextTokens: 1200 });

describe("Web session engine fallback", () => {
  it.each(["claude", "codex"] as const)("switches %s to the other engine with its own model, history, attachments, streaming and accounting", async (source) => {
    const target = source === "claude" ? "codex" : "claude";
    const fixture = setup(source, async () => limited(source), async (opts) => {
      opts.onStream?.({ type: "text", content: "Continuing" });
      return answered(target);
    });
    const attachment = path.join(scratch, `${randomUUID()}.txt`);
    fs.writeFileSync(attachment, "Fixture attachment");
    const fileId = randomUUID();
    registry.insertFile({ id: fileId, filename: "attachment.txt", size: 18, mimetype: "text/plain", path: attachment });
    registry.insertMessage(fixture.session.id, "user", "Earlier task context");
    await send(fixture.context, fixture.session, { attachments: [fileId] });
    const finished = await completed(fixture.context, fixture.session);
    expect(fixture.firstRun).toHaveBeenCalledTimes(1);
    expect(fixture.fallbackRun).toHaveBeenCalledTimes(1);
    const opts = fixture.fallbackRun.mock.calls[0][0];
    expect(opts.model).toBe(target === "codex" ? "gpt-5.4" : "opus");
    expect(opts.bin).toBe(`${target}-test`);
    expect(opts.attachments).toEqual([attachment]);
    expect(opts.prompt).toContain("Earlier task context");
    expect(opts.prompt).toContain("Please continue");
    expect(opts.systemPrompt).toContain(target === "claude" ? "lifetime=persistent" : "lifetime=one-shot");
    expect(finished).toMatchObject({ engine: target, engineSessionId: `${target}-continued`, status: "idle", totalCost: 0.5, totalTurns: 2, lastContextTokens: 1200 });
    expect(fixture.context.emit).toHaveBeenCalledWith("session:delta", expect.objectContaining({ sessionId: fixture.session.id, content: "Continuing" }));
    expect(registry.getMessages(fixture.session.id).filter((item) => item.role === "assistant").map((item) => item.content)).toEqual(["Completed the requested work"]);
  });

  it.each(["claude", "codex"] as const)("switches after an empty %s response", async (source) => {
    const fixture = setup(source, async () => ({ sessionId: `${source}-empty`, result: "" }), async () => answered("other"));
    await send(fixture.context, fixture.session);
    expect((await completed(fixture.context, fixture.session)).status).toBe("idle");
    expect(fixture.fallbackRun).toHaveBeenCalledTimes(1);
  });

  it("terminates after both engines fail instead of bouncing or entering the reset wait loop", async () => {
    const fixture = setup("codex", async () => limited("codex"), async () => limited("claude", 0.3));
    await send(fixture.context, fixture.session);
    const finished = await completed(fixture.context, fixture.session);
    expect(finished).toMatchObject({ status: "error", totalCost: 0.5, totalTurns: 2 });
    expect(fixture.firstRun).toHaveBeenCalledTimes(1);
    expect(fixture.fallbackRun).toHaveBeenCalledTimes(1);
    expect(fixture.context.emit).not.toHaveBeenCalledWith("session:rate-limited", expect.anything());
  });

  it("honors disabled switching for an empty response", async () => {
    const fixture = setup("codex", async () => ({ sessionId: "empty", result: "" }), async () => answered("claude"), { rateLimitStrategy: "wait" });
    await send(fixture.context, fixture.session);
    expect(await completed(fixture.context, fixture.session)).toMatchObject({ engine: "codex", status: "error", lastError: "codex returned no response" });
    expect(fixture.fallbackRun).not.toHaveBeenCalled();
  });

  it("reports an empty retry after waiting for the rate limit as an error", async () => {
    vi.useFakeTimers();
    let fixture: ReturnType<typeof setup> | undefined;
    try {
      let attempt = 0;
      fixture = setup("codex", async () => ++attempt === 1
        ? { ...limited("codex"), rateLimit: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) - 1 } }
        : { sessionId: "codex-empty-retry", result: "" }, async () => answered("claude"), { rateLimitStrategy: "wait" });
      await send(fixture.context, fixture.session);
      await vi.waitFor(() => expect(registry.getSession(fixture!.session.id)?.status).toBe("waiting"));
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await completed(fixture.context, fixture.session)).toMatchObject({ engine: "codex", status: "error", lastError: "codex returned no response" });
      expect(fixture.firstRun).toHaveBeenCalledTimes(2);
      expect(fixture.fallbackRun).not.toHaveBeenCalled();
    } finally {
      if (fixture) fixture.context.sessionManager.getQueue().clearQueue(fixture.session.sessionKey);
      vi.useRealTimers();
    }
  });

  it("does not switch after an application-level stop", async () => {
    const fixture = setup("codex", async () => ({ sessionId: "stopped", result: "Approval required", error: "Goal incomplete", retryable: false }), async () => answered("claude"));
    await send(fixture.context, fixture.session);
    expect((await completed(fixture.context, fixture.session)).lastError).toBe("Goal incomplete");
    expect(fixture.fallbackRun).not.toHaveBeenCalled();
  });

  it("does not launch a fallback after the user stops the in-flight turn", async () => {
    let finish!: (result: EngineResult) => void;
    const fixture = setup("codex", () => new Promise((resolve) => { finish = resolve; }), async () => answered("claude"));
    await send(fixture.context, fixture.session);
    await vi.waitFor(() => expect(fixture.firstRun).toHaveBeenCalledTimes(1));
    await post(fixture.context, `/api/sessions/${fixture.session.id}/stop`, {});
    finish(limited("codex"));
    await vi.waitFor(() => expect(fixture.context.sessionManager.getQueue().isRunning(fixture.session.sessionKey)).toBe(false));
    expect(fixture.fallbackRun).not.toHaveBeenCalled();
    expect(registry.getSession(fixture.session.id)?.status).toBe("idle");
    expect(registry.getMessages(fixture.session.id).some((item) => item.role === "assistant")).toBe(false);
  });

  it("keeps reset engine identifiers clear when an in-flight fallback settles", async () => {
    let finish!: (result: EngineResult) => void;
    const fixture = setup("codex", async () => limited("codex"), () => new Promise((resolve) => { finish = resolve; }));
    await send(fixture.context, fixture.session);
    await vi.waitFor(() => expect(fixture.fallbackRun).toHaveBeenCalledTimes(1));
    await post(fixture.context, `/api/sessions/${fixture.session.id}/reset`, {});
    finish(answered("claude"));
    await vi.waitFor(() => expect(fixture.context.sessionManager.getQueue().isRunning(fixture.session.sessionKey)).toBe(false));
    const reset = registry.getSession(fixture.session.id)!;
    expect(reset).toMatchObject({ status: "idle", engineSessionId: null, lastError: null });
    expect(reset.transportMeta?.engineSessions).toBeUndefined();
    expect(reset.transportMeta?.engineOverride).toBeUndefined();
    expect(registry.getMessages(fixture.session.id).some((item) => item.role === "assistant")).toBe(false);
  });

  it("does not persist an orphan answer when a session is deleted during fallback", async () => {
    let finish!: (result: EngineResult) => void;
    const fixture = setup("codex", async () => limited("codex"), () => new Promise((resolve) => { finish = resolve; }));
    await send(fixture.context, fixture.session);
    await vi.waitFor(() => expect(fixture.fallbackRun).toHaveBeenCalledTimes(1));
    registry.deleteSession(fixture.session.id);
    finish(answered("claude"));
    await vi.waitFor(() => expect(fixture.context.sessionManager.getQueue().isRunning(fixture.session.sessionKey)).toBe(false));
    expect(registry.getSession(fixture.session.id)).toBeUndefined();
    expect(registry.getMessages(fixture.session.id)).toEqual([]);
    expect(fixture.context.emit).not.toHaveBeenCalledWith("session:completed", expect.objectContaining({ sessionId: fixture.session.id }));
  });

  it("delivers a notification wake-up's fallback answer once to its original connector", async () => {
    const fixture = setup("codex", async () => limited("codex"), async () => answered("claude"));
    const replyMessage = vi.fn(async () => "posted");
    fixture.context.connectors.set("slack", { name: "slack", replyMessage,
      reconstructTarget: (target: Record<string, unknown>) => target, getCapabilities: () => ({ threading: true, messageEdits: true, reactions: true, attachments: true }),
    } as unknown as Connector);
    fixture.session = registry.createSession({ engine: "codex", source: "slack", sourceRef: "C_EXTERNAL", connector: "slack", sessionKey: `slack:${randomUUID()}`, replyContext: { channel: "C_EXTERNAL", thread: "1.2" } });
    await send(fixture.context, fixture.session, { role: "notification", message: "Background job finished" });
    await completed(fixture.context, fixture.session);
    expect(replyMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channel: "C_EXTERNAL", thread: "1.2" }), "Completed the requested work");
    expect(fixture.fallbackRun.mock.calls[0][0].systemPrompt).toContain("Context for slack");
  });

  it("restores Codex's model and conversation after a temporary Claude fallback expires", async () => {
    const fixture = setup("codex", async () => answered("codex"), async () => answered("claude"));
    registry.insertMessage(fixture.session.id, "assistant", "Work completed while Claude was active");
    registry.updateSession(fixture.session.id, { engine: "claude", model: "opus", engineSessionId: "claude-temporary",
      transportMeta: { engineOverride: { originalEngine: "codex", originalEngineSessionId: "codex-original", originalModel: "gpt-5.3-codex", until: "2000-01-01T00:00:00.000Z", syncSince: "2000-01-01T00:00:00.000Z" } },
    });
    await send(fixture.context, fixture.session);
    const finished = await completed(fixture.context, fixture.session);
    expect(fixture.firstRun).toHaveBeenCalledTimes(1);
    expect(fixture.fallbackRun).not.toHaveBeenCalled();
    expect(fixture.firstRun.mock.calls[0][0]).toMatchObject({ model: "gpt-5.3-codex", resumeSessionId: "codex-original" });
    expect(fixture.firstRun.mock.calls[0][0].prompt).toContain("Work completed while Claude was active");
    expect(finished.transportMeta?.engineOverride).toBeUndefined();
    expect(finished.transportMeta?.engineSyncSince).toBeUndefined();
  });

  it("rebuilds Claude MCP configuration on Codex fallback and cleans it up", async () => {
    let mcpPath: string | undefined;
    const fixture = setup("codex", async () => limited("codex"), async (opts) => {
      mcpPath = opts.mcpConfigPath;
      expect(mcpPath).toBeDefined();
      expect(JSON.parse(fs.readFileSync(mcpPath!, "utf8"))).toEqual({ mcpServers: { fixture: { command: "fixture-command", args: [] } } });
      return answered("claude");
    });
    fixture.context.config.mcp = { browser: { enabled: false }, gateway: { enabled: false }, custom: { fixture: { command: "fixture-command", args: [] } } };
    await send(fixture.context, fixture.session);
    await completed(fixture.context, fixture.session);
    expect(fixture.firstRun.mock.calls[0][0].mcpConfigPath).toBeUndefined();
    expect(fs.existsSync(mcpPath!)).toBe(false);
  });

  it("switches a timed-out engine only after its process has stopped", async () => {
    let finish!: (result: EngineResult) => void;
    let alive = false;
    const fixture = setup("codex", () => { alive = true; return new Promise((resolve) => { finish = resolve; }); }, async () => {
      expect(alive).toBe(false);
      return answered("claude");
    }, { engineNoResponseTimeoutMs: 20 });
    const kill = vi.fn((_id: string, reason: string) => { alive = false; finish({ sessionId: "codex-timed-out", result: "", error: reason }); });
    Object.assign(fixture.context.sessionManager.getEngine("codex")!, { kill, isAlive: () => alive, killAll: vi.fn() });
    await send(fixture.context, fixture.session);
    expect((await completed(fixture.context, fixture.session)).status).toBe("idle");
    expect(kill).toHaveBeenCalledExactlyOnceWith(fixture.session.id, "Engine response timeout");
    expect(fixture.fallbackRun).toHaveBeenCalledTimes(1);
  });

  it("retains an explicit goal when Claude fails and Codex continues the turn", async () => {
    const fixture = setup("claude", async () => limited("claude"), async () => answered("codex"));
    await send(fixture.context, fixture.session, { message: "/goal Confirm that the requested report exists" });
    const finished = await completed(fixture.context, fixture.session);
    expect(finished.goal).toMatchObject({ condition: "Confirm that the requested report exists", status: "complete" });
    expect(fixture.fallbackRun.mock.calls[0][0].systemPrompt).toContain("tracked completion condition");
  });

  it("preserves the goal on an empty Codex response before handing off to Claude", async () => {
    const fixture = setup("codex", async () => ({ sessionId: "codex-empty-goal", result: "" }), async () => answered("claude"));
    registry.updateSession(fixture.session.id, { goal: { id: randomUUID(), condition: "Confirm the report exists", request: "Create the report", status: "active", updatedAt: new Date().toISOString() } });
    await send(fixture.context, fixture.session);
    await completed(fixture.context, fixture.session);
    expect(fixture.fallbackRun).toHaveBeenCalledTimes(1);
    expect(fixture.fallbackRun.mock.calls[0][0].prompt).toContain("/goal Confirm the report exists");
  });

  it("uses the current engine for an already queued message after the preceding turn switches", async () => {
    let finish!: (result: EngineResult) => void;
    const fixture = setup("codex", () => new Promise((resolve) => { finish = resolve; }), async () => answered("claude"), { interruptOnNewMessage: false });
    await send(fixture.context, fixture.session);
    await vi.waitFor(() => expect(fixture.firstRun).toHaveBeenCalledTimes(1));
    await send(fixture.context, fixture.session, { message: "One more detail" });
    finish(limited("codex"));
    await vi.waitFor(() => expect(fixture.fallbackRun).toHaveBeenCalledTimes(2));
    expect(fixture.firstRun).toHaveBeenCalledTimes(1);
    expect(fixture.fallbackRun.mock.calls[1][0]).toMatchObject({ resumeSessionId: "claude-continued", model: "opus" });
  });
});
