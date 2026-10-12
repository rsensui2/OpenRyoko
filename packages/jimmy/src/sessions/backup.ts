import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { JINN_HOME } from "../shared/paths.js";
import { findDatabaseProblems } from "./backup-integrity.js";

/** The databases that get a daily copy, and the prefix each one's files carry. */
export type DatabaseBackupName = "sessions" | "workflows";

export const DATABASE_BACKUP_RETENTION = 7;

/** Sidecars SQLite leaves beside a WAL-mode file once anything has opened it. */
export const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

export function databaseBackupPattern(name: DatabaseBackupName): RegExp {
  return new RegExp(`^${name}-\\d{4}-\\d{2}-\\d{2}\\.db$`);
}

export interface BackupResult {
  created: boolean;
  file: string;
  /** Set when the copy was kept although the integrity check could not be run at all: why it could not. */
  unchecked?: string;
}

export interface DailyDatabaseBackupOptions {
  directory?: string;
  now?: Date;
  retention?: number;
  name?: DatabaseBackupName;
  /**
   * Called once it is settled that a copy will be written, just before it is.
   * Throwing calls the copy off with nothing on disk - the place to check that
   * there is room for it.
   */
  beforeWrite?: () => void;
  /**
   * What is wrong with a copy: an empty list when it is sound. Rejects when the
   * check could not be made at all. Default: SQLite's integrity check, on a
   * thread of its own.
   */
  check?: (file: string) => Promise<string[]>;
}

const MAX_PROBLEMS_QUOTED = 3;

/** A copy failed the integrity check. It has already been removed by the time this is thrown. */
export class DatabaseCopyDamagedError extends Error {
  constructor(readonly problems: string[]) {
    const shown = problems.slice(0, MAX_PROBLEMS_QUOTED).join("; ");
    const more = problems.length > MAX_PROBLEMS_QUOTED ? `; and ${problems.length - MAX_PROBLEMS_QUOTED} more` : "";
    super(
      `the copy failed SQLite's integrity check and was discarded (${shown}${more}). `
      + "A copy is made page for page, so the database itself may be damaged",
    );
    this.name = "DatabaseCopyDamagedError";
  }
}

/**
 * Holds a copy to the integrity check before it is given its name. Resolves to
 * undefined when it passed, and to the reason when the check could not be run
 * at all: the copy is then no worse than every copy made before there was a
 * check, and a day with an unvouched copy is better than a day with none.
 * Throws when the check ran and found the copy damaged.
 */
async function vouchFor(copy: string, check: (file: string) => Promise<string[]>): Promise<string | undefined> {
  let problems: string[];
  try {
    problems = await check(copy);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (problems.length > 0) throw new DatabaseCopyDamagedError(problems);
  return undefined;
}

/** Where a database's copy for the day of `now` is kept. Its being there is what "already copied today" means. */
export function dailyDatabaseBackupFile(directory: string, name: DatabaseBackupName, now: Date): string {
  return path.join(directory, `${name}-${now.toISOString().slice(0, 10)}.db`);
}

function removeExpired(directory: string, name: DatabaseBackupName, retention: number): void {
  const pattern = databaseBackupPattern(name);
  const backups = fs.readdirSync(directory)
    .filter((entry) => pattern.test(entry))
    .sort()
    .reverse();
  for (const expired of backups.slice(retention)) {
    for (const suffix of ["", ...SQLITE_SIDECAR_SUFFIXES]) fs.rmSync(path.join(directory, `${expired}${suffix}`), { force: true });
  }
}

/**
 * Copies a database into the day's backup, once a day.
 *
 * The copy is written under a temporary name, held to SQLite's integrity check
 * there, and only then given the day's name. A day's copy is never remade, so
 * one that is broken must not be the one that takes the name: it is removed
 * and the failure thrown. What the check cannot see is said where it lives, in
 * backup-integrity.ts - a copy can pass it and still be wrong.
 */
export async function createDailyDatabaseBackup(
  database: Database.Database,
  options: DailyDatabaseBackupOptions = {},
): Promise<BackupResult> {
  const name = options.name ?? "sessions";
  const directory = options.directory ?? path.join(JINN_HOME, "backups");
  const retention = Math.max(1, Math.floor(options.retention ?? DATABASE_BACKUP_RETENTION));
  const file = dailyDatabaseBackupFile(directory, name, options.now ?? new Date());
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) return { created: false, file };
  options.beforeWrite?.();

  // SQLite creates this file itself and would follow a symlink left under its
  // name, so the name must not be one anybody could have guessed.
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  let unchecked: string | undefined;
  try {
    await database.backup(temporary);
    // Owner-only before it is read back, not after: the check can take a while.
    fs.chmodSync(temporary, 0o600);
    unchecked = await vouchFor(temporary, options.check ?? findDatabaseProblems);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  } finally {
    // Reading the copy back can leave a -wal and a -shm under the temporary name, which is about to mean nothing.
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) fs.rmSync(`${temporary}${suffix}`, { force: true });
  }

  removeExpired(directory, name, retention);
  return { created: true, file, ...(unchecked === undefined ? {} : { unchecked }) };
}
