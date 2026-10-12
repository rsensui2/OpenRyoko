import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TMP_DIR } from "../shared/paths.js";
import {
  ArchiveTooLargeError,
  createHomeArchive,
  inspectHomeArchive,
  NothingToArchiveError,
  readHomeArchive,
  type ArchiveInspection,
  type InspectOptions,
} from "./archive.js";
import { reserveArchiveName } from "./catalog.js";
import { errorMessage } from "./format.js";
import { inHome } from "./layout.js";
import type { ArchiveLimits } from "./limits.js";
import { findManifestEntry, type BackupManifest, type ManifestEntry } from "./manifest.js";
import { DEFAULT_ARCHIVE_LIMITS } from "./settings.js";
import { insufficientSpace, sameFilesystem, type DiskSpaceProbe } from "./space.js";
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
  /**
   * What an archive may hold - the one being restored, and the snapshot taken
   * first of what it will overwrite. Default: what an instance uses when its config says nothing.
   */
  limits?: ArchiveLimits;
  /** The existing free-space judgement, replaceable in tests. */
  diskSpace?: DiskSpaceProbe;
  /** Overrides the verification pass. The seam that lets a test stand in for an inspector that misses something. */
  inspect?: (file: string, context: InspectOptions) => Promise<ArchiveInspection>;
}

/** "mode": the bytes already match and only the permissions are put back. */
export type RestoreAction = "create" | "replace" | "mode" | "unchanged";

/** True for the actions that extract a file from the archive. */
const writesContent = (action: RestoreAction): boolean => action === "create" || action === "replace";

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
  /** What the restore did and the operator should still know: at present, a working directory it could not clear away. */
  warnings: string[];
}

interface PlanItem {
  entry: ManifestEntry;
  action: RestoreAction;
}

/** An entry's kind. Its type goes along because a directory is never one of the documents in the home. */
function kindOf(entry: { path: string; type: ManifestEntry["type"] }): BackupKind | null {
  return kindOfPath(entry.path, entry.type);
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
    const kind = kindOf(entry);
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
  if (!stat.isFile() || stat.size !== entry.size || !sameContent(absolute, entry)) return "replace";
  // Same bytes is not the same file: a script that has lost its execute bit is still broken.
  const sameMode = process.platform === "win32" || (stat.mode & 0o777) === (entry.mode & 0o777);
  return sameMode ? "unchanged" : "mode";
}

