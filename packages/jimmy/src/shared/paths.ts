import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * One-time migration: if the user has a legacy ~/.jinn/ but no ~/.ryoko/,
 * rename the entire directory in place. Runs at module load so every path
 * constant below already points at the migrated location. Any failure is
 * silent — resolveHome() still has a legacy fallback.
 */
function migrateLegacyHome(): void {
  if (process.env.RYOKO_HOME || process.env.JINN_HOME) return;
  if (process.env.RYOKO_INSTANCE || process.env.JINN_INSTANCE) return;
  const legacy = path.join(os.homedir(), ".jinn");
  const target = path.join(os.homedir(), ".ryoko");
  if (!fs.existsSync(legacy)) return;
  if (fs.existsSync(target)) return;
  try {
    fs.renameSync(legacy, target);
    console.log(`[openryoko] migrated ~/.jinn → ~/.ryoko`);
  } catch {
    /* leave legacy in place; resolveHome will still find it via fallback */
  }
}

migrateLegacyHome();

/**
 * Resolve the home directory for the current instance.
 * Precedence: RYOKO_HOME > JINN_HOME (legacy) > RYOKO_INSTANCE > JINN_INSTANCE >
 *             ~/.ryoko (falls back to ~/.jinn if ~/.ryoko doesn't exist yet).
 */
function resolveHome(): string {
  if (process.env.RYOKO_HOME) return process.env.RYOKO_HOME;
  if (process.env.JINN_HOME) return process.env.JINN_HOME;
  const instance = process.env.RYOKO_INSTANCE || process.env.JINN_INSTANCE;
  if (instance) return path.join(os.homedir(), `.${instance}`);
  const ryokoHome = path.join(os.homedir(), ".ryoko");
  const jinnHome = path.join(os.homedir(), ".jinn");
  if (fs.existsSync(ryokoHome)) return ryokoHome;
  if (fs.existsSync(jinnHome)) return jinnHome;
  return ryokoHome;
}

/**
 * JINN_HOME is kept as the exported constant name for backwards compatibility
 * with all internal callers. The actual value resolves to ~/.ryoko/ on new
 * installs and after the one-time migration above.
 */
export const JINN_HOME = resolveHome();

// Fail closed if a test run resolves into the user's home directory at all —
// that covers ~/.ryoko, ~/.jinn, and every custom instance home (TBCare-style
// installs included). Vitest sets VITEST in every worker; a legitimate test
// home always lives under the OS temp directory.
if (process.env.VITEST && (JINN_HOME === os.homedir() || JINN_HOME.startsWith(os.homedir() + path.sep))) {
  throw new Error(
    `Test run resolved JINN_HOME inside the real home directory (${JINN_HOME}). `
    + "The vitest globalSetup must redirect JINN_HOME to a temp directory before any import.",
  );
}

/** Upstream-parity alias: resolve the (possibly overridden) home directory. */
export function resolveJinnHome(): string {
  return resolveHome();
}
export const CONFIG_PATH = path.join(JINN_HOME, "config.yaml");
export const SESSIONS_DB = path.join(JINN_HOME, "sessions", "registry.db");
export const WORKFLOWS_DIR = path.join(JINN_HOME, "workflows");
export const WORKFLOWS_DB_PATH = path.join(WORKFLOWS_DIR, "workflows.db");
export const CRON_JOBS = path.join(JINN_HOME, "cron", "jobs.json");
export const CRON_RUNS = path.join(JINN_HOME, "cron", "runs");
export const UPDATE_STATE = path.join(JINN_HOME, "updates", "state.json");
export const ORG_DIR = path.join(JINN_HOME, "org");
export const SKILLS_DIR = path.join(JINN_HOME, "skills");
export const DOCS_DIR = path.join(JINN_HOME, "docs");
export const LOGS_DIR = path.join(JINN_HOME, "logs");
export const TMP_DIR = path.join(JINN_HOME, "tmp");
export const JOBS_DIR = path.join(JINN_HOME, "jobs");
export const MODELS_DIR = path.join(JINN_HOME, "models");
export const STT_MODELS_DIR = path.join(JINN_HOME, "models", "whisper");
export const PID_FILE = path.join(JINN_HOME, "gateway.pid");
export const CLAUDE_SKILLS_DIR = path.join(JINN_HOME, ".claude", "skills");
export const AGENTS_SKILLS_DIR = path.join(JINN_HOME, ".agents", "skills");
/** Resolves for both layouts: dist/src/shared/ (built package) and
 *  src/shared/ (vitest / ts-node running from source). */
export const TEMPLATE_DIR = (() => {
  const candidates = [
    path.join(__dirname, "..", "..", "..", "template"),
    path.join(__dirname, "..", "..", "template"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
})();
export const FILES_DIR = path.join(JINN_HOME, "files");
export const MIGRATIONS_DIR = path.join(JINN_HOME, "migrations");
export const TEMPLATE_MIGRATIONS_DIR = path.join(TEMPLATE_DIR, "migrations");

// ---- Interactive Claude (PTY) engine: hook-relay + per-session --settings ----
/** Gateway connection info (port + hook secret + pids) for hook-relay discovery. */
export const GATEWAY_INFO_FILE = path.join(JINN_HOME, "gateway.json");
/** Per-session Claude Code --settings files written for PTY turns. */
export const CLAUDE_SETTINGS_DIR = path.join(JINN_HOME, "tmp", "settings");
/** Durable, bounded reconnect scrollback for interactive PTYs. */
export const PTY_SNAPSHOTS_DIR = path.join(JINN_HOME, "tmp", "pty-snapshots");
/** The hook-relay script copied next to JINN_HOME at boot; PTY-spawned Claude
 *  invokes it from its hook config to POST turn events back to the gateway. */
export const HOOK_RELAY_SCRIPT = path.join(JINN_HOME, "hook-relay.mjs");

/**
 * Global instances registry — always at ~/.ryoko/instances.json regardless
 * of which instance is running, so every instance can discover the others.
 * Falls back to ~/.jinn/ when only the legacy home exists.
 */
export const INSTANCES_REGISTRY = (() => {
  const ryoko = path.join(os.homedir(), ".ryoko", "instances.json");
  const jinn = path.join(os.homedir(), ".jinn", "instances.json");
  if (fs.existsSync(path.dirname(ryoko))) return ryoko;
  if (fs.existsSync(path.dirname(jinn))) return jinn;
  return ryoko;
})();
