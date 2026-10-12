import Database from "better-sqlite3";
import fs from "node:fs";
import type { DatabaseBackupName } from "../sessions/backup.js";
import { detectRunningGateway, type GatewayLiveness } from "./gateway-liveness.js";
import { databasePath } from "./layout.js";

/**
 * Where a backup run gets a database connection from, and when it gets none.
 *
 * A run opens no database on its own. Every connection is handed to it by a
 * caller that has decided it is safe: the gateway hands over its own, and a
 * command run by hand hands one over only when asked to and only when nothing
 * suggests a gateway is running on the home.
 */

/** A database to copy, and how to give it back. */
export interface DatabaseHandle {
  database: Database.Database;
  release(): void;
}

/**
 * Why a database was deliberately left unopened.
 *  - "not-requested": the run was handed no source for it.
 *  - "gateway-running": it was asked for, and a gateway appears to be running on the home.
 */
export type WithheldReason = "not-requested" | "gateway-running";

/** A source's refusal: the database is there, and it is not going to be opened. */
export interface DatabaseWithheld {
  withheld: WithheldReason;
  detail: string;
}

/** Hands over a connection, declines to, or returns null when the home has no such database. */
export type DatabaseSource = () => DatabaseHandle | DatabaseWithheld | null;

/** The flag that asks `ryoko backup run` for the databases too. Named here because the reports quote it. */
export const INCLUDE_DATABASES_FLAG = "--include-databases";

/**
 * Opens a database read-only for copying.
 *
 * Read-only is not the same as harmless, and this is only for a caller that
 * knows who else has the file open. What a read-only connection does, traced
 * through the SQLite this ships with and measured:
 *
 * - The main file is opened read-only and cannot be written. The -wal is not
 *   written, truncated or deleted either: all of that needs an exclusive lock
 *   on the main file, which a read-only descriptor cannot take. So closing it
 *   never checkpoints the WAL away, which is what a read-write connection does
 *   the moment it believes itself the last one.
 * - The -shm (the WAL's index) is opened read-write regardless. Beside other
 *   connections it can see, this one only records where it is reading. When it
 *   sees none it takes itself for the first, truncates the -shm to three bytes
 *   and rebuilds it from the WAL - and creates an empty -wal and a -shm beside
 *   a database that had neither, and leaves them there.
 *
 * On the machine the other connections run on, their locks are seen and this
 * is ordinary SQLite. From the far side of a bind mount into a container they
 * may not be, and a gateway whose index was rebuilt underneath it has not been
 * tested and cannot be from here. Hence the two callers: the gateway, for a
 * database in its own home, and {@link standaloneDatabaseSources}.
 */
export function readOnlyDatabaseSource(file: string): DatabaseSource {
  return () => {
    if (!fs.existsSync(file)) return null;
    const database = new Database(file, { readonly: true, fileMustExist: true });
    return { database, release: () => { database.close(); } };
  };
}

function refusal(liveness: GatewayLiveness): DatabaseWithheld {
  return {
    withheld: "gateway-running",
    detail: `a gateway appears to be running on this home (${liveness.reason ?? "it was detected"}), so the database was not opened. `
      + "To copy it from here, stop the gateway (ryoko stop), wait a minute and run this again.",
  };
}

/**
 * Sources for a command run by hand, outside the gateway.
 *
 * Before the first database would be opened, the home is looked at for signs
 * of a running gateway - pid files and file timestamps, nothing that touches a
 * database - and if there are any, neither database is opened. The answer is
 * settled once for both: this command's own reading leaves a freshly written
 * -shm behind, and asked again it would take that for a gateway.
 *
 * No sign is not proof. A gateway behind a pid this process cannot see, with
 * nothing written for a minute, passes; so this is offered only on request
 * (`--include-databases`), never by default.
 */
export function standaloneDatabaseSources(home: string, now: () => Date): Record<DatabaseBackupName, DatabaseSource> {
  let liveness: GatewayLiveness | undefined;
  const guarded = (name: DatabaseBackupName): DatabaseSource => () => {
    const file = databasePath(home, name);
    if (!fs.existsSync(file)) return null;
    liveness ??= detectRunningGateway(home, { now: now(), databases: [databasePath(home, "workflows")] });
    return liveness.running ? refusal(liveness) : readOnlyDatabaseSource(file)();
  };
  return { sessions: guarded("sessions"), workflows: guarded("workflows") };
}