/** Whether a file in the home has the content the archive recorded. One that cannot be read counts as different. */
function sameContent(file: string, entry: ManifestEntry): boolean {
  try {
    return sha256OfFile(file) === entry.sha256;
  } catch {
    return false;
  }
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

/**
 * What is in the home under the restored kinds and not in the archive. It is
 * for the operator to read, nothing depends on it, so a home too large to list
 * yields an empty answer rather than stopping a dry run; the restore itself
 * will say so when it comes to saving the current state.
 */
async function untouchedInHome(
  home: string,
  manifest: BackupManifest,
  kinds: BackupKind[],
  backupDirectory: string,
  limits: ArchiveLimits,
): Promise<string[]> {
  const inArchive = new Set(manifest.entries.map((entry) => entry.path));
  let entries: Awaited<ReturnType<typeof collectHomeEntries>>["entries"];
  try {
    ({ entries } = await collectHomeEntries(home, { excludePaths: [backupDirectory], limits }));
  } catch (error) {
    if (error instanceof ArchiveTooLargeError) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.type !== "directory" && !inArchive.has(entry.path))
    .filter((entry) => {
      const kind = kindOf(entry);
      return kind !== null && kinds.includes(kind);
    })
    .map((entry) => entry.path);
}

/** The bytes the plan will extract into the staging directory, and so into the home. */
function bytesToStage(plan: PlanItem[]): number {
  return plan.reduce((total, { entry, action }) => (writesContent(action) && entry.type === "file" ? total + (entry.size ?? 0) : total), 0);
}

/** Refuses a restore whose files would not leave the home's disk room for the gateway to keep writing. */
function assertRoomToStage(options: RestoreOptions, home: string, staged: number): void {
  const reason = insufficientSpace(home, staged, options.diskSpace);
  if (reason) throw new Error(`${reason}; nothing was restored`);
}

interface Snapshot {
  id: string;
  file: string;
  manifest: BackupManifest;
}

/** The paths whose present contents or permissions the plan is about to do away with. */
function pathsOverwritten(plan: PlanItem[]): string[] {
  return plan.filter(({ action }) => action === "replace" || action === "mode").map(({ entry }) => entry.path);
}

/**
 * Archives what the restore is about to overwrite, as it stands, so that it can
 * be had back: the files the plan replaces and the ones whose permissions it
 * changes. Not the rest of the home. A snapshot of everything made a restore
 * of one file archive the whole home first, and a home that had grown past the
 * limits since its last backup could then restore nothing at all.
 *
 * Null when the plan overwrites nothing: what a restore only creates leaves
 * nothing to go back to. It needs room too, and when it shares a disk with the
 * home, room beside the files about to be staged there.
 */
async function snapshotCurrentState(options: RestoreOptions, home: string, staged: number, plan: PlanItem[]): Promise<Snapshot | null> {
  const overwritten = pathsOverwritten(plan);
  if (overwritten.length === 0) return null;
  const { id, file } = reserveArchiveName(options.backupDirectory, "pre-restore", options.now);
  const alsoStaged = sameFilesystem(home, options.backupDirectory) ? staged : 0;
  try {
    const { manifest } = await createHomeArchive({
      home, destination: file, id, createdAt: options.now, excludePaths: [options.backupDirectory],
      limits: options.limits ?? DEFAULT_ARCHIVE_LIMITS,
      only: overwritten,
      beforeWrite: ({ bytes }) => {
        const reason = insufficientSpace(options.backupDirectory, bytes + alsoStaged, options.diskSpace);
        if (reason) throw new Error(reason);
      },
    });
    return { id, file, manifest };
  } catch (error) {
    if (error instanceof NothingToArchiveError) return null;
    if (error instanceof ArchiveTooLargeError) {
      // Not the home: only what this restore would replace. So the ways out are to replace less, or to allow more.
      throw new Error(
        `what this restore would replace is too much to save first, so nothing was restored: ${errorMessage(error)}. `
        + "Only the files about to be replaced are saved. Restore fewer kinds at a time with --only, "
        + "or raise backup.maxArchiveMb / backup.maxEntries in config.yaml, and run the restore again.",
      );
    }
    throw new Error(`the current state could not be saved first, so nothing was restored: ${errorMessage(error)}`);
  }
}

/**
 * Stops a restore that would overwrite something the snapshot does not hold.
 *
 * The snapshot leaves out what it cannot read and reports it as skipped; that
 * is right for a backup and wrong as the last word before a replacement. If the
 * file about to be replaced is not in the snapshot just taken, "the previous
 * state was saved" would be false for exactly the file that matters. Checked
 * against the snapshot's own manifest, path by path, so it does not depend on
 * a list of skips that is only kept up to a point.
 */
function refuseToReplaceUnsaved(plan: PlanItem[], snapshot: Snapshot | null): void {
  const unsaved = pathsOverwritten(plan)
    .filter((entryPath) => !snapshot || !findManifestEntry(snapshot.manifest.entries, entryPath))
    .map((entryPath) => {
      const why = snapshot?.manifest.skipped.find((skipped) => skipped.path === entryPath)?.reason;
      return why ? `${entryPath} (${why})` : entryPath;
    });
  if (unsaved.length === 0) return;
  // The snapshot is of a restore that is not going to happen.
  if (snapshot) fs.rmSync(snapshot.file, { force: true });
  throw new Error(
    `${listed(unsaved)} could not be saved before being replaced, so nothing was restored. `
    + "Make it readable or move it out of the way, and run the restore again.",
  );
}

/**
 * The directory a restore extracts into before anything is moved into place,
 * and a record of every file it puts there.
 *
 * The record is what lets the directory be cleared away safely. It used to be
 * removed with a recursive delete, and a recursive delete walks paths: swap a
 * directory inside for a symlink while it walks, and it follows the link and
 * deletes what is on the far side, outside the home. Nothing here is deleted
 * by walking. The files this restore created are removed one by one, by the
 * names it gave them; the directory is removed only if that leaves it empty;
 * and anything else found in it was put there by someone else and stays.
 */
class StagingDirectory {
  /** The files created here, in the order they were made. */
  private readonly made: string[] = [];

  private constructor(readonly directory: string, private readonly device: number, private readonly inode: number) {}

  /** A new, empty, owner-only directory under `scratch`, with a name nobody could have guessed. */
  static createIn(scratch: string): StagingDirectory {
    const directory = fs.mkdtempSync(path.join(scratch, "restore-"));
    const made = fs.lstatSync(directory);
    return new StagingDirectory(directory, made.dev, made.ino);
  }

  /** The next file to extract into. Created exclusively, so that nothing already under its name is written through. */
  create(): { file: string; descriptor: number } {
    const file = path.join(this.directory, String(this.made.length).padStart(6, "0"));
    const descriptor = fs.openSync(file, "wx", 0o600);
    this.made.push(file);
    return { file, descriptor };
  }

  /**
   * Why the directory must be left alone, or null while it is still the one
   * that was made: a real directory, inside a real directory, and the same
   * one - not another that has been put under its name.
   */
  private displaced(): string | null {
    const here = lstatOrNull(this.directory);
    const above = lstatOrNull(path.dirname(this.directory));
    if (above?.isDirectory() && here?.isDirectory() && here.dev === this.device && here.ino === this.inode) return null;
    return `${this.directory} is no longer the directory this restore made, so nothing was removed from it and it was left as it is`;
  }

  /**
   * Clears the directory away: its own files by name, then the directory if
   * that emptied it. Asked before every removal whether this is still the
   * directory that was made, because the names are known and a name removed
   * through a directory that has become a link is somebody else's file.
   * Returns what had to be left, in words, or null when nothing was.
   */
  remove(): string | null {
    if (!lstatOrNull(this.directory)) return null;
    for (const file of this.made) {
      const moved = this.displaced();
      if (moved) return moved;
      try {
        // unlink, which removes a name and nothing under it: a link under that name goes, what it points at does not.
        fs.unlinkSync(file);
      } catch {
        // Already moved into place, or no longer a file of ours. If anything is still there, the directory will not be empty.
      }
    }
    const moved = this.displaced();
    if (moved) return moved;
    try {
      fs.rmdirSync(this.directory);
      return null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? errorMessage(error);
      return `${this.directory} holds something this restore did not put there (${code}), so it was left as it is`;
    }
  }
}

/**
 * Extracts the files the plan needs into a private staging directory, hashing
 * each as it lands. Staging holds flat numbered files and nothing else - no
 * directories, no links - so no entry name from the archive is ever used as a
 * path here, and the archive is held to the manifest that was just verified.
 */
async function stageFiles(
  archive: string,
  staging: StagingDirectory,
  needed: Map<string, ManifestEntry>,
  limits: ArchiveLimits,
): Promise<Map<string, string>> {
  const staged = new Map<string, string>();
  // The one descriptor that may still be open if the archive fails mid-entry.
  const open: { descriptor?: number } = {};
  try {
    await readHomeArchive(archive, (entry) => {
      const expected = needed.get(entry.path);
      if (!expected || entry.type !== "file" || staged.has(entry.path)) return undefined;
      const hash = crypto.createHash("sha256");
      const { file, descriptor } = staging.create();
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
    }, limits);
  } finally {
    if (open.descriptor !== undefined) fs.closeSync(open.descriptor);
  }
  const missing = [...needed.keys()].filter((entryPath) => !staged.has(entryPath));
  if (missing.length > 0) throw new Error(`the archive no longer holds ${listed(missing)}; it changed underneath the restore`);
  return staged;
}

/**
 * Asks again, at the moment of writing, that every directory from the home
 * down to `entryPath` is a real directory. The plan established this once, but
 * the plan was made before the current state was saved, which takes seconds in
 * a large home, and a directory swapped for a symlink in that time would be
 * written through. Every level is looked at, not only the last: through a link
 * higher up, the immediate parent is a perfectly real directory - elsewhere.
 *
 * What remains is the instant between this check and the write that follows
 * it. Closing that takes resolving each component against an open directory
 * (openat, renameat), which Node does not offer.
 */
function assertParentsAreDirectories(home: string, entryPath: string): void {
  if (!lstatOrNull(home)?.isDirectory()) throw new Error(`${home} is no longer a directory`);
  for (const ancestor of ancestorsOf(entryPath)) {
    if (!lstatOrNull(absolutePathOf(home, ancestor))?.isDirectory()) throw new Error(`${ancestor} is no longer a directory`);
  }
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

/**
 * Puts back the permissions of a file whose content already matches. Checked
 * again that it is still a plain file: chmod follows a symlink, and the plan
 * was made a moment ago.
 */
function restoreMode(destination: string, mode: number): void {
  if (!lstatOrNull(destination)?.isFile()) throw new Error(`${destination} is no longer a regular file`);
  fs.chmodSync(destination, mode & 0o777);
}

function placeSymlink(destination: string, target: string): void {
  const temporary = `${destination}.restore-${crypto.randomBytes(4).toString("hex")}`;
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, destination);
}

function applyPlan(home: string, plan: PlanItem[], staged: Map<string, string>): void {
  for (const { entry, action } of plan) {
    if (action === "unchanged") continue;
    assertParentsAreDirectories(home, entry.path);
    const destination = absolutePathOf(home, entry.path);
    if (action === "mode") restoreMode(destination, entry.mode);
    else if (entry.type === "directory") makeDirectory(destination, entry.mode);
    else if (entry.type === "symlink") placeSymlink(destination, entry.target ?? "");
    else placeFile(staged.get(entry.path)!, destination, entry.mode);
  }
}

/**
 * Where files are extracted before they are moved into place: the home's own
 * tmp/. It has to be a real directory. A symlink there would have the contents
 * of whatever is being restored - config.yaml and its tokens among them -
 * written wherever it points, outside the home.
 */
function stagingParent(home: string): string {
  const scratch = inHome(home, TMP_DIR);
  const stat = lstatOrNull(scratch);
  if (stat?.isSymbolicLink()) {
    throw new Error(
      `${scratch} is a symlink (to ${fs.readlinkSync(scratch)}). Files are extracted there on their way back and must not leave the home: `
      + "replace it with a real directory and run the restore again; nothing was restored",
    );
  }
  if (stat && !stat.isDirectory()) {
    throw new Error(`${scratch} is not a directory, and files are extracted there on their way back; nothing was restored`);
  }
  return scratch;
}

/** Extracts what the plan needs into `staging` and moves it into place. */
async function extractAndPlace(
  options: RestoreOptions,
  home: string,
  plan: PlanItem[],
  preRestore: { id: string } | null,
  staging: StagingDirectory,
): Promise<void> {
  const needed = new Map(plan
    .filter((item) => writesContent(item.action) && item.entry.type === "file")
    .map((item) => [item.entry.path, item.entry]));
  const staged = await stageFiles(options.archive, staging, needed, options.limits ?? DEFAULT_ARCHIVE_LIMITS);
  try {
    applyPlan(home, plan, staged);
  } catch (error) {
    // Said exactly: going back is itself a restore, and a restore deletes nothing.
    const way = preRestore
      ? ` The state before it is saved as ${preRestore.id}: restoring that puts back what was overwritten. `
        + "Files this restore had already created are not removed by it."
      : "";
    throw new Error(`the restore stopped partway: ${errorMessage(error)}.${way}`);
  }
}

/**
 * Writes the plan into the home through a working directory under its tmp/,
 * and clears that directory away whichever way it ends. Returns what there is
 * to warn about; a failure carries the same in its message.
 */
async function writeIntoHome(options: RestoreOptions, home: string, plan: PlanItem[], preRestore: { id: string } | null): Promise<string[]> {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Asked again here, at the moment of use; the first time was before the snapshot.
  const scratch = stagingParent(home);
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const staging = StagingDirectory.createIn(scratch);
  let failure: unknown;
  try {
    await extractAndPlace(options, home, plan, preRestore, staging);
  } catch (error) {
    failure = error ?? new Error("the restore failed");
  }
  const left = staging.remove();
  if (failure) throw left ? new Error(`${errorMessage(failure)} ${left}.`, { cause: failure }) : failure;
  return left ? [left] : [];
}

/**
 * Restores files from a home archive into `home`.
 *
 * Nothing is written until the archive has been read end to end and checked
 * against its manifest, the plan has been worked out, and what the plan will
 * overwrite has been archived as it stands, as a pre-restore snapshot. Files
 * are then extracted into a staging directory, verified again, and moved into
 * place.
 *
 * A restore brings back what the archive has. It deletes nothing: a file added
 * to the home since the backup stays where it is and is reported as untouched.
 * It writes only under the paths a home archive is made of, never through a
 * symlink, and never recreates a symlink leading out of the home unless asked.
 */
export async function restoreHomeArchive(options: RestoreOptions): Promise<RestoreResult> {
  const limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS;
  const inspection = await (options.inspect ?? inspectHomeArchive)(options.archive, { limits });
  if (!inspection.ok || !inspection.manifest) {
    throw new Error(`refusing to restore an archive that failed verification - ${listed(inspection.problems)}`);
  }
  const manifest = inspection.manifest;
  const home = fs.existsSync(options.home) ? fs.realpathSync(options.home) : path.resolve(options.home);
  const selected = selectEntries(manifest, options.only);
  const plan = buildPlan(home, manifest, selected);
  if (!options.allowExternalSymlinks) refuseExternalSymlinks([home, path.resolve(options.home)], plan);
  const kinds = BACKUP_KINDS.filter((kind) => selected.some((entry) => kindOf(entry) === kind));
  const changes = plan
    .filter((item): item is PlanItem & { action: Exclude<RestoreAction, "unchanged"> } => item.action !== "unchanged")
    .map((item) => ({ path: item.entry.path, type: item.entry.type, kind: kindOf(item.entry), action: item.action }));
  const result: RestoreResult = {
    id: manifest.id,
    archive: options.archive,
    home,
    dryRun: options.dryRun === true,
    kinds,
    changes,
    unchanged: plan.length - changes.length,
    untouched: await untouchedInHome(home, manifest, kinds, options.backupDirectory, limits),
    ignored: manifest.entries.filter((entry) => kindOf(entry) === null && !holdsATarget(entry.path)).map((entry) => entry.path),
    preRestore: null,
    warnings: [],
  };
  if (result.dryRun || changes.length === 0) return result;

  stagingParent(home);
  const staged = bytesToStage(plan);
  assertRoomToStage(options, home, staged);
  const snapshot = await snapshotCurrentState(options, home, staged, plan);
  refuseToReplaceUnsaved(plan, snapshot);
  const preRestore = snapshot ? { id: snapshot.id, file: snapshot.file } : null;
  const warnings = await writeIntoHome(options, home, plan, preRestore);
  return { ...result, preRestore, warnings };
}
