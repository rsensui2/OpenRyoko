import fs from "node:fs";
import path from "node:path";
import { formatBytes } from "./format.js";
import { ArchiveTooLargeError, MAX_RECORDED_ITEMS, pathByteLimit, type ArchiveLimits } from "./limits.js";
import type { SkippedEntry } from "./manifest.js";
import { HOME_ARCHIVE_TARGETS, isExcludedPath, TOP_LEVEL_FILE_TARGETS } from "./targets.js";

/** One thing in the home the archive will carry. */
export interface HomeEntry {
  /** Home-relative, slash-separated. */
  path: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  size: number;
  mtimeSeconds: number;
  linkTarget?: string;
}

export interface HomeWalk {
  /** Sorted by path, so a directory always precedes what it holds. */
  entries: HomeEntry[];
  /** Bytes of file content among them. */
  bytes: number;
  /** The first of what was left out; `skippedCount` is how many there were. */
  skipped: SkippedEntry[];
  skippedCount: number;
  warnings: string[];
}

interface WalkState {
  home: string;
  limits: ArchiveLimits;
  /** Home-relative paths of directories the walk must not enter. */
  excluded: Set<string>;
  entries: Map<string, HomeEntry>;
  bytes: number;
  /** Entries and bytes under each top-level name, to say what is large when a limit is hit. */
  weight: Map<string, { entries: number; bytes: number }>;
  skipped: SkippedEntry[];
  skippedCount: number;
  /** Names a directory listed that then could not be opened. */
  unopened: number;
  warnings: string[];
}

export function absolutePathOf(home: string, relativePath: string): string {
  return path.join(home, ...relativePath.split("/"));
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));
}

async function realPathOrSelf(target: string): Promise<string> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Where each excluded directory sits inside the home, as a home-relative path.
 * Compared by real path: the home may be reached through a symlink while the
 * backup directory is named by its real location, or the reverse, and a
 * mismatch here means every archive swallows the archives before it.
 */
async function excludedInside(home: string, excludePaths: string[]): Promise<Set<string>> {
  const realHome = await realPathOrSelf(home);
  const inside = new Set<string>();
  for (const excluded of excludePaths) {
    const relative = path.relative(realHome, await realPathOrSelf(excluded));
    if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    inside.add(relative.split(path.sep).join("/"));
  }
  return inside;
}

/** Counts something left out, and keeps the first of them: the list is for reading, the count is the truth. */
function noteSkipped(state: WalkState, relativePath: string, reason: string): void {
  state.skippedCount += 1;
  if (state.skipped.length < MAX_RECORDED_ITEMS) state.skipped.push({ path: relativePath, reason });
}

function heaviest(state: WalkState, by: "entries" | "bytes"): string {
  return [...state.weight.entries()]
    .sort((a, b) => b[1][by] - a[1][by])
    .slice(0, 3)
    .map(([name, weight]) => `${name} ${by === "bytes" ? formatBytes(weight.bytes) : weight.entries}`)
    .join(", ");
}

/**
 * Adds one entry, and stops the walk the moment it is one too many. Stopping
 * here rather than after the listing is the point: the walk runs inside the
 * gateway, and a home flooded with empty files must not be held in memory
 * whole before it is found to be too large.
 */
function record(state: WalkState, relativePath: string, stat: fs.Stats, type: HomeEntry["type"], linkTarget?: string): void {
  const size = type === "file" ? stat.size : 0;
  const top = relativePath.split("/", 1)[0]!;
  const weight = state.weight.get(top) ?? { entries: 0, bytes: 0 };
  state.weight.set(top, { entries: weight.entries + 1, bytes: weight.bytes + size });
  state.bytes += size;
  if (state.entries.size + 1 > state.limits.maxEntries) {
    throw new ArchiveTooLargeError(
      `the home holds more than ${state.limits.maxEntries} files and directories to archive (backup.maxEntries); `
      + `nothing was written. Most so far are under: ${heaviest(state, "entries")}`,
    );
  }
  if (state.bytes > state.limits.maxBytes) {
    throw new ArchiveTooLargeError(
      `the home holds at least ${formatBytes(state.bytes)} to archive, over the ${formatBytes(state.limits.maxBytes)} limit `
      + `(backup.maxArchiveMb); nothing was written. Largest so far: ${heaviest(state, "bytes")}`,
    );
  }
  state.entries.set(relativePath, {
    path: relativePath,
    type,
    mode: stat.mode & 0o7777,
    size,
    mtimeSeconds: Math.max(0, Math.floor(stat.mtimeMs / 1000)),
    ...(linkTarget !== undefined ? { linkTarget } : {}),
  });
}

