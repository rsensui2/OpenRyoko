import fs from "node:fs";
import path from "node:path";
import { DATABASE_BACKUP_RETENTION, SQLITE_SIDECAR_SUFFIXES, type DatabaseBackupName } from "../sessions/backup.js";

/** What a backup holds: the home's files, or one of its databases. */
export type BackupItemKind = "home" | DatabaseBackupName;

export interface BackupItem {
  /** What `ryoko backup verify` and `restore` take. The file name without its extension. */
  id: string;
  kind: BackupItemKind;
  /** Taken automatically, just before a restore overwrote what it holds. */
  preRestore: boolean;
  file: string;
  bytes: number;
  /** When it was taken, as an ISO timestamp. */
  createdAt: string;
}

const STAMP = String.raw`(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z`;
const ARCHIVE_NAME = new RegExp(`^(home|pre-restore)-(${STAMP})(?:-(\\d+))?\\.tar\\.gz$`);
const DAILY_DATABASE_NAME = /^(sessions|workflows)-\d{4}-\d{2}-\d{2}\.db$/;
const DATABASE_SNAPSHOT_NAME = new RegExp(`^pre-restore-(${STAMP})(?:-(\\d+))?-(sessions|workflows)\\.db$`);
/**
 * Temporary names this feature writes under: a leading dot for archives, a bare
 * suffix for database copies and the state file. A database copy is read back
 * before it gets its name, which can leave a -wal and a -shm beside the
 * temporary file; those are temporary too.
 */
const TEMPORARY_NAME = /^(\.?(home|pre-restore|sessions|workflows)-.+\.tmp-[0-9a-f-]+(-wal|-shm)?|backup-state\.json\.\d+\.[0-9a-f]+\.tmp)$/;
const STALE_TEMPORARY_MS = 24 * 60 * 60 * 1000;

