import { logger } from "./logger.js";

let warnedRoot = false;

/**
 * Environment the gateway adds to every LOCAL Claude CLI it launches, on top of
 * the base child env. /logout in that CLI signs the shared account out from
 * under every session and the next spawn, so it is turned off wherever the
 * gateway or the CLI starts Claude locally — the interactive PTY, the headless
 * `claude -p`, the one-shot classifier/extractor, a session fork, a migration
 * run. /login is deliberately left on (web live-terminal recovery).
 *
 * NOT applied to a remote (sshHost) run: a value set here does not cross to the
 * remote process, and a /logout there is that host's own CLI, not ours.
 *
 * One source of truth so the launch sites cannot drift apart; a test enumerates
 * them (see claude-launch-env.test.ts).
 */
export const CLAUDE_LOCAL_ENV: Readonly<Record<string, string>> = { DISABLE_LOGOUT_COMMAND: "1" };

export interface BuildChildEnvOptions {
  /** Strip env keys whose name starts with any of these prefixes. */
  stripPrefixes?: string[];
  /** Strip env keys with these exact names. */
  stripExact?: string[];
}

/**
 * Build an env dict for spawning a child CLI.
 *
 * Always strips Claude Code's own runtime markers (CLAUDECODE, CLAUDE_CODE_*)
 * so a nested invocation doesn't think it's running inside another session.
 * Caller can pass extra prefixes/names (e.g. CODEX_*).
 *
 * If the current process is running as root, sets IS_SANDBOX=1 (when not
 * already set). Claude Code refuses to launch as root unless this is set,
 * which is a common foot-gun on Linux servers (e.g. systemd unit without
 * `User=…`, Docker containers running as root).
 */
export function buildChildEnv(opts: BuildChildEnvOptions = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const stripPrefixes = opts.stripPrefixes ?? [];
  const stripExact = new Set(opts.stripExact ?? []);

  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (stripExact.has(k)) continue;
    if (stripPrefixes.some((p) => k.startsWith(p))) continue;
    if (v !== undefined) env[k] = v;
  }

  if (isRunningAsRoot()) {
    if (!env.IS_SANDBOX) env.IS_SANDBOX = "1";
    if (!warnedRoot) {
      warnedRoot = true;
      logger.warn(
        "Running OpenRyoko as root — injected IS_SANDBOX=1 so the Claude CLI won't refuse. " +
          "Strongly recommended: run under a dedicated unprivileged user (set User=… in your systemd unit).",
      );
    }
  }

  return env;
}

function isRunningAsRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/** Test-only: reset the one-shot root warning. */
export function _resetRootWarn(): void {
  warnedRoot = false;
}
