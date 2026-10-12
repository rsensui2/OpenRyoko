import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node-pty", () => ({ spawn }));

import { buildClaudePtyEnv } from "../../engines/claude-interactive.js";
import { buildChildEnv } from "../../shared/childEnv.js";
import { JINN_HOME } from "../../shared/paths.js";
import { _clearResolveBinCache } from "../../shared/resolveBin.js";
import { killLiveLoginPtys, resolveProviderCommand, runStatusCommand, spawnLoginPty } from "../runtime.js";

// Stand-ins for the two CLIs, so no test depends on what this machine has installed.
const BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "provider-auth-bin-"));
const CLAUDE_BIN = path.join(BIN_DIR, "claude");
const CODEX_BIN = path.join(BIN_DIR, "codex");
for (const file of [CLAUDE_BIN, CODEX_BIN]) fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
afterAll(() => { fs.rmSync(BIN_DIR, { recursive: true, force: true }); });

const ENGINES = {
  default: "claude" as const,
  claude: { bin: CLAUDE_BIN, model: "opus", interactive: true },
  codex: { bin: CODEX_BIN, model: "gpt" },
};

describe("resolveProviderCommand", () => {
  const touched = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR",
    "CODEX_HOME", "CODEX_SANDBOX", "CODEX", "PATH",
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    _clearResolveBinCache();
    saved = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: "/data/claude-config",
      CODEX_HOME: "/data/elsewhere", CODEX_SANDBOX: "seatbelt", CODEX: "1",
    });
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _clearResolveBinCache();
  });

  it("gives the Claude login the interactive engine's environment", async () => {
    const command = await resolveProviderCommand("claude", { engines: ENGINES });

    expect(command.file).toBe(CLAUDE_BIN);
    expect(command.cwd).toBe(JINN_HOME);
    expect(command.env).toEqual(buildClaudePtyEnv(undefined, process.env));
    // Where the credentials land is decided by these, exactly as for the engine.
    expect(command.env.HOME).toBe(process.env.HOME);
    expect(command.env.CLAUDE_CONFIG_DIR).toBe("/data/claude-config");
    expect(command.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(command.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(command.env).not.toHaveProperty("CLAUDECODE");
    expect(command.env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
  });

  it("gives the Claude login the headless engine's environment when PTY mode is off", async () => {
    const engines = { ...ENGINES, claude: { ...ENGINES.claude, interactive: false } };
    const command = await resolveProviderCommand("claude", { engines });

    expect(command.env).toEqual(buildChildEnv());
    expect(command.env.ANTHROPIC_API_KEY).toBe("sk-test");
    expect(command.env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
  });

  it("logs in with the `auth login` subcommand, which the inherited DISABLE_LOGOUT_COMMAND does not touch", async () => {
    const { PROVIDERS } = await import("../providers.js");
    const command = await resolveProviderCommand("claude", { engines: ENGINES });

    // The login runs a CLI subcommand, not the interactive TUI, so the switch
    // that turns off the TUI's /logout (carried in the interactive env it
    // inherits) has no bearing on it — the login still works.
    expect(PROVIDERS.claude.loginArgs.slice(0, 2)).toEqual(["auth", "login"]);
    expect(command.env.DISABLE_LOGOUT_COMMAND).toBe("1");
    expect(command.env).not.toHaveProperty("DISABLE_LOGIN_COMMAND");
  });

  it("gives the Codex login the Codex engine's environment — no CODEX_HOME override", async () => {
    const command = await resolveProviderCommand("codex", { engines: ENGINES });

    expect(command.file).toBe(CODEX_BIN);
    expect(command.cwd).toBe(JINN_HOME);
    expect(command.env).toEqual(buildChildEnv({ stripPrefixes: ["CODEX_"], stripExact: ["CODEX"] }));
    expect(command.env.HOME).toBe(process.env.HOME);
    expect(Object.keys(command.env).filter((key) => key === "CODEX" || key.startsWith("CODEX_"))).toEqual([]);
  });

  it("looks the CLI up on PATH by its own name when no bin is configured", async () => {
    process.env.PATH = BIN_DIR;
    const engines = { default: "claude" as const, claude: { model: "opus" }, codex: { model: "gpt" } };

    expect((await resolveProviderCommand("claude", { engines } as never)).file).toBe(CLAUDE_BIN);
    expect((await resolveProviderCommand("codex", { engines } as never)).file).toBe(CODEX_BIN);
  });

  it("says the CLI is missing rather than starting a PTY that would die at once", async () => {
    process.env.PATH = BIN_DIR;
    const missing = { ...ENGINES, claude: { ...ENGINES.claude, bin: "/opt/provider-auth-test/missing" }, codex: { ...ENGINES.codex, bin: "no-such-cli" } };

    await expect(resolveProviderCommand("claude", { engines: missing })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(resolveProviderCommand("codex", { engines: missing })).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("spawnLoginPty", () => {
  beforeEach(() => { spawn.mockClear(); });
  afterAll(() => { process.removeListener("exit", killLiveLoginPtys); });
  const options = { name: "xterm-256color", cols: 2000, rows: 50, cwd: "/work", env: { HOME: "/home/ryoko" } };
  function fakePty() {
    let exited: (() => void) | undefined;
    return {
      write: vi.fn(), kill: vi.fn(), onData: vi.fn(),
      onExit: vi.fn((handler: () => void) => { exited = handler; }),
      exit: () => exited?.(),
    };
  }

  it("kills, when the process exits, every login CLI that is still running — and only those", async () => {
    const guardsBefore = process.listenerCount("exit");
    const [gone, alive, stubborn] = [fakePty(), fakePty(), fakePty()];
    for (const pty of [gone, alive, stubborn]) {
      spawn.mockReturnValueOnce(pty);
      await spawnLoginPty("/opt/bin/codex", ["login", "--device-auth"], options);
    }
    // One guard for the process, however many logins were started.
    expect(process.listenerCount("exit") - guardsBefore).toBe(1);
    expect(process.listeners("exit")).toContain(killLiveLoginPtys);

    gone.exit();
    stubborn.kill.mockImplementation(() => { throw new Error("ESRCH"); });
    expect(() => killLiveLoginPtys()).not.toThrow();

    expect(gone.kill).not.toHaveBeenCalled();
    expect(alive.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(stubborn.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("starts the CLI in a PTY with exactly the given arguments, directory and environment", async () => {
    const pty = fakePty();
    spawn.mockReturnValueOnce(pty);

    expect(await spawnLoginPty("/opt/bin/claude", ["auth", "login", "--claudeai"], options)).toBe(pty);
    expect(spawn).toHaveBeenCalledExactlyOnceWith("/opt/bin/claude", ["auth", "login", "--claudeai"], options);
  });
});

describe("runStatusCommand", () => {
  const env = { PATH: process.env.PATH ?? "", MARK: "from-env" };
  const cwd = fs.realpathSync(os.tmpdir());

  it("returns the child's output and exit status, run with the given environment and directory", async () => {
    const script = "process.stdout.write(process.env.MARK + '|' + process.cwd() + '|' + String(process.env.HOME)); process.exit(7)";
    const result = await runStatusCommand(process.execPath, ["-e", script], { env, cwd, timeoutMs: 10_000 });

    expect(result).toEqual({ stdout: `from-env|${cwd}|undefined`, stderr: "", exitCode: 7 });
  });

  it("returns what the command wrote to stderr as well", async () => {
    const result = await runStatusCommand(process.execPath, ["-e", "console.error('Logged in using ChatGPT')"], { env, cwd, timeoutMs: 10_000 });
    expect(result).toEqual({ stdout: "", stderr: "Logged in using ChatGPT\n", exitCode: 0 });
  });

  it("reports success as exit status 0", async () => {
    const result = await runStatusCommand(process.execPath, ["-e", "console.log('{\"loggedIn\":true}')"], { env, cwd, timeoutMs: 10_000 });
    expect(result).toEqual({ stdout: '{"loggedIn":true}\n', stderr: "", exitCode: 0 });
  });

  it("answers non-zero when the command cannot be started", async () => {
    const result = await runStatusCommand("/opt/provider-auth-test/missing", [], { env, cwd, timeoutMs: 10_000 });
    expect(result.exitCode).not.toBe(0);
  });

  it("ends a command that hangs, even one that ignores SIGTERM", async () => {
    const script = "process.on('SIGTERM', () => {}); process.stdout.write('started'); setInterval(() => {}, 1000)";
    const startedAt = Date.now();
    const result = await runStatusCommand(process.execPath, ["-e", script], { env, cwd, timeoutMs: 400 });

    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