/**
 * lstat that reports a path that is not there as absent and anything else as
 * skipped.
 *
 * "Not there" is silent for a target the home simply does not have. It is not
 * silent for a name the directory itself has just listed: that is a file the
 * backup is leaving out. The usual cause is a name that is not valid UTF-8 -
 * its bytes are replaced on the way into a string, and the path rebuilt from
 * the string leads nowhere - and the other is a file removed in the instant
 * between. Either way it is counted and said.
 */
async function inspect(state: WalkState, relativePath: string, listed = false): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(absolutePathOf(state.home, relativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      noteSkipped(state, relativePath, `could not be read (${errorCode(error)})`);
    } else if (listed) {
      state.unopened += 1;
      noteSkipped(state, relativePath, "was listed but could not be opened (its name may not be valid UTF-8)");
    }
    return null;
  }
}

/**
 * Records a symlink as the link it is. Its target is never opened: `skills/`
 * holds links the operator made into directories outside the home, and
 * following one would pull an unbounded tree into the archive - or, on restore,
 * write through it.
 */
async function recordSymlink(state: WalkState, relativePath: string, stat: fs.Stats): Promise<string | null> {
  let linkTarget: string;
  try {
    linkTarget = await fs.promises.readlink(absolutePathOf(state.home, relativePath));
  } catch (error) {
    noteSkipped(state, relativePath, `link could not be read (${errorCode(error)})`);
    return null;
  }
  const limit = pathByteLimit(state.limits);
  if (Buffer.byteLength(linkTarget) > limit) {
    noteSkipped(state, relativePath, `link target longer than ${limit} bytes`);
    return null;
  }
  record(state, relativePath, stat, "symlink", linkTarget);
  return linkTarget;
}

/**
 * Classifies one path. Resolves true when it is a directory the walk should
 * descend into. `listed` says the name came out of a directory listing rather
 * than from the list of targets.
 */
async function visit(state: WalkState, relativePath: string, listed = false): Promise<boolean> {
  const limit = pathByteLimit(state.limits);
  if (Buffer.byteLength(relativePath) > limit) {
    // Not listed any further either: what is under a path this long is longer still.
    noteSkipped(state, relativePath, `path longer than ${limit} bytes`);
    return false;
  }
  const stat = await inspect(state, relativePath, listed);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    await recordSymlink(state, relativePath, stat);
    return false;
  }
  if (stat.isDirectory()) {
    if (isExcludedPath(relativePath, true) || state.excluded.has(relativePath)) return false;
    record(state, relativePath, stat, "directory");
    return true;
  }
  if (!stat.isFile()) {
    noteSkipped(state, relativePath, "not a regular file");
    return false;
  }
  if (!isExcludedPath(relativePath, false)) record(state, relativePath, stat, "file");
  return false;
}

/**
 * Hands `each` the names in a directory one at a time. Never `readdir`: that
 * returns every name as one array, so a single directory flooded with files is
 * held whole in memory before the first of them has been counted, and the entry
 * limit arrives too late to matter. The order is whatever the filesystem gives;
 * the entries are sorted once, at the end.
 */
async function eachName(state: WalkState, directory: string, each: (name: string) => Promise<void>): Promise<void> {
  let listing: fs.Dir;
  try {
    listing = await fs.promises.opendir(directory === "." ? state.home : absolutePathOf(state.home, directory));
  } catch (error) {
    // A home that is not there has nothing in it; anything else is worth saying.
    if (directory !== "." || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      noteSkipped(state, directory, `could not be listed (${errorCode(error)})`);
    }
    return;
  }
  try {
    for (;;) {
      let child: fs.Dirent | null;
      try {
        child = await listing.read();
      } catch (error) {
        noteSkipped(state, directory, `could not be listed (${errorCode(error)})`);
        return;
      }
      if (!child) return;
      await each(child.name);
    }
  } finally {
    await listing.close().catch(() => { /* already closed */ });
  }
}

async function walkDirectory(state: WalkState, start: string): Promise<void> {
  const pending = [start];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    await eachName(state, directory, async (name) => {
      const child = `${directory}/${name}`;
      if (await visit(state, child, true)) pending.push(child);
    });
  }
}

/**
 * Makes sure the directories above a nested target (`cron` for `cron/runs`) are
 * real directories, and records them. A symlink there is not followed either -
 * the target is reported as left out instead.
 */
