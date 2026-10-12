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

// The web runner shares the fallback loop with the connector path but has its
// own wait branch and its own accounting, so the take-back is pinned here too.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "web-login-refusal-"));
process.env.JINN_HOME = scratch;
process.env.RYOKO_HOME = scratch;
let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let Manager: typeof import("../../sessions/manager.js").SessionManager;
let login: typeof import("../../sessions/engine-login.js");

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  Manager = (await import("../../sessions/manager.js")).SessionManager;
  login = await import("../../sessions/engine-login.js");
});
beforeEach(() => {
  vi.clearAllMocks();
  login._resetEngineLoginKnowledge();
  fs.rmSync(path.join(scratch, "tmp", "engine-health.json"), { force: true });
});
afterEach(() => vi.useRealTimers());
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const NOT_SIGNED_IN: EngineResult = { sessionId: "", result: "", error: "Codex exited with code 1: Not logged in" };
const limited = (): EngineResult => ({ sessionId: "claude-limited", result: "", error: "Interactive turn failed: rate_limit", cost: 0.2, numTurns: 1,
  rateLimit: { status: "rejected", rateLimitType: "interactive_detected", resetsAt: Math.floor(Date.now() / 1000) + 3600, window: "5h" } });

function setup() {
  const config = {
    jinn: { version: "test" }, gateway: { port: 0, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude-test", model: "opus", interactive: true }, codex: { bin: "codex-test", model: "gpt-5.4" } },
    connectors: {}, sessions: {}, logging: { level: "error", stdout: false, file: false },
  } as JinnConfig;
  const claudeRun = vi.fn<Engine["run"]>(async () => limited());
  const codexRun = vi.fn<Engine["run"]>(async () => NOT_SIGNED_IN);
  const sessionManager = new Manager(config, new Map<string, Engine>([["claude", { name: "claude", run: claudeRun }], ["codex", { name: "codex", run: codexRun }]]), []);
  const context: ApiContext = { config, getConfig: () => config, sessionManager, startTime: Date.now(), emit: vi.fn(), connectors: new Map() };
  const id = randomUUID();
  const session = registry.createSession({ engine: "claude", source: "web", sourceRef: `web:${id}`, connector: "web", sessionKey: `web:${id}`, prompt: "Please continue" });
  return { context, session, claudeRun, codexRun };
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

describe("Web session — the fallback engine cannot sign in", () => {
  it("takes the switch back and waits for the limit, with the limited turn counted once", async () => {
    vi.useFakeTimers();
    const f = setup();
    try {
      await send(f.context, f.session.id);
      await vi.waitFor(() => expect(registry.getSession(f.session.id)?.status).toBe("waiting"));

      const waiting = registry.getSession(f.session.id)!;
      expect(waiting).toMatchObject({ engine: "claude", totalCost: 0.2, totalTurns: 1 });
      expect(waiting.lastError).toMatch(/^claude usage limit — resumes /);
      expect((waiting.transportMeta as { engineOverride?: unknown } | null)?.engineOverride).toBeUndefined();
      expect(f.codexRun).toHaveBeenCalledTimes(2);
      expect(f.context.emit).toHaveBeenCalledWith("session:rate-limited", expect.objectContaining({ sessionId: f.session.id }));
      expect(login.loginRefusalConfirmed("codex")).toBe(true);
    } finally {
      f.context.sessionManager.getQueue().clearQueue(f.session.sessionKey);
      await vi.advanceTimersByTimeAsync(600);
    }
  });
});
