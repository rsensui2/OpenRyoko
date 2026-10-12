import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDiskSpaceStatus, type DiskSpaceStatus } from "../shared/storage-health.js";
import { createHomeArchive, inspectHomeArchive, NothingToArchiveError, readHomeArchive, type ArchiveInspection } from "./archive.js";
import { reserveArchiveName } from "./catalog.js";
import { errorMessage } from "./format.js";
import type { BackupManifest, ManifestEntry } from "./manifest.js";
import { BACKUP_KINDS, HOME_ARCHIVE_TARGETS, kindOfPath, unsafePathReason, type BackupKind } from "./targets.js";
import { absolutePathOf, collectHomeEntries } from "./walk.js";

const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_LISTED = 5;

export interface RestoreOptions {
  archive: string;
  home: string;
  /** Limits the restore to these kinds. Default: everything the archive holds. */
  only?: readonly BackupKind[];
  /** Work out what would change and stop there. */
  dryRun?: boolean;
  /** Recreate symlinks whose target lies outside the home. Refused unless set. */
  allowExternalSymlinks?: boolean;
  /** Where the snapshot of the current state goes before anything is written. */
  backupDirectory: string;
  now: Date;
  /** The existing free-space judgement, replaceable in tests. */
  diskSpace?: (directory: string) => DiskSpaceStatus;
  /** Overrides the verification pass. The seam that lets a test stand in for an inspector that misses something. */
  inspect?: (file: string) => Promise<ArchiveInspection>;
}

export type RestoreAction = "create" | "replace" | "unchanged";

export interface RestoreChange {
  path: string;
  type: ManifestEntry["type"];
  /** Null for a directory that only exists to hold a restored path, like `cron`. */
  kind: BackupKind | null;
  action: Exclude<RestoreAction, "unchanged">;
}

export interface RestoreResult {
  id: string;
  archive: string;
  home: string;
  dryRun: boolean;
  /** The kinds actually restored: the ones asked for that the archive holds. */
  kinds: BackupKind[];
  changes: RestoreChange[];
  unchanged: number;
  /** In the home under the restored kinds, absent from the archive. Left exactly as they are. */
  untouched: string[];
  /** In the archive but under no archive target. Never written. */
  ignored: string[];
  /** The snapshot taken before writing. Null on a dry run or when nothing needed saving. */
  preRestore: { id: string; file: string } | null;
}

interface PlanItem {
  entry: ManifestEntry;
  action: RestoreAction;
}

function parentOf(entryPath: string): string | null {
  const cut = entryPath.lastIndexOf("/");
  return cut === -1 ? null : entryPath.slice(0, cut);
}

