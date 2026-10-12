import path from "node:path";
import type { BundledFile, BundledSkill } from "./bundled.js";
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
export function planSkillSync(input: {
  skillsRoot: string;
  bundled: readonly BundledSkill[];
  receipt: Receipt | null;
}): SkillPlan[] {
  const recorded = input.receipt?.skills ?? {};
  const shipped = new Set(input.bundled.map((skill) => skill.name));
  const retired = Object.keys(recorded).filter((name) => !shipped.has(name)).sort();
  return [
    ...input.bundled.map((skill) => planShipped(input.skillsRoot, skill, own(recorded, skill.name))),
    ...retired.map((name) => planRetired(input.skillsRoot, name, recorded[name])),
  ];
}

function planShipped(skillsRoot: string, skill: BundledSkill, entry: ReceiptSkill | undefined): SkillPlan {
  const name = skill.name;
  const directory = skillDirectory(skillsRoot, name);
  const home = inspectHomeSkill(directory);
  if (home.kind === "missing") return { action: "install", name, skill };
  if (home.kind !== "directory") return { action: "keep", name, reason: home.kind };

  const shippedPaths = Object.keys(skill.files).sort();
  const recordedPaths = entry ? Object.keys(entry.files).sort() : null;
  const likeShipped = sameList(home.paths, shippedPaths);
  const likeRecorded = recordedPaths !== null && sameList(home.paths, recordedPaths);
  // A different set of files is already an answer; hash only when content decides.
  const observed = likeShipped || likeRecorded ? readHashes(directory, home.paths) : null;
  if (observed === "unreadable") return { action: "keep", name, reason: "unreadable" };

  const current = observed !== null && likeShipped && home.paths.every((file) => isShipped(skill.files[file], observed[file]));
  const pristine = observed !== null && entry !== undefined && likeRecorded && home.paths.every((file) => observed[file] === entry.files[file]);
  if (current) return pristine ? { action: "current", name } : { action: "adopt", name, observed };
  if (pristine) return { action: "update", name, skill, observed };
  if (!entry) return { action: "keep", name, reason: "unmanaged" };
  return { action: "keep", name, reason: hasShippedChanged(skill, entry) ? "modified" : "customized" };
}

function planRetired(skillsRoot: string, name: string, entry: ReceiptSkill): SkillPlan {
  const directory = skillDirectory(skillsRoot, name);
  const home = inspectHomeSkill(directory);
  if (home.kind === "missing") return { action: "forget", name };
  if (home.kind !== "directory") return { action: "keep", name, reason: home.kind };
  if (!sameList(home.paths, Object.keys(entry.files).sort())) return { action: "keep", name, reason: "retired-modified" };
  const observed = readHashes(directory, home.paths);
  if (observed === "unreadable") return { action: "keep", name, reason: "unreadable" };
  return home.paths.every((file) => observed[file] === entry.files[file])
    ? { action: "retire", name, observed }
    : { action: "keep", name, reason: "retired-modified" };
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

function readHashes(directory: string, paths: readonly string[]): Hashes | "unreadable" {
  try { return hashFiles(directory, paths); }
  catch { return "unreadable"; }
}
