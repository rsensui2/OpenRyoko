import fs from "node:fs";
import path from "node:path";
import { compareSemver } from "../shared/version.js";
import { applyPlans } from "./apply.js";
import { loadBundledSkills, type BundledSkill } from "./bundled.js";
import { own } from "./names.js";
import { planSkillSync, type SkillPlan } from "./plan.js";
import { markDeleted, RECEIPT_FILE, readReceipt, receiptSkill, serializeReceipt, writeReceipt, type Receipt, type ReceiptSkill } from "./receipt.js";
import type { BundledSkillSync, KeepReason, KeptSkill } from "./types.js";

export interface SyncBundledSkillsOptions {
  /** The package's template directory; skills ship in its skills/ subdirectory. */
  templateDir: string;
  /** The instance home. Only <home>/skills and <home>/.migration-backups are written. */
  home: string;
  /** Placeholder values, as `ryoko setup` fills them into .md and .yaml files. */
  replacements: Record<string, string>;
  packageVersion: string;
  /**
   * Put back shipped skills the operator deleted. Off by default: a skill the sync
   * placed and later finds gone was removed on purpose, and starting the gateway
   * must not undo that. An explicit `ryoko migrate` turns it on.
   */
  restoreDeleted?: boolean;
  now?: Date;
}

/** Kept skills worth telling the user about, once per package version: a shipped
 *  update they are not getting, or a shipped skill they removed and can have back. */
const ANNOUNCED: ReadonlySet<KeepReason> = new Set<KeepReason>(["modified", "unmanaged", "deleted"]);

const nothing = (): BundledSkillSync => ({
  added: [], updated: [], adopted: [], retired: [], kept: [], notices: [], inSync: [], failed: [], backupDir: null,
});

/**
 * Bring the skills the package ships into <home>/skills without touching anything
 * the user owns. A skill is replaced or retired only when a receipt proves the copy
 * in the home is byte-for-byte the one this sync placed; edited skills, symlinks,
 * and skills it has no record of stay exactly as they are. A skill it placed that is
 * gone stays gone, unless `restoreDeleted` asks for it back.
 *
 * The whole run is planned and validated before the first write. It never reads or
 * writes config.yaml (so `jinn.version` is untouched) or skills.json.
 */
export function syncBundledSkills(options: SyncBundledSkillsOptions): BundledSkillSync {
  const home = fs.realpathSync(options.home);
  const skillsRoot = path.join(home, "skills");
  // A symlinked skills/ is the user's own skill store: nothing is synced into it.
  if (skillsRootKind(skillsRoot) === "symlink") return { ...nothing(), skipped: "skills-root-symlink" };

  const bundled = loadBundledSkills(options.templateDir, options.replacements);
  // A package without skills is a broken install, not a release that retired them all.
  if (bundled.length === 0) return nothing();

  const receiptPath = path.join(skillsRoot, RECEIPT_FILE);
  const receipt = readReceipt(receiptPath);
  // An older CLI sharing this home must not undo what a newer one synced.
  if (receipt && compareSemver(options.packageVersion, receipt.packageVersion) < 0) return { ...nothing(), skipped: "newer-receipt" };

  const plans = planSkillSync({ skillsRoot, bundled, receipt, restoreDeleted: options.restoreDeleted === true });
  const applied = applyPlans(plans, { home, skillsRoot, packageVersion: options.packageVersion, now: options.now ?? new Date() });
  const failed = new Set(applied.failed.map((failure) => failure.name));
  const done = plans.filter((plan) => !failed.has(plan.name));

  const kept = done
    .flatMap((plan): KeptSkill[] => (plan.action === "keep" ? [{ name: plan.name, reason: plan.reason }] : []))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const announced = kept.filter((skill) => ANNOUNCED.has(skill.reason));
  const next: Receipt = {
    packageVersion: options.packageVersion,
    skills: recordedSkills(receipt, done, options.packageVersion, applied.lost),
    notices: Object.fromEntries(announced.map((skill) => [skill.name, options.packageVersion])),
  };
  saveReceipt(receiptPath, skillsRoot, receipt, next);

  const names = (...actions: SkillPlan["action"][]) => done.filter((plan) => actions.includes(plan.action)).map((plan) => plan.name).sort();
  return {
    added: names("install"),
    updated: names("update"),
    adopted: names("adopt"),
    retired: names("retire"),
    kept,
    notices: announced.filter((skill) => own(receipt?.notices, skill.name) !== options.packageVersion),
    inSync: names("install", "update", "adopt", "current"),
    failed: applied.failed,
    backupDir: applied.backupDir,
  };
}

function skillsRootKind(skillsRoot: string): "missing" | "directory" | "symlink" {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(skillsRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (stat.isSymbolicLink()) return "symlink";
  if (!stat.isDirectory()) throw new Error(`${skillsRoot} is not a directory, so shipped skills cannot be synced into it`);
  return "directory";
}

/**
 * The receipt after this run: what was placed or adopted is recorded, what was
 * retired is dropped, and everything else keeps the entry it had — with a tombstone
 * exactly when the skill was found deleted. A skill the sync itself lost in a failed
 * update is dropped as well, so the next run reinstalls it rather than taking its
 * absence for the operator's doing.
 */
function recordedSkills(previous: Receipt | null, done: readonly SkillPlan[], version: string, lost: readonly string[]): Record<string, ReceiptSkill> {
  const dropped = new Set([...lost, ...done.filter((plan) => plan.action === "retire" || plan.action === "forget").map((plan) => plan.name)]);
  const placed = done.flatMap((plan): [string, ReceiptSkill][] => {
    if (plan.action === "install" || plan.action === "update") return [[plan.name, receiptSkill(shippedHashes(plan.skill), version)]];
    if (plan.action === "adopt") return [[plan.name, receiptSkill(plan.observed, version)]];
    return [];
  });
  // Every plan that completed looked at the skill's path: "deleted" found nothing there.
  const foundDeleted = new Map(done.map((plan) => [plan.name, plan.action === "keep" && plan.reason === "deleted"]));
  const carried = Object.entries(previous?.skills ?? {})
    .filter(([name]) => !dropped.has(name))
    .map(([name, skill]): [string, ReceiptSkill] => [name, foundDeleted.has(name) ? markDeleted(skill, foundDeleted.get(name) === true) : skill]);
  return Object.fromEntries([...carried, ...placed]);
}

function shippedHashes(skill: BundledSkill): Record<string, string> {
  return Object.fromEntries(Object.entries(skill.files).map(([relative, file]) => [relative, file.sha256]));
}

/** Written only when it says something new, so a run with nothing to do writes nothing. */
function saveReceipt(file: string, skillsRoot: string, previous: Receipt | null, next: Receipt): void {
  if (skillsRootKind(skillsRoot) !== "directory") return;
  const text = serializeReceipt(next);
  if (previous && serializeReceipt(previous) === text) return;
  writeReceipt(file, text);
}
