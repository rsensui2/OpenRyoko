import path from "node:path";

export type ArchiveEntryType = "file" | "directory" | "symlink";

interface ArchiveTarget {
  kind: string;
  /** Home-relative files and directories, taken whole when they exist. */
  paths: readonly string[];
  /** Files directly in the home whose name matches, on top of `paths`. Never a directory. */
  topLevelFiles?: RegExp;
}

/**
 * A Markdown file directly in the home. Matched by what it is rather than by a
 * list of names: the instruction and persona files the template ships are
 * here, and so are BOOTSTRAP.md and whatever documents an operator keeps
 * beside them, which no list could have named in advance. A retired copy such
 * as `AGENTS.md.bak-20261001` does not end in `.md` and stays out.
 */
const DOCUMENT_IN_HOME = /^[^/]+\.md$/;

/**
 * What a home archive holds, and the names `ryoko backup restore --only` takes.
 *
 * This is the one list. The archive writer walks it, restore maps every entry
 * back to a kind through it, and nothing outside it is ever written into a home:
 * an archive entry that falls under none of these is ignored on restore,
 * whoever put it there.
 *
 * A path named here wins over the pattern, which is how MEMORY.md stays with
 * the memory while every other document in the home is persona. `.env` rides
 * with the config: some operators keep their scripts' keys there, and the
 * archive already carries the tokens in config.yaml.
 *
 * Deliberately absent: `logs/`, `tmp/`, `files/` (uploads), `backups/`,
 * `.migration-backups/`, `sessions/` and the SQLite files (the database backup
 * covers those with SQLite's own online copy), `cron/commands/` (run locks and
 * captured output), and the gateway's runtime and auth state - `credentials/`,
 * `connectors/`, `.whatsapp-auth`, `gateway-auth.json`, `auth-devices.json`.
 * Auth state is not something anyone edits; after a total loss it is
 * re-established, not restored.
 */
export const HOME_ARCHIVE_TARGETS = [
  { kind: "config", paths: ["config.yaml", ".env"] },
  { kind: "cron", paths: ["cron/jobs.json"] },
  { kind: "cron-history", paths: ["cron/runs"] },
  { kind: "persona", paths: [], topLevelFiles: DOCUMENT_IN_HOME },
  { kind: "memory", paths: ["MEMORY.md", "memory"] },
  { kind: "org", paths: ["org"] },
  { kind: "skills", paths: ["skills", "skills.json"] },
  { kind: "docs", paths: ["docs"] },
  { kind: "knowledge", paths: ["knowledge"] },
  { kind: "workflows", paths: ["workflows"] },
] as const satisfies readonly ArchiveTarget[];

export type BackupKind = (typeof HOME_ARCHIVE_TARGETS)[number]["kind"];

/** The name patterns the walker looks for directly in the home, with the kind each belongs to. */
export const TOP_LEVEL_FILE_TARGETS: readonly { kind: BackupKind; pattern: RegExp }[] = HOME_ARCHIVE_TARGETS
  .flatMap((target) => ("topLevelFiles" in target ? [{ kind: target.kind, pattern: target.topLevelFiles }] : []));

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

/**
 * The kind an archive entry belongs to, or null for one no target covers.
 * `type` matters only for the name patterns: a directory that happens to be
 * called `drafts.md` is not a document.
 */
export function kindOfPath(entryPath: string, type: ArchiveEntryType = "file"): BackupKind | null {
  for (const target of HOME_ARCHIVE_TARGETS) {
    for (const root of target.paths) {
      if (entryPath === root || entryPath.startsWith(`${root}/`)) return target.kind;
    }
  }
  if (type === "directory") return null;
  return TOP_LEVEL_FILE_TARGETS.find(({ pattern }) => pattern.test(entryPath))?.kind ?? null;
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