/** `20261012T030000Z`: the moment an archive was taken, in a form that sorts as text. */
export function archiveStamp(when: Date): string {
  return `${when.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function stampToIso(match: RegExpExecArray, offset: number): string {
  const [year, month, day, hour, minute, second] = match.slice(offset, offset + 6);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

interface Classified {
  kind: BackupItemKind;
  preRestore: boolean;
  /** Set for names that carry their own timestamp; daily copies fall back to the file's mtime. */
  createdAt?: string;
}

/** Recognises a backup by its file name alone, or returns null for anything else. */
function classify(name: string): Classified | null {
  const archive = ARCHIVE_NAME.exec(name);
  if (archive) return { kind: "home", preRestore: archive[1] === "pre-restore", createdAt: stampToIso(archive, 3) };
  const snapshot = DATABASE_SNAPSHOT_NAME.exec(name);
  if (snapshot) return { kind: snapshot[9] as DatabaseBackupName, preRestore: true, createdAt: stampToIso(snapshot, 2) };
  const daily = DAILY_DATABASE_NAME.exec(name);
  return daily ? { kind: daily[1] as DatabaseBackupName, preRestore: false } : null;
}

function idOf(name: string): string {
  return name.replace(/\.tar\.gz$|\.db$/, "");
}

/** Describes one file as a backup, or returns null when it is not a regular file with a backup's name. */
function describe(file: string): BackupItem | null {
  const classified = classify(path.basename(file));
  if (!classified) return null;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  // A symlink or directory wearing a backup's name is not one, and retention must never act on it.
  if (!stat.isFile()) return null;
  return {
    id: idOf(path.basename(file)),
    kind: classified.kind,
    preRestore: classified.preRestore,
    file,
    bytes: stat.size,
    createdAt: classified.createdAt ?? stat.mtime.toISOString(),
  };
}

function newestFirst(a: BackupItem, b: BackupItem): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  // Same second: a numeric suffix marks the later one.
  return b.id.length - a.id.length || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * Far more backups than retention ever leaves behind. Past it the listing stops
 * taking names in: the directory is being flooded, and the next prune removes
 * what it has seen.
 */
const MAX_LISTED_BACKUPS = 10_000;

/**
 * The names in `directory` that `wanted` accepts, read one at a time and at
 * most `limit` of them. Never `readdirSync`: the gateway lists this directory
 * after every backup, and a directory somebody has filled with files must not
 * arrive as one array of every name in it.
 */
function matchingNames(directory: string, wanted: (name: string) => boolean, limit: number): string[] {
  let listing: fs.Dir;
  try {
    listing = fs.opendirSync(directory);
  } catch {
    return [];
  }
  const names: string[] = [];
  try {
    for (let entry = listing.readSync(); entry && names.length < limit; entry = listing.readSync()) {
      if (wanted(entry.name)) names.push(entry.name);
    }
  } catch {
    // What was read so far is still a true, if partial, picture.
  } finally {
    try { listing.closeSync(); } catch { /* already closed */ }
  }
  return names;
}

/** Every backup in `directory`, newest first. */
export function listBackups(directory: string, options: { maxItems?: number } = {}): BackupItem[] {
  return matchingNames(directory, (name) => classify(name) !== null, options.maxItems ?? MAX_LISTED_BACKUPS)
    .map((name) => describe(path.join(directory, name)))
    .filter((item): item is BackupItem => item !== null)
    .sort(newestFirst);
}

/**
 * Resolves what the operator typed - an id from `ryoko backup list`, a file
 * name, or a path to an archive kept somewhere else - to one backup.
 */
export function findBackup(directory: string, reference: string): BackupItem {
  const looksLikePath = path.isAbsolute(reference) || reference.includes("/") || reference.includes(path.sep);
  if (looksLikePath) {
    const file = path.resolve(reference);
    if (!fs.existsSync(file)) throw new Error(`no backup file at ${file}`);
    const item = describe(file);
    if (!item) throw new Error(`${file} is not a backup this command wrote (its file name is not one it recognises)`);
    return item;
  }
  const id = idOf(reference);
  const item = listBackups(directory).find((candidate) => candidate.id === id);
  if (!item) throw new Error(`no backup with id "${reference}" in ${directory} (list them with: ryoko backup list)`);
  return item;
}

/**
 * A name no backup of this second holds, numbered one past the highest that is
 * there. `build("")` is the first of a second, `build("-2")` the second, and
 * so on; `numbered` matches those names and captures the number.
 *
 * Not the first number that is free. Within a second the number is the order,
 * and one that pruning has freed belonged to a backup older than every one
 * still there: a new backup given it would be named as the oldest of its
 * second, and be the next the rule removes.
 */
function reserve(directory: string, numbered: RegExp, build: (suffix: string) => string): string {
  let highest = 0;
  for (const name of matchingNames(directory, (candidate) => numbered.test(candidate), MAX_LISTED_BACKUPS)) {
    highest = Math.max(highest, Number(numbered.exec(name)?.[1] ?? 1));
  }
  for (let sequence = highest + 1; ; sequence += 1) {
    const name = build(sequence === 1 ? "" : `-${sequence}`);
    // Still asked of each: a directory flooded past what was listed may hold the name after all.
    if (!fs.existsSync(path.join(directory, name))) return name;
  }
}

/** A name no archive holds yet, so two taken in the same second sit side by side. */
export function reserveArchiveName(directory: string, prefix: "home" | "pre-restore", when: Date): { id: string; file: string } {
  const stem = `${prefix}-${archiveStamp(when)}`;
  const name = reserve(directory, new RegExp(`^${stem}(?:-(\\d+))?\\.tar\\.gz$`), (suffix) => `${stem}${suffix}.tar.gz`);
  return { id: idOf(name), file: path.join(directory, name) };
}

/** A name for the copy of a live database taken before a restore replaces it. */
export function reserveDatabaseSnapshotName(directory: string, name: DatabaseBackupName, when: Date): { id: string; file: string } {
  const stem = `pre-restore-${archiveStamp(when)}`;
  const fileName = reserve(directory, new RegExp(`^${stem}(?:-(\\d+))?-${name}\\.db$`), (suffix) => `${stem}${suffix}-${name}.db`);
  return { id: idOf(fileName), file: path.join(directory, fileName) };
}

function removeWithSidecars(file: string, removed: string[]): void {
  for (const suffix of ["", ...SQLITE_SIDECAR_SUFFIXES]) fs.rmSync(`${file}${suffix}`, { force: true });
  removed.push(file);
}

function sweepStaleTemporaries(directory: string, now: Date, removed: string[]): void {
  for (const name of matchingNames(directory, (candidate) => TEMPORARY_NAME.test(candidate), MAX_LISTED_BACKUPS)) {
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || now.getTime() - stat.mtimeMs < STALE_TEMPORARY_MS) continue;
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch { /* gone already, or not ours to touch */ }
  }
}

/**
 * How many backups of one kind are kept from a single day. The newest is the
 * day's backup; the two before it are for whoever takes one before each risky
 * change and wants the last few steps back.
 */
export const SAME_DAY_BACKUPS_KEPT = 3;

/**
 * The members of one pool that have outlived their keep. `members` is newest
 * first. Kept: the newest `days` days that have a backup at all, and of each of
 * those days its most recent {@link SAME_DAY_BACKUPS_KEPT}.
 *
 * Days, not a count. A count let fourteen backups taken in one afternoon push
 * out fourteen days of history; here a day's worth of them can only ever
 * displace each other. And days that have a backup, not days on the calendar:
 * an instance that was switched off for a month still has its `days` of
 * history when it comes back, rather than none.
 */
function expired(members: BackupItem[], days: number): BackupItem[] {
  const keptPerDay = new Map<string, number>();
  return members.filter((item) => {
    const day = item.createdAt.slice(0, 10);
    const keptToday = keptPerDay.get(day);
    if (keptToday === undefined && keptPerDay.size >= Math.max(1, days)) return true;
    if ((keptToday ?? 0) >= SAME_DAY_BACKUPS_KEPT) return true;
    keptPerDay.set(day, (keptToday ?? 0) + 1);
    return false;
  });
}

/**
 * Trims the backup directory to the days it is meant to hold.
 *
 * Only files this feature names are ever candidates: the directory may be one
 * the operator shares with other things. Daily archives and pre-restore
 * snapshots are counted apart, so a burst of restores cannot push out the
 * daily history. The daily database copies are not touched here - their writer
 * keeps its own seven, one a day - and anything unrecognised is left exactly
 * as it is.
 *
 * `keep` is what the run that is pruning has just written, and none of it is
 * removed whatever the rule says. The rule goes by the time in a file's name.
 * With a clock that has fallen behind the backups already there, the newest
 * backup is by its name the oldest, and a run would report it written and
 * then delete it. It is still judged with the rest, so that on an ordinary
 * day it takes its place and its day keeps to its share.
 */
export function pruneBackups(directory: string, options: { retention: number; now: Date; keep?: readonly string[] }): string[] {
  const removed: string[] = [];
  const kept = new Set((options.keep ?? []).map((file) => path.resolve(file)));
  const items = listBackups(directory);
  const pools: { members: BackupItem[]; days: number }[] = [
    { members: items.filter((item) => item.kind === "home" && !item.preRestore), days: options.retention },
    { members: items.filter((item) => item.kind === "home" && item.preRestore), days: options.retention },
    { members: items.filter((item) => item.kind === "sessions" && item.preRestore), days: DATABASE_BACKUP_RETENTION },
    { members: items.filter((item) => item.kind === "workflows" && item.preRestore), days: DATABASE_BACKUP_RETENTION },
  ];
  for (const pool of pools) {
    for (const item of expired(pool.members, pool.days)) {
      if (!kept.has(path.resolve(item.file))) removeWithSidecars(item.file, removed);
    }
  }
  sweepStaleTemporaries(directory, options.now, removed);
  return removed;
}
