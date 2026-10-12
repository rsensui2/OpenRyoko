import path from "node:path";

/**
 * What a home archive holds, and the names `ryoko backup restore --only` takes.
 *
 * This is the one list. The archive writer walks it, restore maps every entry
 * back to a kind through it, and nothing outside it is ever written into a home:
 * an archive entry that falls under none of these paths is ignored on restore,
 * whoever put it there.
 *
 * Deliberately absent: `logs/`, `tmp/`, `files/` (uploads), `backups/`,
 * `.migration-backups/`, `sessions/` and the SQLite files (the database backup
 * covers those with SQLite's own online copy), `cron/commands/` (run locks and
 * captured output), `BOOTSTRAP.md` (a one-shot file - restoring it would start
 * onboarding again) and the gateway's runtime and auth state.
 */
export const HOME_ARCHIVE_TARGETS = [
  { kind: "config", paths: ["config.yaml"] },
  { kind: "cron", paths: ["cron/jobs.json"] },
  { kind: "cron-history", paths: ["cron/runs"] },
  { kind: "persona", paths: ["AGENTS.md", "CLAUDE.md", "SOUL.md", "IDENTITY.md", "TOOLS.md"] },
  { kind: "memory", paths: ["MEMORY.md", "memory"] },
  { kind: "org", paths: ["org"] },
  { kind: "skills", paths: ["skills", "skills.json"] },
  { kind: "docs", paths: ["docs"] },
  { kind: "knowledge", paths: ["knowledge"] },
  { kind: "workflows", paths: ["workflows"] },
] as const;

export type BackupKind = (typeof HOME_ARCHIVE_TARGETS)[number]["kind"];

export const BACKUP_KINDS: readonly BackupKind[] = HOME_ARCHIVE_TARGETS.map((target) => target.kind);

/**
 * Reproducible caches and nested checkouts, skipped at any depth. A skill that
 * vendors its own clone or virtualenv can outweigh the rest of the home, and
 * none of it is content the operator would lose.
 */
export const EXCLUDED_DIRECTORY_NAMES: readonly string[] = ["node_modules", ".git", ".venv", "__pycache__"];

/** The workflow store and its sidecars live beside files worth archiving. */
const WORKFLOW_DATABASE_FILE = /^workflows\/[^/]+\.db(-wal|-shm|-journal)?$/;

/** Where the manifest rides inside the archive. Not a home path, so it can never collide with one. */
export const MANIFEST_ENTRY_PATH = ".backup-manifest.json";

/** True for a home-relative path the walker must leave out of the archive. */
export function isExcludedPath(relativePath: string, isDirectory: boolean): boolean {
  if (isDirectory) return EXCLUDED_DIRECTORY_NAMES.includes(relativePath.split("/").pop() ?? "");
  return WORKFLOW_DATABASE_FILE.test(relativePath);
}

/** The kind an archive entry belongs to, or null for one no target covers. */
export function kindOfPath(entryPath: string): BackupKind | null {
  for (const target of HOME_ARCHIVE_TARGETS) {
    for (const root of target.paths) {
      if (entryPath === root || entryPath.startsWith(`${root}/`)) return target.kind;
    }
  }
  return null;
}

/**
 * Why an archive entry path must not be trusted, or null when it is the plain
 * relative form the writer produces. Anything else - absolute, climbing out with
 * `..`, or merely not canonical - is refused rather than normalized: a path that
 * needs interpreting is a path that can be interpreted two ways.
 */
export function unsafePathReason(entryPath: string): string | null {
  if (entryPath === "") return "empty";
  if (entryPath.includes("\0")) return "contains a NUL byte";
  if (entryPath.startsWith("/")) return "absolute";
  // On Windows a backslash separates and a colon names a drive; on POSIX both
  // are ordinary characters a real file may carry.
  if (path.sep === "\\" && /[\\:]/.test(entryPath)) return "contains a Windows path separator or drive";
  for (const segment of entryPath.split("/")) {
    if (segment === "") return "contains an empty segment";
    if (segment === "." || segment === "..") return `contains a "${segment}" segment`;
  }
  return null;
}
