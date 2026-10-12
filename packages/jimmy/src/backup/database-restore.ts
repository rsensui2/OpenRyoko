import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SQLITE_SIDECAR_SUFFIXES, type DatabaseBackupName } from "../sessions/backup.js";
import { reserveDatabaseSnapshotName } from "./catalog.js";
import { errorMessage } from "./format.js";
import { databaseHeldOpen, detectRunningGateway, type GatewayLiveness } from "./gateway-liveness.js";
import { databasePath } from "./layout.js";

export interface DatabaseRestoreOptions {
  /** The backup file to restore from. */
  backup: string;
  name: DatabaseBackupName;
  home: string;
  /** Where the copy of the database being replaced goes. */
  backupDirectory: string;
  now: Date;
  dryRun?: boolean;
  /**
   * The operator's own word that no gateway is running on this home. Required
   * to replace a database, on top of the automatic check - which it never
   * overrides. A dry run replaces nothing and does not need it.
   */
  gatewayStopped?: boolean;
  /** Replaces the check for a running gateway. `destination` is the database about to be replaced. */
  detectGateway?: (home: string, destination: string) => GatewayLiveness;
}

export interface DatabaseRestoreResult {
  name: DatabaseBackupName;
  backup: string;
  destination: string;
  dryRun: boolean;
  /** The copy of the database that was replaced. Null on a dry run or when there was none. */
  preRestore: { id: string; file: string } | null;
}

/**
 * Opens a backup read-only. Reading a WAL-mode file makes SQLite create -wal
 * and -shm beside it and, for a read-only connection, leave them there; the
 * ones that were not there before are removed again on close, so checking a
 * backup does not litter the directory it is kept in.
 */
function openBackup(file: string): { database: Database.Database; close(): void } {
  const absent = SQLITE_SIDECAR_SUFFIXES.filter((suffix) => !fs.existsSync(`${file}${suffix}`));
  const database = new Database(file, { readonly: true, fileMustExist: true });
  return {
    database,
    close: () => {
      database.close();
      for (const suffix of absent) fs.rmSync(`${file}${suffix}`, { force: true });
    },
  };
}

/** What is wrong with a database backup, or an empty list when SQLite finds it sound. */
export function inspectDatabaseBackup(file: string): string[] {
  let opened: ReturnType<typeof openBackup> | undefined;
  try {
    opened = openBackup(file);
    const lines = (opened.database.pragma("integrity_check") as { integrity_check: string }[]).map((row) => row.integrity_check);
    return lines.length === 1 && lines[0] === "ok" ? [] : lines.length > 0 ? lines : ["the integrity check returned nothing"];
  } catch (error) {
    return [`the database could not be read: ${errorMessage(error)}`];
  } finally {
    opened?.close();
  }
}

function findRunningGateway(home: string, destination: string): GatewayLiveness {
  const gateway = detectRunningGateway(home);
  if (gateway.running) return gateway;
  // detectRunningGateway has already asked this of the registry itself.
  if (destination !== databasePath(home, "sessions") && databaseHeldOpen(destination)) {
    return { running: true, reason: `${path.relative(home, destination)} is open in another process` };
  }
  return { running: false };
}

/**
 * Sets the live database aside before it is replaced. The files are copied as
 * they are, sidecars included, rather than through SQLite: a registry being
 * replaced because it is damaged cannot be read that way, and its bytes are
 * still worth keeping.
 */
function keepCurrentDatabase(options: DatabaseRestoreOptions, destination: string): { id: string; file: string } | null {
  if (!fs.existsSync(destination)) return null;
  try {
    fs.mkdirSync(options.backupDirectory, { recursive: true, mode: 0o700 });
    const { id, file } = reserveDatabaseSnapshotName(options.backupDirectory, options.name, options.now);
    for (const suffix of ["", ...SQLITE_SIDECAR_SUFFIXES]) {
      if (!fs.existsSync(`${destination}${suffix}`)) continue;
      fs.copyFileSync(`${destination}${suffix}`, `${file}${suffix}`, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(`${file}${suffix}`, 0o600); } catch { /* Windows has no POSIX modes */ }
    }
    return { id, file };
  } catch (error) {
    throw new Error(`the current database could not be saved first, so nothing was restored: ${errorMessage(error)}`);
  }
}

async function installDatabase(backup: string, destination: string): Promise<void> {
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(destination)}.restore-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  const source = openBackup(backup);
  try {
    // Through SQLite rather than a file copy: a backup that still has a WAL
    // beside it (a pre-restore copy does) comes out as one complete file.
    await source.database.backup(temporary);
    try { fs.chmodSync(temporary, 0o600); } catch { /* Windows has no POSIX modes */ }
    // A -wal or -shm left beside a replaced database is read as that database's own tail.
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) fs.rmSync(`${destination}${suffix}`, { force: true });
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  } finally {
    source.close();
  }
}

/** The flag that carries the operator's confirmation. Named here because the refusals quote it. */
export const GATEWAY_STOPPED_FLAG = "--gateway-stopped";

/**
 * Why "no gateway was detected" is not enough to replace a database.
 *
 * Both signs the detection reads - a live pid and a lock on the registry -
 * stop at a container boundary. The usual deployment keeps the home on the
 * host and bind-mounts it into a container where the gateway runs; a `ryoko`
 * on the host sees the same files, a pid that means nothing in its own pid
 * namespace, and no lock, because file locks do not cross the mount. It would
 * swap the registry out from under a gateway that is very much running.
 */
function confirmationRequired(): Error {
  return new Error(
    `restoring a database needs ${GATEWAY_STOPPED_FLAG}, your confirmation that no gateway is running on this home. `
    + "No running gateway was detected, but that check cannot see across a container boundary: when the home is bind-mounted "
    + "into a container, a gateway running inside it is invisible to a command run on the host. "
    + `Run this where the gateway runs (inside the container), stop the gateway first (ryoko stop), then repeat the command with ${GATEWAY_STOPPED_FLAG}. `
    + "Nothing was changed.",
  );
}

/**
 * Replaces a home's session registry or workflows store with a backup of it.
 *
 * Refused while a gateway is running on the home: its connection would keep
 * writing to a file that is no longer there, and a WAL from the old database
 * would be replayed into the new one. Detecting one is necessary and not
 * sufficient, so the operator has to confirm it is stopped as well. The backup
 * has to pass SQLite's own integrity check first, and the database it replaces
 * is copied aside before it is touched.
 */
export async function restoreDatabase(options: DatabaseRestoreOptions): Promise<DatabaseRestoreResult> {
  const problems = inspectDatabaseBackup(options.backup);
  if (problems.length > 0) {
    throw new Error(`refusing to restore a database backup that failed its integrity check - ${problems.slice(0, 3).join("; ")}`);
  }
  const destination = databasePath(options.home, options.name);
  const liveness = (options.detectGateway ?? findRunningGateway)(options.home, destination);
  if (liveness.running) {
    throw new Error(
      `the gateway for this home is running (${liveness.reason ?? "it was detected"}). A database cannot be replaced underneath it: `
      + `stop the gateway (ryoko stop), run this command again with ${GATEWAY_STOPPED_FLAG}, then start it.`,
    );
  }
  const result: DatabaseRestoreResult = {
    name: options.name, backup: options.backup, destination, dryRun: options.dryRun === true, preRestore: null,
  };
  if (result.dryRun) return result;
  if (options.gatewayStopped !== true) throw confirmationRequired();

  const preRestore = keepCurrentDatabase(options, destination);
  await installDatabase(options.backup, destination);
  return { ...result, preRestore };
}
