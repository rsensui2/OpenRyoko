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

/** lstat that reports a vanished path as absent and anything else as skipped. */
function inspect(state: WalkState, relativePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(absolutePathOf(state.home, relativePath));
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
function recordSymlink(state: WalkState, relativePath: string, stat: fs.Stats): string | null {
  try {
    const linkTarget = fs.readlinkSync(absolutePathOf(state.home, relativePath));
    record(state, relativePath, stat, "symlink", linkTarget);
    return linkTarget;
  } catch (error) {
    state.skipped.push({ path: relativePath, reason: `link could not be read (${errorCode(error)})` });
    return null;
  }
}

/** Classifies one path. Returns true when it is a directory the walk should descend into. */
function visit(state: WalkState, relativePath: string): boolean {
  const stat = inspect(state, relativePath);
  if (!stat) return false;
  if (stat.isSymbolicLink()) {
    recordSymlink(state, relativePath, stat);
    return false;
  }
  if (stat.isDirectory()) {
    if (isExcludedPath(relativePath, true) || state.excluded.has(absolutePathOf(state.home, relativePath))) return false;
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

function walkDirectory(state: WalkState, start: string): void {
  const pending = [start];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(absolutePathOf(state.home, directory)).sort();
    } catch (error) {
      state.skipped.push({ path: directory, reason: `could not be listed (${errorCode(error)})` });
      continue;
    }
    for (const name of names) {
      const child = `${directory}/${name}`;
      if (visit(state, child)) pending.push(child);
    }
  }
}

/**
 * Makes sure the directories above a nested target (`cron` for `cron/runs`) are
 * real directories, and records them. A symlink there is not followed either -
 * the target is reported as left out instead.
 */
function enterParents(state: WalkState, target: string): boolean {
  const segments = target.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const parent = segments.slice(0, depth).join("/");
    const stat = inspect(state, parent);
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

function visitTarget(state: WalkState, target: string): void {
  if (!enterParents(state, target)) return;
  const stat = inspect(state, target);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    const linkTarget = recordSymlink(state, target, stat);
    if (linkTarget !== null) {
      state.warnings.push(`${target} is a symlink to ${linkTarget}; what it points at is not in this backup`);
    }
    return;
  }
  if (visit(state, target)) walkDirectory(state, target);
}

/** Lists everything under the archive targets of `home`, without following a single symlink. */
export function collectHomeEntries(home: string, options: { excludePaths?: string[] } = {}): HomeWalk {
  const state: WalkState = {
    home,
    excluded: new Set((options.excludePaths ?? []).map((excluded) => path.resolve(excluded))),
    entries: new Map(),
    skipped: [],
    warnings: [],
  };
  for (const target of HOME_ARCHIVE_TARGETS) {
    for (const root of target.paths) visitTarget(state, root);
  }
  const entries = [...state.entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, skipped: state.skipped, warnings: state.warnings };
}
