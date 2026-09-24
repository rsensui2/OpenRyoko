import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Engine, EngineResult, EngineRunOpts, JinnConfig } from "../../shared/types.js";
import type { ApiContext } from "../api.js";

vi.mock("../../sessions/callbacks.js", () => ({
  notifyParentSession: vi.fn(), notifyRateLimited: vi.fn(),
  notifyRateLimitResumed: vi.fn(), notifyDiscordChannel: vi.fn(),
}));
vi.mock("../../sessions/context.js", () => ({ buildContext: vi.fn(() => "context") }));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "session-create-employee-"));
process.env.JINN_HOME = scratch;
process.env.RYOKO_HOME = scratch;

const orgDir = path.join(scratch, "org", "operations");
fs.mkdirSync(orgDir, { recursive: true });
fs.writeFileSync(path.join(orgDir, "local-drafter.yaml"), [
  "name: local-drafter",
  "engine: codex",
  "model: local",
  "cliFlags: ['-c', 'model_provider=\"omlx\"']",
  "persona: Draft only.",
].join("\n"));
fs.writeFileSync(path.join(orgDir, "tako.yaml"), [
  "name: tako",
  "engine: claude",
  "model: sonnet",
  "persona: Advise.",
].join("\n"));

for (const engine of ["codex", "claude", "gemini"]) {
  fs.writeFileSync(path.join(orgDir, `${engine}-default.yaml`), [
    `name: ${engine}-default`, `engine: ${engine}`, "persona: Use the engine default.",
  ].join("\n"));
}

let api: typeof import("../api.js");
let registry: typeof import("../../sessions/registry.js");
let Manager: typeof import("../../sessions/manager.js").SessionManager;

beforeAll(async () => {
  api = await import("../api.js");
  registry = await import("../../sessions/registry.js");
  Manager = (await import("../../sessions/manager.js")).SessionManager;
});
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

function setup() {
  const config = {
    jinn: { version: "test" }, gateway: { port: 0, host: "127.0.0.1" },
    engines: { default: "codex", claude: { bin: "claude-test", model: "opus" }, codex: { bin: "codex-test", model: "gpt-6-astra" }, gemini: { bin: "gemini-test", model: "gemini-2.5-pro" } },
    connectors: {}, sessions: {}, logging: { level: "error", stdout: false, file: false },
  } as JinnConfig;
  const ok = (name: string): EngineResult => ({ sessionId: `${name}-1`, result: "done", cost: 0, numTurns: 1 });
  const codexRun = vi.fn(async (_opts: EngineRunOpts) => ok("codex"));
  const claudeRun = vi.fn(async (_opts: EngineRunOpts) => ok("claude"));
  const geminiRun = vi.fn(async (_opts: EngineRunOpts) => ok("gemini"));
  const engines = new Map<string, Engine>([["codex", { name: "codex", run: codexRun }], ["claude", { name: "claude", run: claudeRun }], ["gemini", { name: "gemini", run: geminiRun }]]);
  const context: ApiContext = {
    config, getConfig: () => config, sessionManager: new Manager(config, engines, []),
    startTime: Date.now(), emit: vi.fn(), connectors: new Map(),
  };
  return { context, codexRun, claudeRun, geminiRun };
}

async function createSession(context: ApiContext, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  req.method = "POST";
  req.url = "/api/sessions";
  req.headers = { host: "127.0.0.1", "content-type": "application/json" };
  Object.defineProperty(req, "socket", { value: { remoteAddress: "127.0.0.1" } });
  let status = 0;
  const chunks: string[] = [];
  const headers: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader(name: string, value: unknown) { headers[name] = value; return this; },
    getHeader(name: string) { return headers[name]; },
    end(value?: unknown) { if (value) chunks.push(String(value)); },
  } as unknown as ServerResponse;
  await api.handleApiRequest(req, res, context);
  return { status, body: JSON.parse(chunks.join("")) };
}

describe("POST /api/sessions with an employee", () => {
  it.each([
    ["codex", "gpt-6-astra"], ["claude", "opus"], ["gemini", "gemini-2.5-pro"],
  ])("inherits %s config when employee model is omitted", async (engine, expectedModel) => {
    const { context, codexRun, claudeRun, geminiRun } = setup();
    const { status, body } = await createSession(context, { prompt: "Summarize", employee: `${engine}-default` });
    expect(status).toBe(201);
    expect(body.engine).toBe(engine);
    expect(registry.getSession(body.id)?.model).toBeNull();
    const run = engine === "codex" ? codexRun : engine === "claude" ? claudeRun : geminiRun;
    await vi.waitFor(() => expect(run).toHaveBeenCalled(), { timeout: 3000 });
    expect(run.mock.calls[0][0].model).toBe(expectedModel);
  });

  it("honors an explicit request model when the employee has no model", async () => {
    const { context, codexRun } = setup();
    const { body } = await createSession(context, { prompt: "Summarize", employee: "codex-default", model: "gpt-6-sol" });
    expect(registry.getSession(body.id)?.model).toBe("gpt-6-sol");
    await vi.waitFor(() => expect(codexRun).toHaveBeenCalled(), { timeout: 3000 });
    expect(codexRun.mock.calls[0][0].model).toBe("gpt-6-sol");
  });

  it("runs the child on the employee's engine and model, with its cliFlags", async () => {
    const { context, codexRun } = setup();
    const { status, body } = await createSession(context, { prompt: "Summarize", employee: "local-drafter" });

    expect(status).toBe(201);
    expect(body.engine).toBe("codex");
    expect(registry.getSession(body.id)?.model).toBe("local");
    await vi.waitFor(() => expect(codexRun).toHaveBeenCalled(), { timeout: 3000 });
    const opts = codexRun.mock.calls[0][0];
    expect(opts.model).toBe("local");
    expect(opts.cliFlags).toEqual(["-c", 'model_provider="omlx"']);
  });

  it("uses the employee's engine instead of the global default", async () => {
    const { context, codexRun, claudeRun } = setup();
    const { body } = await createSession(context, { prompt: "Advise", employee: "tako" });

    expect(body.engine).toBe("claude");
    await vi.waitFor(() => expect(claudeRun).toHaveBeenCalled(), { timeout: 3000 });
    expect(claudeRun.mock.calls[0][0].model).toBe("sonnet");
    expect(codexRun).not.toHaveBeenCalled();
  });

  it("lets an explicit engine and model in the request win over the employee", async () => {
    const { context, claudeRun } = setup();
    const { body } = await createSession(context, { prompt: "Advise", employee: "local-drafter", engine: "claude", model: "haiku" });

    expect(body.engine).toBe("claude");
    await vi.waitFor(() => expect(claudeRun).toHaveBeenCalled(), { timeout: 3000 });
    expect(claudeRun.mock.calls[0][0].model).toBe("haiku");
  });

  it("does not carry the employee's model onto a different engine", async () => {
    const { context, claudeRun } = setup();
    await createSession(context, { prompt: "Advise", employee: "local-drafter", engine: "claude" });

    await vi.waitFor(() => expect(claudeRun).toHaveBeenCalled(), { timeout: 3000 });
    expect(claudeRun.mock.calls[0][0].model).toBe("opus");
  });

  it("keeps the current behaviour when no employee is given", async () => {
    const { context, codexRun } = setup();
    const { body } = await createSession(context, { prompt: "Hello" });

    expect(body.engine).toBe("codex");
    await vi.waitFor(() => expect(codexRun).toHaveBeenCalled(), { timeout: 3000 });
    expect(codexRun.mock.calls[0][0].model).toBe("gpt-6-astra");
  });
});
