import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { JINN_HOME } from "../shared/paths.js";

const BACKUP_PATTERN = /^sessions-\d{4}-\d{2}-\d{2}\.db$/;

export interface BackupResult {
  created: boolean;
  file: string;
}

export async function createDailyDatabaseBackup(
  database: Database.Database,
  options: { directory?: string; now?: Date; retention?: number } = {},
): Promise<BackupResult> {
  const directory = options.directory ?? path.join(JINN_HOME, "backups");
  const retention = Math.max(1, Math.floor(options.retention ?? 7));
  const day = (options.now ?? new Date()).toISOString().slice(0, 10);
  const file = path.join(directory, `sessions-${day}.db`);
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

  const backups = fs.readdirSync(directory)
    .filter((name) => BACKUP_PATTERN.test(name))
    .sort()
    .reverse();
  for (const expired of backups.slice(retention)) fs.rmSync(path.join(directory, expired), { force: true });
  return { created: true, file };
}
