import path from "node:path";
import { isShippedFile, type BundledSkill } from "./bundled.js";
import { TooLargeError } from "./bounded-read.js";
import { matchShippedVersion, type ShippedHistory } from "./history.js";
import { hashFiles, inspectHomeSkill } from "./home-skill.js";
import { assertSkillName, own, pathsBeyond, sameList } from "./names.js";
import type { Receipt, ReceiptSkill } from "./receipt.js";
import type { KeepReason } from "./types.js";

type Hashes = Record<string, string>;

/** What the sync intends for one skill. Only install, update and retire touch a skill
 *  directory; adopt and forget change the receipt alone. `observed` is the content the
 *  decision was made on, re-checked before anything is moved. */
export type SkillPlan =
  | { action: "install"; name: string; skill: BundledSkill }
  | { action: "update"; name: string; skill: BundledSkill; observed: Hashes }
  | { action: "adopt"; name: string; observed: Hashes }
  | { action: "retire"; name: string; observed: Hashes }
  | { action: "forget"; name: string }
  | { action: "current"; name: string }
  | { action: "keep"; name: string; reason: KeepReason };

/** The one place a skill name becomes a path. */
export function skillDirectory(skillsRoot: string, name: string): string {
  assertSkillName(name, "The sync");
  return path.join(skillsRoot, name);
}

/**
 * Decide, for every skill the package ships and every skill the receipt remembers,
 * what the sync may do. Reads only: nothing is written while planning, so a name or
 * a package that fails validation refuses the run before it has changed anything.
 */
export interface PlanInput {
  skillsRoot: string;
  bundled: readonly BundledSkill[];
  receipt: Receipt | null;
  /** Put back shipped skills the operator deleted: all of them, or only the ones
   *  named. Only `ryoko migrate --restore-deleted-skills` asks for this. */
  restoreDeleted: boolean | readonly string[];
  /** What earlier releases shipped, for homes that predate the receipt. */
  history: ShippedHistory;
  /** Placeholder values the installer could have used when it placed a skill. */
  renderings: readonly Record<string, string>[];
}

export function planSkillSync(input: PlanInput): SkillPlan[] {
  const recorded = input.receipt?.skills ?? {};
  const shipped = new Set(input.bundled.map((skill) => skill.name));
  // Being listed in the receipt is not enough to be retired: the receipt is a file in
  // the home, and an entry describing the user's own skill would have it moved away.
  // Only a name the package itself knows it once shipped can be a retired skill.
  const retired = Object.keys(recorded).filter((name) => !shipped.has(name) && input.history.names.has(name)).sort();
  return [
    ...input.bundled.map((skill) => planShipped(input, skill, own(recorded, skill.name))),
    ...retired.map((name) => planRetired(input.skillsRoot, name, recorded[name])),
  ];
}

function planShipped(input: PlanInput, skill: BundledSkill, entry: ReceiptSkill | undefined): SkillPlan {
  const name = skill.name;
  const directory = skillDirectory(input.skillsRoot, name);
  const home = inspectHomeSkill(directory);
  if (home.kind === "missing") {
    // No record of placing it: a skill this home never had (or a first run), so it is
    // installed. A record means the operator removed what we placed, and that stands —
    // unless the record says we were in the middle of replacing it: then the process
    // died between moving the old copy out and the new one in, and it is put back.
    const deleted = entry !== undefined && !entry.replacing && !isRestoreRequested(input.restoreDeleted, name);
    return deleted ? { action: "keep", name, reason: "deleted" } : { action: "install", name, skill };
  }
  if (home.kind !== "directory") return { action: "keep", name, reason: home.kind };

  const shippedPaths = Object.keys(skill.files).sort();
  const likeShipped = sameList(home.paths, shippedPaths);
  // What the home holds beyond the files the receipt records; null without a record,
  // or when one of the recorded files is gone.
  const beyondRecord = entry ? pathsBeyond(home.paths, Object.keys(entry.files)) : null;
  const likeRecorded = beyondRecord !== null && beyondRecord.length === 0;
  // Every file beyond the record sits at a path the package ships today: possibly what
  // a restore from an older backup left. A file anywhere else is the user's, and that
  // is settled without reading anything.
  const maybeRestored = beyondRecord !== null && beyondRecord.length > 0 && beyondRecord.every((file) => own(skill.files, file) !== undefined);
  // A different set of files is already an answer; hash only when content decides.
  const observed = likeShipped || likeRecorded || maybeRestored ? readHashes(directory, home.paths) : null;
  if (typeof observed === "string") return { action: "keep", name, reason: observed };

  const current = observed !== null && likeShipped && home.paths.every((file) => isShippedFile(skill.files[file], observed[file]));
  const untouched = observed !== null && entry !== undefined && beyondRecord !== null
    && isUntouched(skill, entry, beyondRecord, observed);
  const pristine = untouched && likeRecorded;
  if (current) return pristine ? { action: "current", name } : { action: "adopt", name, observed };
  if (untouched && observed !== null) return { action: "update", name, skill, observed };
  if (entry) return { action: "keep", name, reason: hasShippedChanged(skill, entry) ? "modified" : "customized" };
  // No receipt entry. The one thing that still proves the copy untouched is that it
  // is, file for file, a version an earlier release installed — alone, or beside
  // files that are exactly the ones the package ships today.
  const earlier = matchEarlierRelease(directory, home.paths, own(input.history.versions, name) ?? [], input.renderings, skill.files);
  if (typeof earlier === "string") return { action: "keep", name, reason: earlier };
  return earlier ? { action: "update", name, skill, observed: earlier } : { action: "keep", name, reason: "unmanaged" };
}

