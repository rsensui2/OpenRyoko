import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SQLITE_SIDECAR_SUFFIXES, type DatabaseBackupName } from "../sessions/backup.js";
import { reserveDatabaseSnapshotName } from "./catalog.js";
import { errorMessage } from "./format.js";
import { detectRunningGateway, type GatewayLiveness } from "./gateway-liveness.js";
import { databasePath } from "./layout.js";
import { fileBytes, insufficientSpace, sameFilesystem, type DiskSpaceProbe } from "./space.js";

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
  detectGateway?: (home: string, destination: string, now: Date) => GatewayLiveness;
  /** The existing free-space judgement, replaceable in tests. */
  diskSpace?: DiskSpaceProbe;
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

/** The registry, and the database about to be replaced when that is a different one. */
function findRunningGateway(home: string, destination: string, now: Date): GatewayLiveness {
  return detectRunningGateway(home, { now, databases: [destination] });
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Holds a directory inside the home to being reached through real directories
 * only, all the way down from the home. One that is not there yet is fine: it
 * gets made, as a real directory. A place outside the home is not this
 * function's business - the operator named it, and it is used as it is found.
 */
function assertRealDirectories(home: string, directory: string, consequence: string): void {
  const relative = path.relative(home, directory);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
  let current = home;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = lstatOrNull(current);
    if (!stat) return;
    const shown = path.relative(home, current).split(path.sep).join("/");
    if (stat.isSymbolicLink()) throw new Error(`${shown} is a symlink (to ${fs.readlinkSync(current)}). ${consequence} Nothing was changed.`);
    if (!stat.isDirectory()) throw new Error(`${shown} is not a directory. ${consequence} Nothing was changed.`);
  }
}

/**
 * Refuses a restore that would write outside the home by way of a symlink in
 * it. Restoring files never writes through one; this is the same rule for the
 * two things a database restore writes. The new database goes beside the old
 * one, so with `sessions/` swapped for a link it would land wherever that
 * points, and the gateway would go on using it there. And the database being
 * replaced is copied into the backup directory first, which inside the home
 * has to be the directory it looks like.
 */
function refuseToLeaveTheHome(options: DatabaseRestoreOptions, destination: string): void {
  assertRealDirectories(
    options.home, path.dirname(destination),
    "A database is restored in place, and through that it would be written outside the home: put the real directory back and run the restore again.",
  );
  assertRealDirectories(
    options.home, options.backupDirectory,
    "The database being replaced is copied there first, and through that the copy would leave the home: "
    + "put the real directory back, or name the place itself as backup.directory in config.yaml, and run the restore again.",
  );
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

/**
 * Refuses a restore that would not leave room for the gateway to work once it
 * is back. Two things get written: the copy of the database being replaced,
 * into the backup directory, and the new database beside the old one, which
 * exist together until the rename. Sizes are read from the directory entries;
 * nothing is opened.
 */
function refuseWithoutRoom(options: DatabaseRestoreOptions, destination: string): void {
  const incoming = fileBytes(options.backup) + fileBytes(`${options.backup}-wal`);
  const outgoing = ["", ...SQLITE_SIDECAR_SUFFIXES].reduce((total, suffix) => total + fileBytes(`${destination}${suffix}`), 0);
  const beside = fs.existsSync(path.dirname(destination)) ? path.dirname(destination) : options.home;
  const needs: [string, number][] = sameFilesystem(beside, options.backupDirectory)
    ? [[options.backupDirectory, incoming + outgoing]]
    : [[beside, incoming], [options.backupDirectory, outgoing]];
  for (const [directory, bytes] of needs) {
    const reason = insufficientSpace(directory, bytes, options.diskSpace);
    if (reason) throw new Error(`${reason}. Nothing was changed.`);
  }
}

/** The flag that carries the operator's confirmation. Named here because the refusals quote it. */
export const GATEWAY_STOPPED_FLAG = "--gateway-stopped";

/**
 * Why a database is not replaced on the strength of "no gateway was detected".
 *
 * What the detection can read - a live pid, a recent write - is evidence that
 * a gateway is there, never that one is not. The usual deployment keeps the
 * home on the host and bind-mounts it into a container where the gateway runs;
 * a `ryoko` on the host sees the same files, a pid that means nothing in its
 * own pid namespace, and, while the gateway has nothing to write, files that
 * look idle. The one way to know for certain would be to open the database,
 * and opening a database in use from the wrong side of that boundary is what
 * destroys it.
 */
function confirmationRequired(): Error {
  return new Error(
    `restoring a database needs ${GATEWAY_STOPPED_FLAG}, your confirmation that no gateway is running on this home. `
    + "This command cannot be sure of it by itself: when the home is bind-mounted into a container, a gateway running inside is "
    + "not reliably visible to a command run on the host, and a database that may be in use is never opened just to find out. "
    + `Run this where the gateway runs (inside the container), stop the gateway first (ryoko stop), then repeat the command with ${GATEWAY_STOPPED_FLAG}. `
    + "Nothing was changed.",
  );
}

/**
 * Replaces a home's session registry or workflows store with a backup of it.
 *
 * Refused while a gateway is running on the home: its connection would keep
 * writing to a file that is no longer there, and a WAL from the old database
 * would be replayed into the new one.
 *
 * What is opened, and when, is the whole design:
 *
 * - The live database is never opened, in any mode, at any point: not to see
 *   whether it is in use, not on a dry run, not to copy it aside (that is a
 *   plain file copy, sidecars included), not to replace it (a rename).
 * - The operator's confirmation is checked first, before anything is looked
 *   at. Then that the two places this writes - beside the database, and the
 *   backup directory when it is in the home - are reached through real
 *   directories and not through a symlink leading out of it. Then the signs of
 *   a running gateway, which are pid files and file timestamps. A refusal at
 *   any of these points has read no database at all.
 * - Only then is the backup opened, read-only: once for SQLite's integrity
 *   check (on a dry run too - it is a file in the backup directory, not the
 *   one in use), and once as the source of the copy that is written to a new
 *   file beside the live database and renamed over it.
 */
export async function restoreDatabase(options: DatabaseRestoreOptions): Promise<DatabaseRestoreResult> {
  const destination = databasePath(options.home, options.name);
  const dryRun = options.dryRun === true;
  if (!dryRun && options.gatewayStopped !== true) throw confirmationRequired();
  refuseToLeaveTheHome(options, destination);

  const liveness = (options.detectGateway ?? findRunningGateway)(options.home, destination, options.now);
  if (liveness.running) {
    throw new Error(
      `a gateway appears to be running on this home (${liveness.reason ?? "it was detected"}). A database cannot be replaced underneath it: `
      + `stop the gateway (ryoko stop), wait a minute, run this command again with ${GATEWAY_STOPPED_FLAG}, then start the gateway. `
      + "Nothing was changed.",
    );
  }
  const problems = inspectDatabaseBackup(options.backup);
  if (problems.length > 0) {
    throw new Error(`refusing to restore a database backup that failed its integrity check - ${problems.slice(0, 3).join("; ")}`);
  }
  refuseWithoutRoom(options, destination);
  const result: DatabaseRestoreResult = { name: options.name, backup: options.backup, destination, dryRun, preRestore: null };
  if (dryRun) return result;

  const preRestore = keepCurrentDatabase(options, destination);
  await installDatabase(options.backup, destination);
  return { ...result, preRestore };
}
