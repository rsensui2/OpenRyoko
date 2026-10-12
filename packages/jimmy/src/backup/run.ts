import type Database from "better-sqlite3";
import fs from "node:fs";
import {
  createDailyDatabaseBackup,
  dailyDatabaseBackupFile,
  DatabaseCopyDamagedError,
  type DatabaseBackupName,
} from "../sessions/backup.js";
import { ensureOwnerOnlyDirectory } from "../shared/owner-only.js";
import { getDiskSpaceStatus, type DiskSpaceStatus } from "../shared/storage-health.js";
import { ArchiveTooLargeError, createHomeArchive, NothingToArchiveError } from "./archive.js";
import { pruneBackups, reserveArchiveName } from "./catalog.js";
import { INCLUDE_DATABASES_FLAG, type DatabaseSource, type WithheldReason } from "./database-source.js";
import { errorMessage } from "./format.js";
import { databasePath } from "./layout.js";
import { archiveLimits, type BackupSettings } from "./settings.js";
import { fileBytes, insufficientSpace } from "./space.js";

/** What one run can back up, in the order it does so. */
export const BACKUP_TARGETS = ["home", "sessions", "workflows"] as const;
export type BackupTargetName = (typeof BACKUP_TARGETS)[number];

export interface BackupTargetReport {
  name: BackupTargetName;
  /**
   * "skipped" is not a failure: there was nothing to do (no such database, or
   * today's copy exists). "withheld" is neither a result nor an attempt: the
   * database is there, has no copy for today, and was deliberately not opened.
   */
  status: "ok" | "skipped" | "withheld" | "failed";
  file?: string;
  bytes?: number;
  /** Why a skipped or withheld target wrote nothing. */
  detail?: string;
  /** With "withheld": which of the reasons for leaving a database alone applied. */
  reason?: WithheldReason;
  /** For a database whose copy for today was already there: when that copy was made. */
  copiedAt?: string;
  error?: string;
  /**
   * Set on a failure that trying again cannot change: a home over the size cap
   * is over it an hour later too, and stays so until the operator raises the
   * cap or moves the bulk out. The scheduler leaves these for the next daily
   * run instead of retrying every hour.
   */
  persistent?: true;
  warnings: string[];
}

export interface BackupRunReport {
  directory: string;
  startedAt: string;
  finishedAt: string;
  /**
   * "incomplete": nothing failed, but a database that was asked for was left
   * alone because a gateway appears to be running. A database nobody asked
   * for does not make a run incomplete.
   */
  status: "ok" | "incomplete" | "failed";
  targets: BackupTargetReport[];
  /** Files retention removed. */
  pruned: string[];
}

