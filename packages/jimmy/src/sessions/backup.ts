import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { JINN_HOME } from "../shared/paths.js";

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
}

export async function createDailyDatabaseBackup(
  database: Database.Database,
  options: { directory?: string; now?: Date; retention?: number; name?: DatabaseBackupName } = {},
): Promise<BackupResult> {
  const name = options.name ?? "sessions";
  const directory = options.directory ?? path.join(JINN_HOME, "backups");
  const retention = Math.max(1, Math.floor(options.retention ?? DATABASE_BACKUP_RETENTION));
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);
  const file = path.join(directory, `${name}-${day}.db`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) return { created: false, file };

  const temporary = `${file}.tmp-${process.pid}`;
  try {
    await database.backup(temporary);
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }

  const pattern = databaseBackupPattern(name);
  const backups = fs.readdirSync(directory)
    .filter((entry) => pattern.test(entry))
    .sort()
    .reverse();
  for (const expired of backups.slice(retention)) {
    for (const suffix of ["", ...SQLITE_SIDECAR_SUFFIXES]) fs.rmSync(path.join(directory, `${expired}${suffix}`), { force: true });
  }
  return { created: true, file };
}