function ancestorsOf(entryPath: string): string[] {
  const segments = entryPath.split("/");
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

/** A directory entry no kind claims, that exists because a target lives under it. */
function holdsATarget(entryPath: string): boolean {
  return HOME_ARCHIVE_TARGETS.some((target) => target.paths.some((root) => root.startsWith(`${entryPath}/`)));
}

function lstatOrNull(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sha256OfFile(file: string): string {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const descriptor = fs.openSync(file, "r");
  try {
    for (let read = fs.readSync(descriptor, buffer); read > 0; read = fs.readSync(descriptor, buffer)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

/**
 * True when a symlink at `entryPath` would lead out of `home`. Judged from the
 * link text alone: nothing is resolved on disk, so a link cannot be made to
 * look safe by what happens to exist where it points.
 */
function leadsOutside(home: string, entryPath: string, target: string): boolean {
  const resolved = path.resolve(path.dirname(absolutePathOf(home, entryPath)), target);
  const relative = path.relative(home, resolved);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** Outside the home under every name the home goes by: as given, and with its own symlinks resolved. */
function leadsOutsideEvery(homes: readonly string[], entry: ManifestEntry): boolean {
  return homes.every((home) => leadsOutside(home, entry.path, entry.target ?? ""));
}

function listed(items: string[]): string {
  const shown = items.slice(0, MAX_LISTED).join("; ");
  return items.length > MAX_LISTED ? `${shown}; and ${items.length - MAX_LISTED} more` : shown;
}

function selectEntries(manifest: BackupManifest, only: readonly BackupKind[] | undefined): ManifestEntry[] {
  const wanted = new Set<BackupKind>(only ?? BACKUP_KINDS);
  const selected = manifest.entries.filter((entry) => {
    const kind = kindOfPath(entry.path);
    return kind !== null && wanted.has(kind);
  });
  // The inspection has already refused these. They are checked again here
  // because this is the list that becomes destinations: `skills/../../x` sits
  // under a target by its prefix, and joined to the home it is outside it.
  for (const entry of selected) {
    const reason = unsafePathReason(entry.path);
    if (reason) throw new Error(`refusing to restore an unsafe path (${reason}): ${JSON.stringify(entry.path)}`);
  }
  if (selected.length > 0) return selected;
  throw new Error(only
    ? `the archive holds nothing of the kind asked for (${only.join(", ")})`
    : "the archive holds nothing this command restores");
}

/**
 * Refuses a plan that would put a symlink leading out of the home in place.
 * Only links the restore would actually write count: one that is already in
 * the home with the same target is left as it is, and leaving it introduces
 * nothing - which matters, because an operator's own links into `skills/` are
 * in every archive of their home.
 */
function refuseExternalSymlinks(homes: readonly string[], plan: PlanItem[]): void {
  const external = plan
    .filter(({ entry, action }) => action !== "unchanged" && entry.type === "symlink" && leadsOutsideEvery(homes, entry))
    .map(({ entry }) => `${entry.path} -> ${entry.target}`);
  if (external.length === 0) return;
  throw new Error(
    `restoring this would create ${external.length} symlink(s) that point outside the home (${listed(external)}). `
    + "That is not done by default; nothing was restored. Pass --allow-external-symlinks to restore them as they were.",
  );
}

/** What it takes to make one path match the archive, given what is in the home now. */
function compareWithHome(home: string, entry: ManifestEntry, conflicts: string[]): RestoreAction {
  const absolute = absolutePathOf(home, entry.path);
  const stat = lstatOrNull(absolute);
  if (!stat) return "create";
  if (entry.type === "directory") return stat.isDirectory() ? "unchanged" : "replace";
  if (stat.isDirectory()) {
    // Putting a file here means deleting a tree, and part of a tree (.git,
    // node_modules) is in no snapshot. That is the operator's call, not ours.
    conflicts.push(`${entry.path} is a directory in the home but a ${entry.type} in the backup`);
    return "replace";
  }
  if (entry.type === "symlink") return stat.isSymbolicLink() && fs.readlinkSync(absolute) === entry.target ? "unchanged" : "replace";
  return stat.isFile() && stat.size === entry.size && sha256OfFile(absolute) === entry.sha256 ? "unchanged" : "replace";
}

/**
 * Works out, path by path, what a restore would do. Every directory above a
 * selected entry is part of the plan too, so by the time a file is written its
 * whole parent chain is known to be real directories - which is what keeps a
 * symlink sitting in the home from being written through.
 */
function buildPlan(home: string, manifest: BackupManifest, selected: ManifestEntry[]): PlanItem[] {
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const wanted = new Map<string, ManifestEntry>();
  for (const entry of selected) {
    for (const ancestor of ancestorsOf(entry.path)) {
      if (wanted.has(ancestor)) continue;
      const recorded = byPath.get(ancestor);
      wanted.set(ancestor, recorded?.type === "directory" ? recorded : { path: ancestor, type: "directory", mode: 0o700 });
    }
    wanted.set(entry.path, entry);
  }
  const ordered = [...wanted.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const conflicts: string[] = [];
  // Directories this restore makes anew. Nothing under one exists yet, and
  // what the home shows at that path may be the far side of a symlink.
  const fresh = new Set<string>();
  const plan = ordered.map((entry): PlanItem => {
    const parent = parentOf(entry.path);
    const action = parent !== null && fresh.has(parent) ? "create" : compareWithHome(home, entry, conflicts);
    if (entry.type === "directory" && action !== "unchanged") fresh.add(entry.path);
    return { entry, action };
  });
  if (conflicts.length > 0) {
    throw new Error(`${listed(conflicts)}. Move it out of the way and run the restore again; nothing was restored.`);
  }
  return plan;
}

function untouchedInHome(home: string, manifest: BackupManifest, kinds: BackupKind[], backupDirectory: string): string[] {
  const inArchive = new Set(manifest.entries.map((entry) => entry.path));
  return collectHomeEntries(home, { excludePaths: [backupDirectory] }).entries
    .filter((entry) => entry.type !== "directory" && !inArchive.has(entry.path))
    .filter((entry) => {
      const kind = kindOfPath(entry.path);
      return kind !== null && kinds.includes(kind);
    })
    .map((entry) => entry.path);
}

function assertRoomToWork(options: RestoreOptions, home: string): void {
  const probe = options.diskSpace ?? getDiskSpaceStatus;
  for (const directory of new Set([home, options.backupDirectory])) {
    const disk = probe(directory);
    if (disk.level !== "critical") continue;
    const free = disk.freeBytes === null ? "unknown" : Math.floor(disk.freeBytes / 1024 ** 2);
    throw new Error(`not enough free disk space to restore safely (${free} MiB free in ${directory}); nothing was restored`);
  }
}

/** Archives the home as it stands, so whatever the restore overwrites can be had back. */
async function snapshotCurrentState(options: RestoreOptions, home: string): Promise<{ id: string; file: string } | null> {
  const { id, file } = reserveArchiveName(options.backupDirectory, "pre-restore", options.now);
  try {
    await createHomeArchive({ home, destination: file, id, createdAt: options.now, excludePaths: [options.backupDirectory] });
    return { id, file };
  } catch (error) {
    if (error instanceof NothingToArchiveError) return null;
    throw new Error(`the current state could not be saved first, so nothing was restored: ${errorMessage(error)}`);
  }
}

/**
 * Extracts the files the plan needs into a private staging directory, hashing
 * each as it lands. Staging holds flat numbered files and nothing else - no
 * directories, no links - so no entry name from the archive is ever used as a
 * path here, and the archive is held to the manifest that was just verified.
 */
async function stageFiles(archive: string, staging: string, needed: Map<string, ManifestEntry>): Promise<Map<string, string>> {
  const staged = new Map<string, string>();
  // The one descriptor that may still be open if the archive fails mid-entry.
  const open: { descriptor?: number } = {};
  try {
    await readHomeArchive(archive, (entry) => {
      const expected = needed.get(entry.path);
      if (!expected || entry.type !== "file" || staged.has(entry.path)) return undefined;
      const file = path.join(staging, String(staged.size).padStart(6, "0"));
      const hash = crypto.createHash("sha256");
      const descriptor = fs.openSync(file, "wx", 0o600);
      open.descriptor = descriptor;
      return {
        write: (chunk) => {
          hash.update(chunk);
          fs.writeSync(descriptor, chunk);
        },
        end: () => {
          fs.closeSync(descriptor);
          open.descriptor = undefined;
          if (entry.size !== expected.size || hash.digest("hex") !== expected.sha256) {
            throw new Error(`${entry.path} no longer matches the manifest that was verified; the archive changed underneath the restore`);
          }
          staged.set(entry.path, file);
        },
      };
    });
  } finally {
    if (open.descriptor !== undefined) fs.closeSync(open.descriptor);
  }
  const missing = [...needed.keys()].filter((entryPath) => !staged.has(entryPath));
  if (missing.length > 0) throw new Error(`the archive no longer holds ${listed(missing)}; it changed underneath the restore`);
  return staged;
}

function assertParentIsDirectory(home: string, entryPath: string): void {
  const parent = parentOf(entryPath);
  const stat = lstatOrNull(parent === null ? home : absolutePathOf(home, parent));
  if (!stat?.isDirectory()) throw new Error(`${parent ?? home} is no longer a directory`);
}

function makeDirectory(destination: string, mode: number): void {
  const stat = lstatOrNull(destination);
  if (stat?.isDirectory()) return;
  // A file or a link in the way is unlinked - never followed, never recursed into.
  if (stat) fs.rmSync(destination);
  fs.mkdirSync(destination, { mode: (mode & 0o777) | 0o700 });
}

function placeFile(staged: string, destination: string, mode: number): void {
  try { fs.chmodSync(staged, mode & 0o777); } catch { /* Windows has no POSIX modes */ }
  try {
    // Replaces a file or a symlink at the destination in one step; a link is replaced, not followed.
    fs.renameSync(staged, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    const temporary = `${destination}.restore-${crypto.randomBytes(4).toString("hex")}`;
    fs.copyFileSync(staged, temporary, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(temporary, mode & 0o777); } catch { /* Windows has no POSIX modes */ }
    fs.renameSync(temporary, destination);
  }
}

function placeSymlink(destination: string, target: string): void {
  const temporary = `${destination}.restore-${crypto.randomBytes(4).toString("hex")}`;
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, destination);
}

function applyPlan(home: string, plan: PlanItem[], staged: Map<string, string>): void {
  for (const { entry, action } of plan) {
    if (action === "unchanged") continue;
    assertParentIsDirectory(home, entry.path);
    const destination = absolutePathOf(home, entry.path);
    if (entry.type === "directory") makeDirectory(destination, entry.mode);
    else if (entry.type === "symlink") placeSymlink(destination, entry.target ?? "");
    else placeFile(staged.get(entry.path)!, destination, entry.mode);
  }
}

async function writeIntoHome(options: RestoreOptions, home: string, plan: PlanItem[], preRestore: { id: string } | null): Promise<void> {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const scratch = path.join(home, "tmp");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(scratch, "restore-"));
  try {
    const needed = new Map(plan
      .filter((item) => item.action !== "unchanged" && item.entry.type === "file")
      .map((item) => [item.entry.path, item.entry]));
    const staged = await stageFiles(options.archive, staging, needed);
    try {
      applyPlan(home, plan, staged);
    } catch (error) {
      const way = preRestore ? ` The state before it is saved as ${preRestore.id}; restore that to go back.` : "";
      throw new Error(`the restore stopped partway: ${errorMessage(error)}.${way}`);
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Restores files from a home archive into `home`.
 *
 * Nothing is written until the archive has been read end to end and checked
 * against its manifest, the plan has been worked out, and the current state of
 * the home has been archived as a pre-restore snapshot. Files are then
 * extracted into a staging directory, verified again, and moved into place.
 *
 * A restore brings back what the archive has. It deletes nothing: a file added
 * to the home since the backup stays where it is and is reported as untouched.
 * It writes only under the paths a home archive is made of, never through a
 * symlink, and never recreates a symlink leading out of the home unless asked.
 */
export async function restoreHomeArchive(options: RestoreOptions): Promise<RestoreResult> {
  const inspection = await (options.inspect ?? inspectHomeArchive)(options.archive);
  if (!inspection.ok || !inspection.manifest) {
    throw new Error(`refusing to restore an archive that failed verification - ${listed(inspection.problems)}`);
  }
  const manifest = inspection.manifest;
  const home = fs.existsSync(options.home) ? fs.realpathSync(options.home) : path.resolve(options.home);
  const selected = selectEntries(manifest, options.only);
  const plan = buildPlan(home, manifest, selected);
  if (!options.allowExternalSymlinks) refuseExternalSymlinks([home, path.resolve(options.home)], plan);
  const kinds = BACKUP_KINDS.filter((kind) => selected.some((entry) => kindOfPath(entry.path) === kind));
  const changes = plan
    .filter((item): item is PlanItem & { action: "create" | "replace" } => item.action !== "unchanged")
    .map((item) => ({ path: item.entry.path, type: item.entry.type, kind: kindOfPath(item.entry.path), action: item.action }));
  const result: RestoreResult = {
    id: manifest.id,
    archive: options.archive,
    home,
    dryRun: options.dryRun === true,
    kinds,
    changes,
    unchanged: plan.length - changes.length,
    untouched: untouchedInHome(home, manifest, kinds, options.backupDirectory),
    ignored: manifest.entries.filter((entry) => kindOfPath(entry.path) === null && !holdsATarget(entry.path)).map((entry) => entry.path),
    preRestore: null,
  };
  if (result.dryRun || changes.length === 0) return result;

  assertRoomToWork(options, home);
  const preRestore = await snapshotCurrentState(options, home);
  await writeIntoHome(options, home, plan, preRestore);
  return { ...result, preRestore };
}
