import fs from "node:fs";
import path from "node:path";
import { buildTemplateReplacements } from "../shared/templateReplacements.js";
import { compareSemver } from "../shared/version.js";
import { applyPlans, assertBackupRootUsable, needsBackup, type Applied, type ApplyContext } from "./apply.js";
import { loadBundledSkills, shippedHashes } from "./bundled.js";
import { loadShippedHistory } from "./history.js";
import { own } from "./names.js";
import { planSkillSync, type SkillPlan } from "./plan.js";
import { markDeleted, markReplacing, NewerReceiptFormat, RECEIPT_FILE, readReceipt, receiptSkill, serializeReceipt, writeReceipt, type Receipt, type ReceiptSkill } from "./receipt.js";
import { removeAbandonedStaging } from "./staging.js";
import type { BundledSkillSync, KeepReason, KeptSkill } from "./types.js";

export interface SyncBundledSkillsOptions {
  /** The package's template directory; skills ship in its skills/ subdirectory. */
  templateDir: string;
  /** The instance home. Only <home>/skills and <home>/.migration-backups are written. */
  home: string;
  /** Placeholder values, as `ryoko setup` fills them into .md and .yaml files. */
  replacements: Record<string, string>;
  /**
   * Portal names `ryoko setup` may have used before the current one: its defaults.
   * A skill installed under one of them, in a home that predates the receipt, is still
   * recognised as an untouched copy. Deliberately a short list of names the installer
   * itself would have chosen, never "whatever name the file happens to contain".
   */
  legacyPortalNames?: readonly string[];
  packageVersion: string;
  /**
   * Put back shipped skills the operator deleted: `true` for all of them, or the
   * names of the ones wanted. Off by default: a skill the sync placed and later finds
   * gone was removed on purpose, and neither starting the gateway nor updating may
   * undo that. Only `ryoko migrate --restore-deleted-skills` turns it on.
   */
  restoreDeleted?: boolean | readonly string[];
  now?: Date;
}

/** Kept skills worth telling the user about, once per package version: a shipped
 *  update they are not getting, a shipped skill they removed and can have back, or a
 *  skill the sync could not so much as look at. */
const ANNOUNCED: ReadonlySet<KeepReason> = new Set<KeepReason>(["modified", "unmanaged", "deleted", "unreadable", "too-large"]);

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
  const read = readReceiptOrStandBack(receiptPath, options.packageVersion);
  if ("standBack" in read) return read.standBack;
  const receipt = read.receipt;

  const history = loadShippedHistory(options.templateDir);
  const run: Run = { home, skillsRoot, receiptPath, packageVersion: options.packageVersion, now: options.now ?? new Date() };
  // What an earlier run left behind when it died, before this one stages anything.
  const clearedStaging = removeAbandonedStaging(home, new Set([...bundled.map((skill) => skill.name), ...history.names]), run.now);
  const plans = planSkillSync({
    skillsRoot,
    bundled,
    receipt,
    restoreDeleted: options.restoreDeleted ?? false,
    history,
    // As configured now, as packaged (never filled in), or under an installer default.
    renderings: [options.replacements, {}, ...(options.legacyPortalNames ?? []).map(buildTemplateReplacements)],
  });
  const result = summarise(plans, receipt, carryOut(plans, receipt, run), run);
  return clearedStaging.length > 0 ? { ...result, clearedStaging } : result;
}

interface Run extends ApplyContext {
  receiptPath: string;
}

interface Outcome extends Applied {
  /** The receipt as it stands on disk once the changes are made. */
  onDisk: Receipt | null;
}

/**
 * Apply the plan. A skill about to be replaced is first marked in the receipt, on
 * disk, as being replaced: between moving its old copy out and its new one in there
 * is no skill, and a process that dies there must not leave something that reads as
 * the operator's deletion. A replacement that cannot be announced is not started.
 */
