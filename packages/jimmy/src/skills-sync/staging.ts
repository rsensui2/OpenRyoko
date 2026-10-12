import fs from "node:fs";
import path from "node:path";
import { listBounded } from "./bounded-read.js";
import { inspectHomeSkill } from "./home-skill.js";

/**
 * Skills are built in <home>/.bundled-skill-XXXXXX before they are moved into place:
 * outside skills/, so a running gateway never discovers a half-written skill, and on
 * the home's own filesystem, so the move is a rename.
 */
export const STAGING_PREFIX = ".bundled-skill-";

/** The prefix, and the six characters mkdtemp appends to it. */
const STAGING_NAME = /^\.bundled-skill-[A-Za-z0-9]{6}$/;
/** A sync stages and moves a skill within seconds. One untouched this long was abandoned. */
const ABANDONED_AFTER_MS = 60 * 60 * 1000;
/** A few crashes leave a few directories. Past this, the rest wait for the next run. */
const MAX_CLEARED_PER_RUN = 32;

/**
 * Remove the staging directories that a sync which died left in the home, and return
 * their names, sorted.
 *
 * The home is the user's, so a directory goes only when everything about it says a
 * sync made it: the name mkdtemp gave it; a real directory, not a link; untouched for
 * long enough that no running sync can be using it; and nothing in it but skills the
 * package ships or once shipped, as plain files and directories. Anything else stays
 * exactly where it is. So does a directory that cannot be removed: clearing up is
 * never a reason for the sync to fail.
 */
export function removeAbandonedStaging(home: string, skillNames: ReadonlySet<string>, now: Date): string[] {
  const removed: string[] = [];
  for (const name of stagingNames(home)) {
    const directory = path.join(home, name);
    try {
      if (!isAbandonedStaging(directory, skillNames, now)) continue;
      fs.rmSync(directory, { recursive: true });
      removed.push(name);
    } catch {
      // Left for the next run.
    }
  }
  return removed.sort();
}

/** Read one entry at a time: the home can hold any number of them. */
function stagingNames(home: string): string[] {
  const names: string[] = [];
  let directory: fs.Dir;
  try { directory = fs.opendirSync(home); }
  catch { return names; }
  try {
    for (let entry = directory.readSync(); entry !== null && names.length < MAX_CLEARED_PER_RUN; entry = directory.readSync()) {
      if (STAGING_NAME.test(entry.name)) names.push(entry.name);
    }
  } catch {
    // What was found before the listing failed is still worth looking at.
  } finally {
    directory.closeSync();
  }
  return names;
}

function isAbandonedStaging(directory: string, skillNames: ReadonlySet<string>, now: Date): boolean {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory()) return false;
  if (now.getTime() - stat.mtimeMs < ABANDONED_AFTER_MS) return false;
  // One directory per skill, so never more of them than there are skills.
  const staged = listBounded(directory, skillNames.size);
  return staged !== null
    && staged.every((name) => skillNames.has(name) && inspectHomeSkill(path.join(directory, name)).kind === "directory");
}