async function enterParents(state: WalkState, target: string): Promise<boolean> {
  const segments = target.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const parent = segments.slice(0, depth).join("/");
    const stat = await inspect(state, parent);
    if (!stat) return false;
    if (stat.isSymbolicLink()) {
      state.warnings.push(`${parent} is a symlink, so ${target} was not followed and is not in this backup`);
      return false;
    }
    if (!stat.isDirectory()) return false;
    if (!state.entries.has(parent)) record(state, parent, stat, "directory");
  }
  return true;
}

/** Records a target that is itself a symlink, and warns: the thing the operator meant to back up is elsewhere. */
async function recordTargetSymlink(state: WalkState, target: string, stat: fs.Stats): Promise<void> {
  const linkTarget = await recordSymlink(state, target, stat);
  if (linkTarget !== null) {
    state.warnings.push(`${target} is a symlink to ${linkTarget}; what it points at is not in this backup`);
  }
}

async function visitTarget(state: WalkState, target: string): Promise<void> {
  if (!(await enterParents(state, target))) return;
  const stat = await inspect(state, target);
  if (!stat) return;
  if (stat.isSymbolicLink()) return recordTargetSymlink(state, target, stat);
  if (await visit(state, target)) await walkDirectory(state, target);
}

/**
 * Takes the files directly in the home whose name matches `pattern`. Only
 * files: a directory with a matching name is somebody's folder, not a
 * document, and is left for the named targets to claim or not.
 */
async function visitTopLevelFiles(state: WalkState, pattern: RegExp): Promise<void> {
  await eachName(state, ".", async (name) => {
    if (!pattern.test(name) || state.entries.has(name)) return;
    const stat = await inspect(state, name, true);
    if (!stat || stat.isDirectory()) return;
    if (stat.isSymbolicLink()) await recordTargetSymlink(state, name, stat);
    else if (stat.isFile()) record(state, name, stat, "file");
    else noteSkipped(state, name, "not a regular file");
  });
}

/**
 * Takes one path as it stands - a file or a link, with the directories above
 * it - and nothing around it. A directory there is recorded and not entered:
 * this is for the paths a restore is about to replace, each named on its own.
 */
async function visitPath(state: WalkState, wanted: string): Promise<void> {
  // Looked for first, so that a path that is not there leaves no trace of the directories above it.
  if (!(await inspect(state, wanted))) return;
  if (await enterParents(state, wanted)) await visit(state, wanted);
}

export interface CollectOptions {
  excludePaths?: string[];
  limits: ArchiveLimits;
  /**
   * Home-relative paths to take instead of everything under the archive
   * targets. Nothing else in the home is so much as listed, so a home that as
   * a whole is far past `limits` can still have a few of its files collected.
   */
  only?: readonly string[];
}

/**
 * Lists everything under the archive targets of `home`, without following a
 * single symlink, and gives up with {@link ArchiveTooLargeError} as soon as it
 * has seen more than `limits` allow. Asynchronous throughout: this runs inside
 * the gateway once a day, and a home with a great many files must not stall it
 * while they are counted.
 */
export async function collectHomeEntries(home: string, options: CollectOptions): Promise<HomeWalk> {
  const state: WalkState = {
    home,
    limits: options.limits,
    excluded: await excludedInside(home, options.excludePaths ?? []),
    entries: new Map(),
    bytes: 0,
    weight: new Map(),
    skipped: [],
    skippedCount: 0,
    unopened: 0,
    warnings: [],
  };
  if (options.only) {
    for (const wanted of options.only) await visitPath(state, wanted);
  } else {
    for (const target of HOME_ARCHIVE_TARGETS) {
      for (const root of target.paths) await visitTarget(state, root);
    }
    // After the named paths, so a file one of them already claimed (MEMORY.md) is not taken twice.
    for (const { pattern } of TOP_LEVEL_FILE_TARGETS) await visitTopLevelFiles(state, pattern);
  }
  if (state.unopened > 0) {
    const one = state.unopened === 1;
    state.warnings.push(
      `${state.unopened} name${one ? "" : "s"} listed in the archived directories could not be opened `
      + `and ${one ? "is" : "are"} not in this backup (a file name that is not valid UTF-8 reads this way)`,
    );
  }
  const entries = [...state.entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, bytes: state.bytes, skipped: state.skipped, skippedCount: state.skippedCount, warnings: state.warnings };
}