function carryOut(plans: readonly SkillPlan[], receipt: Receipt | null, run: Run): Outcome {
  // Checked before the receipt is touched: a run that will be refused writes nothing.
  if (needsBackup(plans)) assertBackupRootUsable(run.home);
  const replacing = plans.filter((plan) => plan.action === "update" && own(receipt?.skills, plan.name) !== undefined).map((plan) => plan.name);
  if (!receipt || replacing.length === 0) return { ...applyPlans(plans, run), onDisk: receipt };

  const announced: Receipt = {
    ...receipt,
    skills: { ...receipt.skills, ...Object.fromEntries(replacing.map((name) => [name, markReplacing(receipt.skills[name], true)])) },
  };
  const error = saveReceipt(run.receiptPath, run.skillsRoot, receipt, announced);
  if (error === null) return { ...applyPlans(plans, run), onDisk: announced };

  const unannounced = replacing.map((name) => ({ name, error: `the receipt could not be updated before replacing it, so it was left alone (${error})` }));
  const applied = applyPlans(plans.filter((plan) => !replacing.includes(plan.name)), run);
  const failed = [...applied.failed, ...unannounced].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { ...applied, failed, onDisk: receipt };
}

/** Bring the receipt up to date with what was done, and report it. */
function summarise(plans: readonly SkillPlan[], receipt: Receipt | null, outcome: Outcome, run: Run): BundledSkillSync {
  const failed = new Set(outcome.failed.map((failure) => failure.name));
  const done = plans.filter((plan) => !failed.has(plan.name));
  const kept = done
    .flatMap((plan): KeptSkill[] => (plan.action === "keep" ? [{ name: plan.name, reason: plan.reason }] : []))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const announced = kept.filter((skill) => ANNOUNCED.has(skill.reason));
  const next: Receipt = {
    packageVersion: run.packageVersion,
    skills: recordedSkills(receipt, done, run.packageVersion, outcome.lost),
    notices: Object.fromEntries(announced.map((skill) => [skill.name, run.packageVersion])),
  };
  // The skills are already in their new state. A receipt that cannot be saved must
  // not turn that into an exception: the caller would lose what was done, and what
  // was found deleted. The next run sees the same skills and records them then.
  const receiptError = saveReceipt(run.receiptPath, run.skillsRoot, outcome.onDisk, next);

  const names = (...actions: SkillPlan["action"][]) => done.filter((plan) => actions.includes(plan.action)).map((plan) => plan.name).sort();
  return {
    added: names("install"),
    updated: names("update"),
    adopted: names("adopt"),
    retired: names("retire"),
    kept,
    notices: announced.filter((skill) => own(receipt?.notices, skill.name) !== run.packageVersion),
    inSync: names("install", "update", "adopt", "current"),
    failed: outcome.failed,
    backupDir: outcome.backupDir,
    ...(receiptError === null ? {} : { receiptError }),
  };
}

/**
 * The receipt, or the reason to leave this home alone: a newer OpenRyoko synced it
 * last, or wrote the receipt in a format this one cannot read. An older CLI sharing a
 * home must not undo what a newer one did, so it changes nothing, and writes nothing:
 * not even a note that it stood back. A receipt is also something a person can forge,
 * and whether the caller has said so before is not to be kept beside it.
 */
function readReceiptOrStandBack(file: string, ours: string): { receipt: Receipt | null } | { standBack: BundledSkillSync } {
  const standBack = (reason: "newer-receipt" | "newer-format") => ({ standBack: { ...nothing(), skipped: reason } });
  let receipt: Receipt | null;
  try { receipt = readReceipt(file); }
  catch (error) {
    if (error instanceof NewerReceiptFormat) return standBack("newer-format");
    throw error;
  }
  if (receipt && compareSemver(ours, receipt.packageVersion) < 0) return standBack("newer-receipt");
  return { receipt };
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
 * exactly when the skill was found deleted, and never with the mark of a replacement
 * in progress: every replacement is over by now, one way or the other. A skill the
 * sync itself lost in a failed update is dropped, so the next run reinstalls it
 * rather than taking its absence for the operator's doing.
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
    .map(([name, skill]): [string, ReceiptSkill] => [
      name,
      markReplacing(foundDeleted.has(name) ? markDeleted(skill, foundDeleted.get(name) === true) : skill, false),
    ]);
  return Object.fromEntries([...carried, ...placed]);
}

/** Written only when it says something new, so a run with nothing to do writes
 *  nothing. Returns why it could not be saved, or null. */
function saveReceipt(file: string, skillsRoot: string, previous: Receipt | null, next: Receipt): string | null {
  try {
    if (skillsRootKind(skillsRoot) !== "directory") return null;
    const text = serializeReceipt(next);
    if (previous && serializeReceipt(previous) === text) return null;
    writeReceipt(file, text);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
