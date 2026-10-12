import fs from "node:fs";
import path from "node:path";
import { assertBackupRootUsable, assertPlainDirectory, SkillLostError, type BackupRun, type RunContext } from "./backup-run.js";
import { shippedHashes, type BundledSkill } from "./bundled.js";
import { hashFiles, inspectHomeSkill } from "./home-skill.js";
import { sameList } from "./names.js";
import { skillDirectory, type SkillPlan } from "./plan.js";
import { STAGING_PREFIX } from "./staging.js";
import type { FailedSkill } from "./types.js";

type Change = Extract<SkillPlan, { action: "install" | "update" | "retire" }>;

export type ApplyContext = RunContext;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export interface Applied {
  failed: FailedSkill[];
  /** Failed skills that ended up missing. Their previous copy is in the backup directory. */
  lost: string[];
  /** The name of this run's staging directory, when it still held the copy of a skill
   *  that failed and was moved to the backup directory with it. */
  stagingSetAside: string | null;
}

/**
 * Carry out the planned changes, one skill at a time. Each skill is built in full
 * before it is moved into place, and the copy it replaces is moved away, never
 * deleted. A skill that fails is left as it was and does not stop the others.
 */
export function applyPlans(plans: readonly SkillPlan[], context: ApplyContext, backup: BackupRun): Applied {
  const changes = plans.filter((plan): plan is Change => plan.action === "install" || plan.action === "update" || plan.action === "retire");
  if (changes.length === 0) return { failed: [], lost: [], stagingSetAside: null };

  if (needsBackup(plans)) assertBackupRootUsable(context.home);
  const staging = changes.some((plan) => plan.action !== "retire")
    ? fs.mkdtempSync(path.join(context.home, STAGING_PREFIX))
    : null;
  const failures = changes.flatMap((plan) => {
    try {
      applyChange(plan, context, staging, backup);
      return [];
    } catch (error) {
      return [{ name: plan.name, error: messageOf(error), lost: error instanceof SkillLostError }];
    }
  });
  return {
    failed: failures.map(({ name, error }) => ({ name, error })),
    lost: failures.filter((failure) => failure.lost).map((failure) => failure.name),
    stagingSetAside: staging === null ? null : putAwayStaging(staging, backup),
  };
}

/**
 * Once every skill built in the staging directory has been moved into place it is
 * empty, and is removed as an empty directory. If the copy of a skill that failed is
 * still in it, nothing is deleted: a delete that walks a tree in the home can be led,
 * by a link swapped in as it goes, to empty a directory somewhere else. The directory
 * is moved to the backup directory instead, in one rename that reads nothing inside
 * it. Returns its name when it was moved.
 */
function putAwayStaging(staging: string, backup: BackupRun): string | null {
  try {
    fs.rmdirSync(staging);
    return null;
  } catch {
    // Not empty — or no longer the directory this run made.
  }
  try {
    backup.setAside(staging);
    return path.basename(staging);
  } catch {
    // It stays where it is. A later run moves it once it counts as abandoned.
    return null;
  }
}

/** Does the plan move any existing skill away? */
export function needsBackup(plans: readonly SkillPlan[]): boolean {
  return plans.some((plan) => plan.action === "update" || plan.action === "retire");
}

/**
 * Every move below follows the same order: do the slow work and create whatever
 * directories are needed, then check where both ends of the move really are, then
 * rename — with nothing between the check and the rename. The home is the user's, and
 * a path that was a directory a moment ago can be swapped for a link at any time; a
 * check made before the slow work would vouch for a path that has since changed.
 */
