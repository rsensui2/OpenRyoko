import path from "node:path";
import type { DatabaseBackupName } from "../sessions/backup.js";
import { JINN_HOME, SESSIONS_DB, WORKFLOWS_DB_PATH } from "../shared/paths.js";

/**
 * Re-bases a path that `shared/paths.ts` defines under the running home onto
 * `home`. The backup code takes the home as an argument so it can be pointed at
 * any directory, but where things live inside one is defined in exactly one
 * place and read from there.
 */
export function inHome(home: string, pathInRunningHome: string): string {
  return path.join(home, path.relative(JINN_HOME, pathInRunningHome));
}

/** Where a database lives inside a home. */
export function databasePath(home: string, name: DatabaseBackupName): string {
  return inHome(home, name === "sessions" ? SESSIONS_DB : WORKFLOWS_DB_PATH);
}
