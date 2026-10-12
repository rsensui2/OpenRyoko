import { execFile } from "node:child_process";
import { buildChildEnv } from "../shared/childEnv.js";
import { loadConfig } from "../shared/config.js";
import { JINN_HOME } from "../shared/paths.js";
import { tryResolveBin } from "../shared/resolveBin.js";
import type { JinnConfig } from "../shared/types.js";
import type { AuthClock, AuthProvider, AuthPty, ProviderCommand, RunCommand, SpawnPty } from "./types.js";

/**
 * How a provider's login CLI is run for real.
 *
 * A login is only useful if the credentials land where the engine will read
 * them, so the binary and the environment are taken from the same place the
 * engine takes them: `engines.<name>.bin`, and the very function that builds
 * that engine's environment. In particular the Codex engine drops every
 * `CODEX_*` variable — `CODEX_HOME` included — so the login must as well, or
 * it would write to a directory the engine never opens.
 *
 * node-pty and the interactive engine are loaded on first use: importing this
 * module (every Slack connector does) must not load a native addon.
 */

/** A PTY starts even when its program does not exist — the child just exits 1.
 *  Finding the binary first lets the operator hear "the CLI is missing". */
function locate(bin: string): string {
  const file = tryResolveBin(bin);
  if (!file) throw Object.assign(new Error("login CLI not found"), { code: "ENOENT" });
  return file;
}

export async function resolveProviderCommand(
  provider: AuthProvider,
  config: Pick<JinnConfig, "engines"> = loadConfig(),
): Promise<ProviderCommand> {
  if (provider === "codex") {
    return {
      file: locate(config.engines?.codex?.bin || "codex"),
      env: buildChildEnv({ stripPrefixes: ["CODEX_"], stripExact: ["CODEX"] }),
      cwd: JINN_HOME,
    };
  }
  const file = locate(config.engines?.claude?.bin || "claude");
  if (config.engines?.claude?.interactive !== true) return { file, env: buildChildEnv(), cwd: JINN_HOME };
  const { buildClaudePtyEnv } = await import("../engines/claude-interactive.js");
  return { file, env: buildClaudePtyEnv(undefined, process.env), cwd: JINN_HOME };
}

/** Login CLIs that are still running, whichever flow started them. */
const livePtys = new Set<AuthPty>();
let exitGuardInstalled = false;

/**
 * The last resort: no login CLI survives the gateway process. Shutdown stops
 * them long before this runs; it matters when the process leaves by another
 * door — a forced exit after a hung cleanup, an uncaught error. Synchronous,
 * as an exit handler has to be.
 */
export function killLiveLoginPtys(): void {
  for (const pty of livePtys) {
    try {
      pty.kill("SIGKILL");
    } catch { /* already gone */ }
  }
  livePtys.clear();
}

export const spawnLoginPty: SpawnPty = async (file, args, options) => {
  const { spawn } = await import("node-pty");
  const pty = spawn(file, [...args], options);
  livePtys.add(pty);
  pty.onExit(() => { livePtys.delete(pty); });
  if (!exitGuardInstalled) {
    exitGuardInstalled = true;
    process.on("exit", killLiveLoginPtys);
  }
  return pty;
};

/**
 * Runs a provider's status command and reports its exit status and what it
 * printed. It always resolves: a command that cannot start, fails, or hangs
 * past the timeout answers non-zero. The timeout kills outright, because a
 * status probe that ignores SIGTERM would otherwise hold its login flow open.
 */
export const runStatusCommand: RunCommand = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer: 256 * 1024,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          exitCode: !error ? 0 : typeof code === "number" ? code : 1,
        });
      },
    );
  });

/** Timers never keep the gateway process alive on their own. */
export const SYSTEM_CLOCK: AuthClock = {
  now: () => Date.now(),
  setTimeout: (handler, delayMs) => {
    const handle = setTimeout(handler, delayMs);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