function applyChange(plan: Change, context: ApplyContext, staging: string | null, backup: BackupRun): void {
  const destination = skillDirectory(context.skillsRoot, plan.name);
  if (plan.action === "retire") {
    assertUnchanged(destination, plan.observed);
    backup.take(plan.name, destination);
    return;
  }
  if (!staging) throw new Error("no staging directory");
  // A copy that is staged and then cannot be moved in is kept, not deleted. So none is
  // staged for a move the file permissions already rule out: that would be one more
  // kept copy at every start.
  assertWritable(context.skillsRoot, "skills/");
  if (plan.action === "update") assertWritable(destination, "its directory");
  const staged = stageSkill(staging, plan.skill);
  // Both ends of the move in. skills/ is checked last: the user's own directories
  // are reachable through it, and nothing comes between that check and the rename.
  const moveIn = (): void => {
    assertStagedIntact(staged, plan.skill);
    assertPlainDirectory(context.skillsRoot);
    fs.renameSync(staged, destination);
  };
  if (plan.action === "install") {
    fs.mkdirSync(context.skillsRoot, { recursive: true });
    if (inspectHomeSkill(destination).kind !== "missing") throw new Error("something appeared at its path while the sync was running; it was left alone");
    moveIn();
    return;
  }
  // The previous copy is not moved away for a staged one that is already wrong.
  assertStagedIntact(staged, plan.skill);
  assertUnchanged(destination, plan.observed);
  const previous = backup.take(plan.name, destination);
  try {
    moveIn();
  } catch (error) {
    backup.giveBack(previous, destination);
    throw error;
  }
}

/** Moving a directory needs write permission on the directory it leaves or enters,
 *  and on the directory itself when it changes parent. Not there yet is fine. */
function assertWritable(directory: string, what: string): void {
  try { fs.accessSync(directory, fs.constants.W_OK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`${what} is not writable, so nothing was staged for it (${messageOf(error)})`);
  }
}

/**
 * Write the rendered skill from memory: what lands is exactly what was hashed.
 *
 * The staging directory is in the home, where anything can be planted while this
 * runs. So nothing is created over, or through, what is already there: directories
 * one level at a time (parents come before their children in `directories`), since
 * `recursive` walks straight through a link left where a directory belongs, and files
 * with "wx", which refuses a link or a file at the path instead of writing through it.
 *
 * The packaged mode is given at creation, which keeps a script executable. There is
 * no chmod afterwards: it fails on mounts without POSIX permissions (CIFS).
 */
function stageSkill(staging: string, skill: BundledSkill): string {
  const staged = path.join(staging, skill.name);
  fs.mkdirSync(staged);
  for (const directory of skill.directories) fs.mkdirSync(path.join(staged, ...directory.split("/")));
  for (const [relative, file] of Object.entries(skill.files)) {
    fs.writeFileSync(path.join(staged, ...relative.split("/")), file.bytes, { mode: file.mode, flag: "wx" });
  }
  return staged;
}

/**
 * Is the staged copy still exactly what the sync wrote, where it wrote it? With the
 * staging directory (or the copy itself) replaced by a link, the move would take a
 * directory from wherever the link leads. With a file rewritten, something the
 * package never shipped would land in skills/ and be recorded as the shipped version.
 */
function assertStagedIntact(staged: string, skill: BundledSkill): void {
  try {
    // Resolves to itself only while neither it nor the staging directory is a link.
    assertPlainDirectory(staged);
    assertUnchanged(staged, shippedHashes(skill));
  } catch (error) {
    throw new Error(`its staged copy was no longer what the sync wrote when it came to be moved into place, so it was not moved (${messageOf(error)})`);
  }
}

/** The plan was made from a snapshot. A skill edited since then is the user's again. */
function assertUnchanged(directory: string, observed: Record<string, string>): void {
  const home = inspectHomeSkill(directory);
  const paths = Object.keys(observed).sort();
  const unchanged = home.kind === "directory" && sameList(home.paths, paths) && sameContent(directory, paths, observed);
  if (!unchanged) throw new Error("it changed while the sync was running; it was left alone");
}

function sameContent(directory: string, paths: readonly string[], observed: Record<string, string>): boolean {
  const current = hashFiles(directory, paths);
  return paths.every((file) => current[file] === observed[file]);
}