/**
 * Is the copy in the home one nobody has edited since the sync placed it? Every file
 * the receipt records has to be there, unchanged. And if the home holds files beyond
 * those, each has to be, byte for byte, the file the package ships today at that path.
 *
 * That second case is what restoring skills/ from a backup leaves behind. The restore
 * writes back what its archive holds and removes nothing: a skill the sync replaced
 * since the backup, with a version that has more files, comes out as the old files,
 * the old receipt, and the newer version's extra files. No edit made that. A file of
 * the user's own beyond the record, or one that is not exactly the shipped file, is
 * still an edit, and the skill is then left alone as before.
 */
function isUntouched(skill: BundledSkill, entry: ReceiptSkill, beyondRecord: readonly string[], observed: Hashes): boolean {
  return Object.keys(entry.files).every((file) => observed[file] === entry.files[file])
    && beyondRecord.every((file) => {
      const shipped = own(skill.files, file);
      return shipped !== undefined && isShippedFile(shipped, observed[file]);
    });
}

function planRetired(skillsRoot: string, name: string, entry: ReceiptSkill): SkillPlan {
  const directory = skillDirectory(skillsRoot, name);
  const home = inspectHomeSkill(directory);
  if (home.kind === "missing") return { action: "forget", name };
  if (home.kind !== "directory") return { action: "keep", name, reason: home.kind };
  if (!sameList(home.paths, Object.keys(entry.files).sort())) return { action: "keep", name, reason: "retired-modified" };
  const observed = readHashes(directory, home.paths);
  if (typeof observed === "string") return { action: "keep", name, reason: observed };
  return home.paths.every((file) => observed[file] === entry.files[file])
    ? { action: "retire", name, observed }
    : { action: "keep", name, reason: "retired-modified" };
}

/** Names are only ever compared, never joined to a path, so they need no checking. */
function isRestoreRequested(restoreDeleted: boolean | readonly string[], name: string): boolean {
  return restoreDeleted === true || (Array.isArray(restoreDeleted) && restoreDeleted.includes(name));
}

/** Has the package moved on from the content the receipt says we placed? */
function hasShippedChanged(skill: BundledSkill, entry: ReceiptSkill): boolean {
  const shippedPaths = Object.keys(skill.files).sort();
  return !sameList(shippedPaths, Object.keys(entry.files).sort())
    || !shippedPaths.every((file) => isShippedFile(skill.files[file], entry.files[file]));
}

/** Why a skill's files could not be read: either way, the skill is left alone. */
type Unread = "unreadable" | "too-large";
const unread = (error: unknown): Unread => (error instanceof TooLargeError ? "too-large" : "unreadable");

function readHashes(directory: string, paths: readonly string[]): Hashes | Unread {
  try { return hashFiles(directory, paths); }
  catch (error) { return unread(error); }
}

function matchEarlierRelease(...args: Parameters<typeof matchShippedVersion>): Hashes | null | Unread {
  try { return matchShippedVersion(...args); }
  catch (error) { return unread(error); }
}
