import fs from "node:fs";
import path from "node:path";
import { hashBounded, MAX_SKILL_ENTRIES, MAX_SKILL_FILE_BYTES, TooLargeError } from "./bounded-read.js";
import { isHousekeepingFile } from "./names.js";

/** What currently sits at skills/<name> in the instance home. */
export type HomeSkill =
  | { kind: "missing" }
  /** A symlink, or a directory holding a symlink or another non-file: the user's. */
  | { kind: "symlink" }
  | { kind: "not-directory" }
  | { kind: "unreadable"; error: string }
  /** More entries than any skill has: not something to walk or hash at start-up. */
  | { kind: "too-large" }
  /** A plain directory tree. `paths` are sorted and "/"-separated. */
  | { kind: "directory"; paths: string[] };

/** Look without following: every decision is made on lstat, so a link is never
 *  mistaken for the content it happens to point at. */
export function inspectHomeSkill(directory: string): HomeSkill {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return unreadable(error);
  }
  if (stat.isSymbolicLink()) return { kind: "symlink" };
  if (!stat.isDirectory()) return { kind: "not-directory" };
  try {
    const paths = listPlainFiles(directory);
    return paths ? { kind: "directory", paths } : { kind: "symlink" };
  } catch (error) {
    return error instanceof TooLargeError ? { kind: "too-large" } : unreadable(error);
  }
}

/** Sorted file paths, or null when the tree holds anything but files and directories.
 *  Gives up, rather than walking on, once the tree is bigger than a skill can be. */
function listPlainFiles(root: string): string[] | null {
  const found: string[] = [];
  let entries = 0;
  const walk = (directory: string, prefix: string): boolean => {
    for (const entry of fs.readdirSync(directory)) {
      if (++entries > MAX_SKILL_ENTRIES) throw new TooLargeError(`it holds more than ${MAX_SKILL_ENTRIES} files and directories`);
      const full = path.join(directory, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        if (!walk(full, relative)) return false;
      } else if (!stat.isFile()) {
        return false;
      } else if (!isHousekeepingFile(entry)) {
        found.push(relative);
      }
    }
    return true;
  };
  return walk(root, "") ? found.sort() : null;
}

/** Throws TooLargeError when a file is bigger than a skill file can be. */
export function hashFiles(root: string, paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((relative) => [relative, hashBounded(path.join(root, ...relative.split("/")), MAX_SKILL_FILE_BYTES)]),
  );
}

function unreadable(error: unknown): HomeSkill {
  return { kind: "unreadable", error: error instanceof Error ? error.message : String(error) };
}
