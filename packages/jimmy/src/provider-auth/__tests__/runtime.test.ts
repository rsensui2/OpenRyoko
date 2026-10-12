import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node-pty", () => ({ spawn }));

import { buildClaudePtyEnv } from "../../engines/claude-interactive.js";
import { buildChildEnv } from "../../shared/childEnv.js";
import { JINN_HOME } from "../../shared/paths.js";
import { resolveProviderCommand, runStatusCommand, spawnLoginPty } from "../runtime.js";

const ENGINES = {
  default: "claude" as const,
  claude: { bin: "/opt/provider-auth-test/claude", model: "opus", interactive: true },
  codex: { bin: "/opt/provider-auth-test/codex", model: "gpt" },
};

describe("resolveProviderCommand", () => {
  const touched = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CONFIG_DIR",
    "CODEX_HOME", "CODEX_SANDBOX", "CODEX",
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
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
  });

  it("gives the Claude login the interactive engine's environment", async () => {
    const command = await resolveProviderCommand("claude", { engines: ENGINES });

    expect(command.file).toBe("/opt/provider-auth-test/claude");
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

  it("gives the Codex login the Codex engine's environment — no CODEX_HOME override", async () => {
    const command = await resolveProviderCommand("codex", { engines: ENGINES });

    expect(command.file).toBe("/opt/provider-auth-test/codex");
    expect(command.cwd).toBe(JINN_HOME);
    expect(command.env).toEqual(buildChildEnv({ stripPrefixes: ["CODEX_"], stripExact: ["CODEX"] }));
    expect(command.env.HOME).toBe(process.env.HOME);
    expect(Object.keys(command.env).filter((key) => key === "CODEX" || key.startsWith("CODEX_"))).toEqual([]);
  });

  it("falls back to the CLI's own name when no bin is configured", async () => {
    const engines = { default: "claude" as const, claude: { model: "opus" }, codex: { model: "gpt" } };
    const claude = await resolveProviderCommand("claude", { engines } as never);
    const codex = await resolveProviderCommand("codex", { engines } as never);

    expect(path.basename(claude.file)).toBe("claude");
    expect(path.basename(codex.file)).toBe("codex");
  });
});

describe("spawnLoginPty", () => {
  it("starts the CLI in a PTY with exactly the given arguments, directory and environment", async () => {
    const pty = { write: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    spawn.mockReturnValueOnce(pty);
    const options = { name: "xterm-256color", cols: 2000, rows: 50, cwd: "/work", env: { HOME: "/home/ryoko" } };

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

    expect(result).toEqual({ stdout: `from-env|${cwd}|undefined`, exitCode: 7 });
  });

  it("reports success as exit status 0", async () => {
    const result = await runStatusCommand(process.execPath, ["-e", "console.log('{\"loggedIn\":true}')"], { env, cwd, timeoutMs: 10_000 });
    expect(result).toEqual({ stdout: '{"loggedIn":true}\n', exitCode: 0 });
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
