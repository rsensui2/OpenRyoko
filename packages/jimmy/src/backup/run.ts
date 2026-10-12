import Database from "better-sqlite3";
import fs from "node:fs";
import { createDailyDatabaseBackup, type DatabaseBackupName } from "../sessions/backup.js";
import { ensureOwnerOnlyDirectory } from "../shared/owner-only.js";
import { getDiskSpaceStatus, type DiskSpaceStatus } from "../shared/storage-health.js";
import { createHomeArchive } from "./archive.js";
import { pruneBackups, reserveArchiveName } from "./catalog.js";
import { errorMessage } from "./format.js";
import { databasePath } from "./layout.js";
import type { BackupSettings } from "./settings.js";

/** What one run can back up, in the order it does so. */
export const BACKUP_TARGETS = ["home", "sessions", "workflows"] as const;
export type BackupTargetName = (typeof BACKUP_TARGETS)[number];

export interface BackupTargetReport {
  name: BackupTargetName;
  /** "skipped" is not a failure: there was nothing to do (no such database, or today's copy exists). */
  status: "ok" | "skipped" | "failed";
  file?: string;
  bytes?: number;
  /** Why a skipped target wrote nothing. */
  detail?: string;
  error?: string;
  warnings: string[];
}

export interface BackupRunReport {
  directory: string;
  startedAt: string;
  finishedAt: string;
  status: "ok" | "failed";
  targets: BackupTargetReport[];
  /** Files retention removed. */
  pruned: string[];
}

/** A database to copy, and how to give it back. */
export interface DatabaseHandle {
  database: Database.Database;
  release(): void;
}

/** Returns null when the home has no such database. */
export type DatabaseSource = () => DatabaseHandle | null;

export interface BackupRunOptions {
  home: string;
  settings: BackupSettings;
  now: Date;
  /** Default: every target. The gateway's scheduler passes only the ones that are due. */
  targets?: readonly BackupTargetName[];
  /** Where a database comes from. Default: a read-only connection to the file inside `home`. */
  databases?: Partial<Record<DatabaseBackupName, DatabaseSource>>;
  /** The existing free-space judgement, replaceable in tests. */
  diskSpace?: (directory: string) => DiskSpaceStatus;
}

/**
 * Opens a database read-only for copying. A second connection, even from
 * another process, cannot checkpoint or delete the WAL of a database the
 * gateway has open - which a read-write one would do on close if it believed
 * itself the last.
 */
export function readOnlyDatabaseSource(file: string): DatabaseSource {
  return () => {
    if (!fs.existsSync(file)) return null;
    const database = new Database(file, { readonly: true, fileMustExist: true });
    return { database, release: () => { database.close(); } };
  };
}

/** Why nothing can be written this run, or null when the directory is ready. */
function blockedReason(options: BackupRunOptions): string | null {
  const { directory, defaultDirectory } = options.settings;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // The instance's own backups/ is kept owner-only like the rest of its home.
    // A directory the operator chose is used as found: it may be shared, and on
    // an instance running as root a chmod of a mistyped path is not a risk to take.
    if (defaultDirectory) ensureOwnerOnlyDirectory(directory);
  } catch (error) {
    return `the backup directory cannot be used: ${errorMessage(error)}`;
  }
  const disk = (options.diskSpace ?? getDiskSpaceStatus)(directory);
  if (disk.level !== "critical") return null;
  const free = disk.freeBytes === null ? "unknown" : Math.floor(disk.freeBytes / 1024 ** 2);
  return `not enough free disk space to write a backup (${free} MiB free in ${directory})`;
}

async function backupHome(options: BackupRunOptions): Promise<BackupTargetReport> {
  const { directory, maxArchiveBytes } = options.settings;
  const { id, file } = reserveArchiveName(directory, "home", options.now);
  const result = await createHomeArchive({
    home: options.home,
    destination: file,
    id,
    createdAt: options.now,
    maxBytes: maxArchiveBytes,
    excludePaths: [directory],
  });
  return { name: "home", status: "ok", file: result.file, bytes: result.bytes, warnings: result.warnings };
}

async function backupDatabase(name: DatabaseBackupName, options: BackupRunOptions): Promise<BackupTargetReport> {
  const source = options.databases?.[name] ?? readOnlyDatabaseSource(databasePath(options.home, name));
  const handle = source();
  if (!handle) return { name, status: "skipped", detail: "no database in this home", warnings: [] };
  try {
    const result = await createDailyDatabaseBackup(handle.database, { directory: options.settings.directory, now: options.now, name });
    if (!result.created) return { name, status: "skipped", file: result.file, detail: "already copied today", warnings: [] };
    return { name, status: "ok", file: result.file, bytes: fs.statSync(result.file).size, warnings: [] };
  } finally {
    handle.release();
  }
}

/** One target, with whatever it throws turned into its own failed report. */
async function runTarget(name: BackupTargetName, options: BackupRunOptions): Promise<BackupTargetReport> {
  try {
    return name === "home" ? await backupHome(options) : await backupDatabase(name, options);
  } catch (error) {
    return { name, status: "failed", error: errorMessage(error), warnings: [] };
  }
}

function prune(options: BackupRunOptions): string[] {
  try {
    return pruneBackups(options.settings.directory, { retention: options.settings.retention, now: options.now });
  } catch {
    return [];
  }
}

/**
 * Backs up the running instance's home: an archive of its files, then a copy
 * of each database.
 *
 * Targets are independent. One failing is recorded in its own report and the
 * rest still run, so a home too large to archive does not cost the registry
 * its copy, nor the other way round. Retention runs afterwards either way: a
 * run that could not write is exactly when a lowered `retention` should still
 * free the space it was lowered to free.
 */
export async function runBackup(options: BackupRunOptions): Promise<BackupRunReport> {
  const blocked = blockedReason(options);
  const targets: BackupTargetReport[] = [];
  for (const name of options.targets ?? BACKUP_TARGETS) {
    targets.push(blocked ? { name, status: "failed", error: blocked, warnings: [] } : await runTarget(name, options));
  }
  return {
    directory: options.settings.directory,
    startedAt: options.now.toISOString(),
    finishedAt: new Date().toISOString(),
    status: targets.some((target) => target.status === "failed") ? "failed" : "ok",
    targets,
    pruned: prune(options),
  };
}
