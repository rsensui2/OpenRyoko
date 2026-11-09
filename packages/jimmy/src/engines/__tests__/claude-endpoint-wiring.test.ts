import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

vi.mock("../../shared/resolveBin.js", () => ({
  resolveBin: (bin: string) => `/usr/local/bin/${bin}`,
  formatSpawnError: (label: string, bin: string, err: Error) => `Failed to spawn ${label} (${bin}): ${err.message}`,
}));

import { execFileSync, spawn } from "node:child_process";
import { ClaudeEngine } from "../claude.js";
import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { forkClaudeSession } from "../../sessions/fork.js";
import { configureClaudeEndpoints, resetClaudeEndpointsForTests } from "../../shared/claude-endpoints.js";

const mockSpawn = vi.mocked(spawn);
const mockExecFileSync = vi.mocked(execFileSync);

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  proc.pid = 12345;
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; });
  return proc;
}

function finishOk(proc: any) {
  proc.stdout.emit(
    "data",
    Buffer.from(JSON.stringify({ type: "result", subtype: "success", result: "done", session_id: "sess-1" }) + "\n"),
  );
  proc.exitCode = 0;
  proc.emit("close", 0);
}

describe("ClaudeEngine — engines.claude.endpoints", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    resetClaudeEndpointsForTests();
    process.env.ANTHROPIC_AUTH_TOKEN = "subscription-token";
    process.env.ANTHROPIC_BASE_URL = "https://should-not-leak.example";
    process.env.LOCAL_KEY = "local-secret";
    configureClaudeEndpoints([{
      name: "local-mac",
      baseUrl: "http://100.64.0.10:1236",
      apiKeyEnv: "LOCAL_KEY",
      models: ["deepseek-v41-uncensored"],
    }]);
  });

  afterEach(() => {
    process.env = { ...saved };
    resetClaudeEndpointsForTests();
    mockSpawn.mockReset();
    mockExecFileSync.mockReset();
  });

  async function spawnedEnv(opts: Record<string, unknown>): Promise<Record<string, string>> {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as any);
    const run = new ClaudeEngine().run({ prompt: "hi", cwd: "/tmp", sessionId: "s1", ...opts } as any);
    await new Promise((resolve) => setImmediate(resolve));
    finishOk(proc);
    await run;
    return (mockSpawn.mock.calls[0][2] as { env: Record<string, string> }).env;
  }

  it("sends an endpoint model to the endpoint, with its key and without the subscription token", async () => {
    const env = await spawnedEnv({ model: "deepseek-v41-uncensored" });
    expect(env.ANTHROPIC_BASE_URL).toBe("http://100.64.0.10:1236");
    expect(env.ANTHROPIC_API_KEY).toBe("local-secret");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.DISABLE_LOGOUT_COMMAND).toBe("1"); // the usual local guards still apply
  });

  it("leaves any other model's environment exactly as before", async () => {
    const env = await spawnedEnv({ model: "claude-opus-5-5" });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("subscription-token");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://should-not-leak.example");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("returns an error without spawning when the endpoint key is missing", async () => {
    delete process.env.LOCAL_KEY;
    const result = await new ClaudeEngine().run({ prompt: "hi", cwd: "/tmp", sessionId: "s1", model: "deepseek-v41-uncensored" } as any);
    expect(result.error).toMatch(/local-mac/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("refuses an endpoint model for an SSH employee, whose remote Claude would use Anthropic", async () => {
    const result = await new ClaudeEngine().run({ prompt: "hi", cwd: "/tmp", sessionId: "s1", model: "deepseek-v41-uncensored", sshHost: "worker" } as any);
    expect(result.error).toMatch(/SSH/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("forks an endpoint session on the endpoint, with its model", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ session_id: "forked" }) as never);
    forkClaudeSession("sess-1", "/tmp", "deepseek-v41-uncensored");
    const [, args, options] = mockExecFileSync.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(args).toEqual(expect.arrayContaining(["--model", "deepseek-v41-uncensored"]));
    expect(options.env.ANTHROPIC_BASE_URL).toBe("http://100.64.0.10:1236");
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("forks an Anthropic session exactly as before", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ session_id: "forked" }) as never);
    forkClaudeSession("sess-1", "/tmp", "claude-opus-5-5");
    const [, args, options] = mockExecFileSync.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(args).not.toContain("--model");
    expect(options.env.ANTHROPIC_AUTH_TOKEN).toBe("subscription-token");
  });

  it("runs an endpoint model headless when the interactive engine is on", async () => {
    const headless = { name: "claude", run: vi.fn().mockResolvedValue({ sessionId: "h", result: "local answer" }) };
    const lifecycle = { releaseSession: vi.fn() };
    const interactive = new InteractiveClaudeEngine(lifecycle as any, {} as any, headless as any);
    const result = await interactive.run({ prompt: "hi", cwd: "/tmp", sessionId: "s1", model: "deepseek-v41-uncensored" } as any);
    expect(lifecycle.releaseSession).toHaveBeenCalledWith("s1"); // a warm Anthropic PTY must not outlive this turn
    expect(headless.run).toHaveBeenCalledOnce();
    expect(result.result).toBe("local answer");
  });
});