export interface BackupRunOptions {
  home: string;
  settings: BackupSettings;
  now: Date;
  /** Default: every target. The gateway's scheduler passes only the ones that are due. */
  targets?: readonly BackupTargetName[];
  /**
   * Where each database is read from. There is no default: a database with no
   * source here is not opened at all, and is reported as withheld. Whether it
   * is safe to open a database file is for the caller to have decided.
   */
  databases?: Partial<Record<DatabaseBackupName, DatabaseSource>>;
  /** The existing free-space judgement, replaceable in tests. */
  diskSpace?: (directory: string) => DiskSpaceStatus;
  /** What is wrong with a database copy, replaceable in tests. Default: SQLite's integrity check, off this thread. */
  checkDatabaseCopy?: (file: string) => Promise<string[]>;
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

/**
 * Refuses to start a write that would not leave the gateway room to work. The
 * check made before the run only asks whether the disk is low now; this asks
 * about the disk after `bytes` more, on top of what the run has already put there.
 */
function requireRoom(options: BackupRunOptions, bytes: number, written: number): void {
  const reason = insufficientSpace(options.settings.directory, bytes, options.diskSpace, written);
  if (reason) throw new Error(reason);
}

async function backupHome(options: BackupRunOptions, written: number): Promise<BackupTargetReport> {
  const { directory } = options.settings;
  const { id, file } = reserveArchiveName(directory, "home", options.now);
  const result = await createHomeArchive({
    home: options.home,
    destination: file,
    id,
    createdAt: options.now,
    limits: archiveLimits(options.settings),
    excludePaths: [directory],
    beforeWrite: ({ bytes }) => requireRoom(options, bytes, written),
  });
  return { name: "home", status: "ok", file: result.file, bytes: result.bytes, warnings: result.warnings };
}

/** What a copy of this database can take: its main file and whatever is still in its WAL. */
function databaseBytes(database: Database.Database): number {
  return database.memory ? 0 : fileBytes(database.name) + fileBytes(`${database.name}-wal`);
}

function alreadyCopied(name: DatabaseBackupName, file: string): BackupTargetReport {
  return { name, status: "skipped", file, detail: "already copied today", warnings: [], copiedAt: fs.statSync(file).mtime.toISOString() };
}

const absent = (name: DatabaseBackupName): BackupTargetReport =>
  ({ name, status: "skipped", detail: "no database in this home", warnings: [] });

/** A database the run was handed no source for. Whether there is one at all is read from the directory, not by opening it. */
function notHandedOver(name: DatabaseBackupName, options: BackupRunOptions): BackupTargetReport {
  if (!fs.existsSync(databasePath(options.home, name))) return absent(name);
  const daily = options.settings.enabled
    ? "The gateway copies it itself once a day"
    : "Daily backups are switched off (backup.enabled: false), so nothing is copying it";
  return {
    name, status: "withheld", reason: "not-requested", warnings: [],
    detail: `not opened: this run was not handed the database. ${daily}. `
      + `"ryoko backup run ${INCLUDE_DATABASES_FLAG}" copies it from the command line while the gateway is stopped`,
  };
}

/**
 * Copies one database, if there is a copy to make and a connection to make it
 * through. Asked in that order, so that a database is never opened for nothing:
 * with today's copy already there, its source is not so much as called.
 */
async function backupDatabase(name: DatabaseBackupName, options: BackupRunOptions, written: number): Promise<BackupTargetReport> {
  const todays = dailyDatabaseBackupFile(options.settings.directory, name, options.now);
  if (fs.existsSync(todays)) return alreadyCopied(name, todays);
  const source = options.databases?.[name];
  if (!source) return notHandedOver(name, options);
  const handle = source();
  if (!handle) return absent(name);
  if ("withheld" in handle) return { name, status: "withheld", reason: handle.withheld, detail: handle.detail, warnings: [] };
  try {
    const result = await createDailyDatabaseBackup(handle.database, {
      directory: options.settings.directory,
      now: options.now,
      name,
      beforeWrite: () => requireRoom(options, databaseBytes(handle.database), written),
      ...(options.checkDatabaseCopy ? { check: options.checkDatabaseCopy } : {}),
    });
    // Only if another run wrote today's copy in the moment since it was looked for.
    if (!result.created) return alreadyCopied(name, result.file);
    const warnings = result.unchecked === undefined ? [] : [`the copy was kept without being checked: ${result.unchecked}`];
    return { name, status: "ok", file: result.file, bytes: fs.statSync(result.file).size, warnings };
  } finally {
    handle.release();
  }
}

/**
 * True for a failure that follows from what the home holds, not from what
 * happened to go wrong this time. A copy that fails the integrity check is one
 * of them: it is made page for page, so the damage is in the database, and an
 * hour from now a copy of it will fail the same way.
 */
function failsTheSameWayAgain(error: unknown): boolean {
  return error instanceof ArchiveTooLargeError || error instanceof NothingToArchiveError || error instanceof DatabaseCopyDamagedError;
}

/** One target, with whatever it throws turned into its own failed report. `written` is what the run has put on disk so far. */
async function runTarget(name: BackupTargetName, options: BackupRunOptions, written: number): Promise<BackupTargetReport> {
  try {
    return name === "home" ? await backupHome(options, written) : await backupDatabase(name, options, written);
  } catch (error) {
    return {
      name, status: "failed", error: errorMessage(error), warnings: [],
      ...(failsTheSameWayAgain(error) ? { persistent: true as const } : {}),
    };
  }
}

/** Trims the directory to its retention, sparing whatever this run has just put there. */
function prune(options: BackupRunOptions, targets: BackupTargetReport[]): string[] {
  const keep = targets.flatMap((target) => (target.status === "ok" && target.file ? [target.file] : []));
  try {
    return pruneBackups(options.settings.directory, { retention: options.settings.retention, now: options.now, keep });
  } catch {
    return [];
  }
}

function statusOf(targets: BackupTargetReport[]): BackupRunReport["status"] {
  if (targets.some((target) => target.status === "failed")) return "failed";
  return targets.some((target) => target.status === "withheld" && target.reason === "gateway-running") ? "incomplete" : "ok";
}

/**
 * Backs up the running instance's home: an archive of its files, then a copy
 * of each database the caller hands over.
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
  let written = 0;
  for (const name of options.targets ?? BACKUP_TARGETS) {
    const report: BackupTargetReport = blocked
      ? { name, status: "failed", error: blocked, warnings: [] }
      : await runTarget(name, options, written);
    if (report.status === "ok") written += report.bytes ?? 0;
    targets.push(report);
  }
  return {
    directory: options.settings.directory,
    startedAt: options.now.toISOString(),
    finishedAt: new Date().toISOString(),
    status: statusOf(targets),
    targets,
    pruned: prune(options, targets),
  };
}
