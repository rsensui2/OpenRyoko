import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "./logger.js";

/**
 * Claude Code's "auto memory" keeps a per-project notes directory under
 * `~/.claude/projects/<key>/memory/` and loads its MEMORY.md index into every
 * session started in that project.
 *
 * For a gateway instance that is a second memory tree with the wrong
 * properties: only the Claude engine sees it (Codex and Gemini sessions do
 * not), and its index is loaded for every speaker, bypassing the MEMORY.md
 * privacy gate (see isMemoryEligible in sessions/context.ts). The instance's
 * memory lives in JINN_HOME (MEMORY.md + knowledge/), so gateway-run Claude
 * sessions turn auto memory off unless the operator opts in.
 *
 * An instance that already accumulated auto memory keeps it enabled until the
 * notes are migrated: switching it off on upgrade would silently hide them.
 */

const DISABLE_ENV = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";

/** Claude Code names a project directory after its path with every
 *  non-alphanumeric character replaced by a dash. (Keys longer than 200
 *  characters get a hash suffix there; such paths are not detected here.) */
export function claudeProjectKey(projectDir: string): string {
  return projectDir.replace(/[^a-zA-Z0-9]/g, "-");
}

function realpathOrSelf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * The repository root Claude Code would key the project by, or undefined
 * outside a repository. A worktree resolves to its main repository, which is
 * why sibling worktrees share one memory directory.
 */
export function findGitRoot(dir: string): string | undefined {
  let current = realpathOrSelf(dir);
  for (;;) {
    const dotGit = path.join(current, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return current;
    if (stat?.isFile()) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(readTextOrEmpty(dotGit))?.[1]?.trim();
      const worktreeOf = gitdir && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(path.resolve(current, gitdir));
      return worktreeOf ? worktreeOf[1] : current;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readTextOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

/** `autoMemoryDirectory` from a Claude settings file, if it sets one. */
function configuredMemoryDirectory(settingsFile: string): string | undefined {
  try {
    const value = (JSON.parse(fs.readFileSync(settingsFile, "utf-8")) as { autoMemoryDirectory?: unknown }).autoMemoryDirectory;
    if (typeof value !== "string" || !value.trim()) return undefined;
    return value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value;
  } catch {
    return undefined;
  }
}

/**
 * Every place Claude Code may keep auto memory for a session working in `cwd`:
 * a directory chosen in settings, the repository root's project, and the cwd's
 * own project. Detection checks all of them, because guessing the single
 * "right" one wrong would hide existing notes without a word.
 */
export function claudeAutoMemoryCandidates(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const realCwd = realpathOrSelf(cwd);
  const gitRoot = findGitRoot(realCwd);
  const projectMemory = (dir: string) => path.join(configDir, "projects", claudeProjectKey(dir), "memory");
  const candidates = [
    configuredMemoryDirectory(path.join(configDir, "settings.json")),
    configuredMemoryDirectory(path.join(realCwd, ".claude", "settings.local.json")),
    gitRoot && projectMemory(gitRoot),
    projectMemory(realCwd),
  ].filter((dir): dir is string => Boolean(dir));
  return [...new Set(candidates)];
}

/** True when the directory holds notes that were never moved into JINN_HOME.
 *  A symlink means the notes were migrated and the old path kept only so
 *  existing references still resolve. */
export function hasLegacyAutoMemory(memoryDir: string): boolean {
  try {
    if (fs.lstatSync(memoryDir).isSymbolicLink()) return false;
    return fs.readdirSync(memoryDir).some((name) => name.endsWith(".md"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`Could not inspect Claude auto memory at ${memoryDir}: ${err instanceof Error ? err.message : err}`);
    }
    return false;
  }
}

export function legacyAutoMemoryDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return claudeAutoMemoryCandidates(cwd, env).find(hasLegacyAutoMemory);
}

/** `configured` is `engines.claude.autoMemory`; undefined means "decide for me". */
export function resolveClaudeAutoMemoryEnabled(configured: boolean | undefined, hasLegacyNotes: boolean): boolean {
  return typeof configured === "boolean" ? configured : hasLegacyNotes;
}

export function claudeAutoMemoryEnv(enabled: boolean): Record<string, string> {
  return enabled ? {} : { [DISABLE_ENV]: "1" };
}

let configuredAutoMemory: boolean | undefined;
const warnedLegacyDirs = new Set<string>();

/** Called by the gateway at boot and on config reload. A long-lived Claude
 *  process keeps the value it was spawned with; a change applies to new ones. */
export function configureClaudeAutoMemory(configured: unknown): void {
  if (configured !== undefined && configured !== null && typeof configured !== "boolean") {
    logger.warn(
      `engines.claude.autoMemory must be true or false (got ${JSON.stringify(configured)}) — ignoring it and deciding automatically.`,
    );
  }
  configuredAutoMemory = typeof configured === "boolean" ? configured : undefined;
}

/** Extra env for a locally spawned Claude process working in `cwd`. */
export function claudeAutoMemoryEnvFor(cwd: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (typeof configuredAutoMemory === "boolean") return claudeAutoMemoryEnv(configuredAutoMemory);
  const legacyDir = legacyAutoMemoryDir(cwd, env);
  if (legacyDir && !warnedLegacyDirs.has(legacyDir)) {
    warnedLegacyDirs.add(legacyDir);
    logger.warn(
      `Claude auto memory holds notes at ${legacyDir} — only Claude sessions see them, and their index is loaded for every speaker. ` +
        "It stays enabled so nothing disappears; move the notes into the instance (see docs/memory.md) to switch it off.",
    );
  }
  return claudeAutoMemoryEnv(resolveClaudeAutoMemoryEnabled(undefined, Boolean(legacyDir)));
}

/** Test-only: forget the configured value and the one-shot warnings. */
export function resetClaudeAutoMemoryForTests(): void {
  configuredAutoMemory = undefined;
  warnedLegacyDirs.clear();
}
