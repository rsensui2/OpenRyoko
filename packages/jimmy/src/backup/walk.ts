import fs from "node:fs";
import path from "node:path";
import type { SkippedEntry } from "./manifest.js";
import { HOME_ARCHIVE_TARGETS, isExcludedPath } from "./targets.js";

/** One thing in the home the archive will carry. */
export interface HomeEntry {
  /** Home-relative, slash-separated. */
  path: string;
  absolute: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  size: number;
  mtimeSeconds: number;
  linkTarget?: string;
}

export interface HomeWalk {
  /** Sorted by path, so a directory always precedes what it holds. */
  entries: HomeEntry[];
  skipped: SkippedEntry[];
  warnings: string[];
}

interface WalkState {
  home: string;
  /** Home-relative paths of directories the walk must not enter. */
  excluded: Set<string>;
  entries: Map<string, HomeEntry>;
  skipped: SkippedEntry[];
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

/** lstat that reports a vanished path as absent and anything else as skipped. */
async function inspect(state: WalkState, relativePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(absolutePathOf(state.home, relativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      state.skipped.push({ path: relativePath, reason: `could not be read (${errorCode(error)})` });
    }
    return null;
  }
}

function record(state: WalkState, relativePath: string, stat: fs.Stats, type: HomeEntry["type"], linkTarget?: string): void {
  state.entries.set(relativePath, {
    path: relativePath,
    absolute: absolutePathOf(state.home, relativePath),
    type,
    mode: stat.mode & 0o7777,
    size: type === "file" ? stat.size : 0,
    mtimeSeconds: Math.max(0, Math.floor(stat.mtimeMs / 1000)),
    ...(linkTarget !== undefined ? { linkTarget } : {}),
  });
}

/**
 * Records a symlink as the link it is. Its target is never opened: `skills/`
 * holds links the operator made into directories outside the home, and
 * following one would pull an unbounded tree into the archive - or, on restore,
 * write through it.
 */
async function recordSymlink(state: WalkState, relativePath: string, stat: fs.Stats): Promise<string | null> {
  try {
    const linkTarget = await fs.promises.readlink(absolutePathOf(state.home, relativePath));
    record(state, relativePath, stat, "symlink", linkTarget);
    return linkTarget;
  } catch (error) {
    state.skipped.push({ path: relativePath, reason: `link could not be read (${errorCode(error)})` });
    return null;
  }
}

/** Classifies one path. Resolves true when it is a directory the walk should descend into. */
async function visit(state: WalkState, relativePath: string): Promise<boolean> {
  const stat = await inspect(state, relativePath);
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
    state.skipped.push({ path: relativePath, reason: "not a regular file" });
    return false;
  }
  if (!isExcludedPath(relativePath, false)) record(state, relativePath, stat, "file");
  return false;
}

async function walkDirectory(state: WalkState, start: string): Promise<void> {
  const pending = [start];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let names: string[];
    try {
      names = (await fs.promises.readdir(absolutePathOf(state.home, directory))).sort();
    } catch (error) {
      state.skipped.push({ path: directory, reason: `could not be listed (${errorCode(error)})` });
      continue;
    }
    for (const name of names) {
      const child = `${directory}/${name}`;
      if (await visit(state, child)) pending.push(child);
    }
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

async function visitTarget(state: WalkState, target: string): Promise<void> {
  if (!(await enterParents(state, target))) return;
  const stat = await inspect(state, target);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    const linkTarget = await recordSymlink(state, target, stat);
    if (linkTarget !== null) {
      state.warnings.push(`${target} is a symlink to ${linkTarget}; what it points at is not in this backup`);
    }
    return;
  }
  if (await visit(state, target)) await walkDirectory(state, target);
}

/**
 * Lists everything under the archive targets of `home`, without following a
 * single symlink. Asynchronous throughout: this runs inside the gateway once a
 * day, and a home with a great many files must not stall it while they are
 * counted.
 */
export async function collectHomeEntries(home: string, options: { excludePaths?: string[] } = {}): Promise<HomeWalk> {
  const state: WalkState = {
    home,
    excluded: await excludedInside(home, options.excludePaths ?? []),
    entries: new Map(),
    skipped: [],
    warnings: [],
  };
  for (const target of HOME_ARCHIVE_TARGETS) {
    for (const root of target.paths) await visitTarget(state, root);
  }
  const entries = [...state.entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, skipped: state.skipped, warnings: state.warnings };
}
