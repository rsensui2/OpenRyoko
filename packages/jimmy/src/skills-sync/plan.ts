import path from "node:path";
import type { BundledFile, BundledSkill } from "./bundled.js";
import { TooLargeError } from "./bounded-read.js";
import { matchShippedVersion, type ShippedHistory } from "./history.js";
import { hashFiles, inspectHomeSkill } from "./home-skill.js";
import { assertSkillName, own, sameList } from "./names.js";
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
  const retired = Object.keys(recorded).filter((name) => !shipped.has(name)).sort();
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
    // installed. A record means the operator removed what we placed, and that stands.
    return entry && !isRestoreRequested(input.restoreDeleted, name) ? { action: "keep", name, reason: "deleted" } : { action: "install", name, skill };
  }
  if (home.kind !== "directory") return { action: "keep", name, reason: home.kind };

  const shippedPaths = Object.keys(skill.files).sort();
  const recordedPaths = entry ? Object.keys(entry.files).sort() : null;
  const likeShipped = sameList(home.paths, shippedPaths);
  const likeRecorded = recordedPaths !== null && sameList(home.paths, recordedPaths);
  // A different set of files is already an answer; hash only when content decides.
  const observed = likeShipped || likeRecorded ? readHashes(directory, home.paths) : null;
  if (typeof observed === "string") return { action: "keep", name, reason: observed };

  const current = observed !== null && likeShipped && home.paths.every((file) => isShipped(skill.files[file], observed[file]));
  const pristine = observed !== null && entry !== undefined && likeRecorded && home.paths.every((file) => observed[file] === entry.files[file]);
  if (current) return pristine ? { action: "current", name } : { action: "adopt", name, observed };
  if (pristine) return { action: "update", name, skill, observed };
  if (entry) return { action: "keep", name, reason: hasShippedChanged(skill, entry) ? "modified" : "customized" };
  // No receipt entry. The one thing that still proves the copy untouched is that it
  // is, file for file, a version an earlier release installed.
  const earlier = matchEarlierRelease(directory, home.paths, own(input.history.versions, name) ?? [], input.renderings);
  if (typeof earlier === "string") return { action: "keep", name, reason: earlier };
  return earlier ? { action: "update", name, skill, observed: earlier } : { action: "keep", name, reason: "unmanaged" };
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

/** A file matches the shipped one as installed, or as packaged (placeholders unfilled). */
function isShipped(file: BundledFile, hash: string): boolean {
  return hash === file.sha256 || hash === file.rawSha256;
}

/** Has the package moved on from the content the receipt says we placed? */
function hasShippedChanged(skill: BundledSkill, entry: ReceiptSkill): boolean {
  const shippedPaths = Object.keys(skill.files).sort();
  return !sameList(shippedPaths, Object.keys(entry.files).sort())
    || !shippedPaths.every((file) => isShipped(skill.files[file], entry.files[file]));
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
