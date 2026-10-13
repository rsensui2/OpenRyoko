import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Engine, EngineRunOpts, JinnConfig } from "../../shared/types.js";
import type { ApiContext } from "../api.js";

/**
 * The web UI and the API are the operator's own way in: the gateway has
 * authenticated the caller before a prompt gets this far. The rule a chat
 * message is held to (sessions/connector-command-guard.ts) is deliberately not
 * applied here — a prompt reaches the engine as it was written, as it always
 * has. These tests pin that, so that tightening this path later is a decision
 * and not a side effect.
 */

vi.mock("../../sessions/callbacks.js", () => ({
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));
vi.mock("../../sessions/context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/context.js")>()),
  buildContext: () => "context",
}));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "web-api-prompt-"));
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

function setup() {
  const config = {
    jinn: { version: "test" }, gateway: { port: 0, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude-test", model: "opus", interactive: true, fallback: [] }, codex: { bin: "codex-test", model: "gpt-5.4" } },
    // An operator is configured, and the caller is nobody in particular: on this path that is not asked.
    portal: { operatorName: "Ryosuke", operatorSlackId: "U0OPERATOR" },
    connectors: {}, sessions: {}, logging: { level: "error", stdout: false, file: false },
  } as unknown as JinnConfig;
  const run = vi.fn(async (_opts: EngineRunOpts) => ({ sessionId: "claude-session", result: "了解しました。", numTurns: 1 }));
  const sessionManager = new Manager(config, new Map<string, Engine>([["claude", { name: "claude", run }]]), []);
  const emit = vi.fn();
  const context: ApiContext = { config, getConfig: () => config, sessionManager, startTime: Date.now(), emit, connectors: new Map() };
  const completed = (sessionId: string) =>
    vi.waitFor(() => expect(emit).toHaveBeenCalledWith("session:completed", expect.objectContaining({ sessionId })), { timeout: 3000 });
  return { context, run, completed };
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
  expect([200, 201]).toContain(status);
  return chunks.length ? JSON.parse(chunks.join("")) : undefined;
}

const AS_WRITTEN = ["/logout", "/compact", "/permissions", "/resume", "--resume", "- 一つ目\n- 二つ目", "!ls", "exit", "   /logout"];

describe("a prompt from the web UI or the API", () => {
  it.each(AS_WRITTEN)("opens a session with %j as written", async (prompt) => {
    const f = setup();

    const session = await post(f.context, "/api/sessions", { prompt });
    await f.completed(session.id);

    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.run.mock.calls[0][0].prompt).toBe(prompt);
  });

  it.each(AS_WRITTEN)("continues a session with %j as written", async (message) => {
    const f = setup();
    const session = await post(f.context, "/api/sessions", { prompt: "こんにちは" });
    await f.completed(session.id);
    f.context.emit = vi.fn();
    const completedAgain = () =>
      vi.waitFor(() => expect(f.context.emit).toHaveBeenCalledWith("session:completed", expect.objectContaining({ sessionId: session.id })), { timeout: 3000 });

    await post(f.context, `/api/sessions/${session.id}/message`, { message });
    await completedAgain();

    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[1][0].prompt).toBe(message);
  });

  it.each(["/compact", "/logout", "--resume"])("hands a delegated child session %j as written", async (prompt) => {
    const f = setup();
    const parent = registry.createSession({ engine: "claude", source: "slack", sourceRef: "slack:D1", connector: "slack", sessionKey: `slack:parent-${Date.now()}-${Math.random()}` });

    const child = await post(f.context, "/api/sessions", { prompt, parentSessionId: parent.id });
    await f.completed(child.id);

    expect(registry.getSession(child.id)?.parentSessionId).toBe(parent.id);
    expect(f.run.mock.calls[0][0].prompt).toBe(prompt);
  });
});
