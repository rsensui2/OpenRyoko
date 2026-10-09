import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("../../shared/resolveBin.js", () => ({
  resolveBin: (bin: string) => `/usr/local/bin/${bin}`,
  formatSpawnError: (label: string, bin: string, err: Error) => `Failed to spawn ${label} (${bin}): ${err.message}`,
}));

import { execFileSync, spawn } from "node:child_process";
import { ClaudeEngine } from "../claude.js";
import { forkClaudeSession } from "../../sessions/fork.js";
import { migrateChildEnv } from "../../cli/migrate.js";
import {
  claudeAutoMemoryCandidates,
  configureClaudeAutoMemory,
  resetClaudeAutoMemoryForTests,
} from "../../shared/claude-auto-memory.js";

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

describe("ClaudeEngine — auto memory for gateway-run sessions", () => {
  let configDir: string;
  const cwd = "/srv/instance/.ryoko";
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-wiring-"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    resetClaudeAutoMemoryForTests();
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    resetClaudeAutoMemoryForTests();
    mockExecFileSync.mockReset();
    fs.rmSync(configDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    mockSpawn.mockReset();
  });

  async function spawnedEnv(): Promise<Record<string, string>> {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as any);
    const run = new ClaudeEngine().run({ prompt: "hi", cwd, sessionId: "s1" } as any);
    await new Promise((resolve) => setImmediate(resolve));
    finishOk(proc);
    await run;
    return (mockSpawn.mock.calls[0][2] as { env: Record<string, string> }).env;
  }

  it("turns auto memory off for an instance that never used it", async () => {
    expect((await spawnedEnv()).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });

  it("leaves auto memory on while un-migrated notes exist", async () => {
    const dir = claudeAutoMemoryCandidates(cwd)[0];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "feedback_lesson.md"), "lesson\n");
    expect((await spawnedEnv()).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });

  it("follows an explicit engines.claude.autoMemory setting", async () => {
    configureClaudeAutoMemory(true);
    expect((await spawnedEnv()).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });

  it("passes the flag when forking a session, which also runs a Claude turn in the instance", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({ session_id: "forked" }) as never);
    forkClaudeSession("sess-1", cwd);
    const options = mockExecFileSync.mock.calls[0][2] as { env: Record<string, string> };
    expect(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });

  it("passes the flag to the Claude run that applies migrations, and leaves other engines alone", () => {
    expect(migrateChildEnv("claude", cwd).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(migrateChildEnv("codex", cwd).CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });

  it("does not forward the flag to a remote host over SSH (its Claude home is not ours)", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as any);
    const run = new ClaudeEngine().run({ prompt: "hi", cwd, sessionId: "s2", sshHost: "worker" } as any);
    await new Promise((resolve) => setImmediate(resolve));
    finishOk(proc);
    await run;
    const [bin, args, options] = mockSpawn.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(bin).toBe("ssh");
    expect(args.join(" ")).not.toContain("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
    expect(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });
});
