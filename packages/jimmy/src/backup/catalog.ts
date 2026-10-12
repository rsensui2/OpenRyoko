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
/** Temporary names this feature writes under: a leading dot for archives, a bare suffix for database copies and the state file. */
const TEMPORARY_NAME = /^(\.?(home|pre-restore|sessions|workflows)-.+\.tmp-[0-9a-f-]+|backup-state\.json\.\d+\.[0-9a-f]+\.tmp)$/;
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

function readNames(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

/** Every backup in `directory`, newest first. */
export function listBackups(directory: string): BackupItem[] {
  return readNames(directory)
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

function reserve(directory: string, build: (suffix: string) => string): string {
  for (let attempt = 1; ; attempt += 1) {
    const name = build(attempt === 1 ? "" : `-${attempt}`);
    if (!fs.existsSync(path.join(directory, name))) return name;
  }
}

/** A name no archive holds yet, so two taken in the same second sit side by side. */
export function reserveArchiveName(directory: string, prefix: "home" | "pre-restore", when: Date): { id: string; file: string } {
  const name = reserve(directory, (suffix) => `${prefix}-${archiveStamp(when)}${suffix}.tar.gz`);
  return { id: idOf(name), file: path.join(directory, name) };
}

/** A name for the copy of a live database taken before a restore replaces it. */
export function reserveDatabaseSnapshotName(directory: string, name: DatabaseBackupName, when: Date): { id: string; file: string } {
  const fileName = reserve(directory, (suffix) => `pre-restore-${archiveStamp(when)}${suffix}-${name}.db`);
  return { id: idOf(fileName), file: path.join(directory, fileName) };
}

function removeWithSidecars(file: string, removed: string[]): void {
  for (const suffix of ["", ...SQLITE_SIDECAR_SUFFIXES]) fs.rmSync(`${file}${suffix}`, { force: true });
  removed.push(file);
}

function sweepStaleTemporaries(directory: string, now: Date, removed: string[]): void {
  for (const name of readNames(directory)) {
    if (!TEMPORARY_NAME.test(name)) continue;
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
 * Trims the backup directory to its generations.
 *
 * Only files this feature names are ever candidates: the directory may be one
 * the operator shares with other things. Daily archives and pre-restore
 * snapshots are counted apart, so a burst of restores cannot push out the
 * daily history. The daily database copies are not touched here - their writer
 * keeps its own seven - and anything unrecognised is left exactly as it is.
 */
export function pruneBackups(directory: string, options: { retention: number; now: Date }): string[] {
  const removed: string[] = [];
  const items = listBackups(directory);
  const pools: { members: BackupItem[]; keep: number }[] = [
    { members: items.filter((item) => item.kind === "home" && !item.preRestore), keep: options.retention },
    { members: items.filter((item) => item.kind === "home" && item.preRestore), keep: options.retention },
    { members: items.filter((item) => item.kind === "sessions" && item.preRestore), keep: DATABASE_BACKUP_RETENTION },
    { members: items.filter((item) => item.kind === "workflows" && item.preRestore), keep: DATABASE_BACKUP_RETENTION },
  ];
  for (const pool of pools) {
    for (const expired of pool.members.slice(Math.max(1, pool.keep))) removeWithSidecars(expired.file, removed);
  }
  sweepStaleTemporaries(directory, options.now, removed);
  return removed;
}
