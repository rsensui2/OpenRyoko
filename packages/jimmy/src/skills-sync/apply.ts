import fs from "node:fs";
import path from "node:path";
import { shippedHashes, type BundledSkill } from "./bundled.js";
import { hashFiles, inspectHomeSkill } from "./home-skill.js";
import { sameList } from "./names.js";
import { skillDirectory, type SkillPlan } from "./plan.js";
import { STAGING_PREFIX } from "./staging.js";
import type { FailedSkill } from "./types.js";

/** Where replaced and retired skills go: <home>/.migration-backups/<version>-<time>/skills/<name>/ */
export const BACKUP_ROOT = ".migration-backups";

type Change = Extract<SkillPlan, { action: "install" | "update" | "retire" }>;
type BackupRun = ReturnType<typeof backupRun>;

export interface ApplyContext {
  /** Real path of the instance home. Staging and backups stay inside it, on its filesystem. */
  home: string;
  skillsRoot: string;
  packageVersion: string;
  now: Date;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A replacement failed and so did putting the previous copy back: the skill is now
 *  missing from skills/, moved there by the sync itself and not by the operator. */
class SkillLostError extends Error {}

export interface Applied {
  failed: FailedSkill[];
  /** Failed skills that ended up missing. Their previous copy is in the backup directory. */
  lost: string[];
  backupDir: string | null;
}

/**
 * Carry out the planned changes, one skill at a time. Each skill is built in full
 * before it is moved into place, and the copy it replaces is moved away, never
 * deleted. A skill that fails is left as it was and does not stop the others.
 */
export function applyPlans(plans: readonly SkillPlan[], context: ApplyContext): Applied {
  const changes = plans.filter((plan): plan is Change => plan.action === "install" || plan.action === "update" || plan.action === "retire");
  if (changes.length === 0) return { failed: [], lost: [], backupDir: null };

  const backup = backupRun(context);
  if (needsBackup(plans)) assertBackupRootUsable(context.home);
  const staging = changes.some((plan) => plan.action !== "retire")
    ? fs.mkdtempSync(path.join(context.home, STAGING_PREFIX))
    : null;
  try {
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
      backupDir: backup.finish(),
    };
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Does the plan move any existing skill away? */
export function needsBackup(plans: readonly SkillPlan[]): boolean {
  return plans.some((plan) => plan.action === "update" || plan.action === "retire");
}

/** A backup root that is already a link refuses the whole run, before any write. */
export function assertBackupRootUsable(home: string): void {
  const root = path.join(home, BACKUP_ROOT);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`${root} is not a plain directory, so nothing can be backed up into it`);
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

/**
 * Is this path, right now, the real directory it is supposed to be? `directory` is
 * built from the home's real path, so it resolves to itself only while no part of it
 * has been replaced by a link. Called immediately before a rename, never earlier.
 */
function assertPlainDirectory(directory: string): void {
  if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) {
    throw new Error(`${directory} is not a plain directory inside the instance home`);
  }
}

/** One backup directory per run, created only when a skill is about to be moved into it. */
function backupRun(context: ApplyContext) {
  const root = path.join(context.home, BACKUP_ROOT);
  let run: { directory: string; skills: string; createdRoot: boolean } | null = null;
  let held = 0;
  return {
    /** Move a skill out of skills/ and return where it went. */
    take(name: string, source: string): string {
      run ??= createRun(root, context);
      const target = path.join(run.skills, name);
      // skills/ last, as everywhere: it is the end the user's own directories hang off.
      assertPlainDirectory(run.skills);
      assertPlainDirectory(context.skillsRoot);
      fs.renameSync(source, target);
      held += 1;
      return target;
    },
    /** Undo `take` after a failed replacement. */
    giveBack(previous: string, destination: string): void {
      try {
        assertPlainDirectory(context.skillsRoot);
        fs.renameSync(previous, destination);
      } catch (error) {
        throw new SkillLostError(`its previous copy could not be put back and is at ${previous} (${messageOf(error)})`);
      }
      held -= 1;
    },
    /** Where the previous copies are, or null — with nothing left behind — when no skill ended up there. */
    finish(): string | null {
      if (!run) return null;
      if (held > 0) return run.directory;
      for (const empty of [run.skills, run.directory, ...(run.createdRoot ? [root] : [])]) {
        try { fs.rmdirSync(empty); } catch { break; }
      }
      return null;
    },
  };
}

/** Create <root>/<version>-<time>/skills. Nothing is created through a link: the root
 *  is made without following one, and must be a real directory once it exists. */
function createRun(root: string, context: ApplyContext): { directory: string; skills: string; createdRoot: boolean } {
  let createdRoot = true;
  try { fs.mkdirSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    createdRoot = false;
  }
  if (!fs.lstatSync(root).isDirectory()) throw new Error(`${root} is not a plain directory, so nothing can be backed up into it`);
  const version = context.packageVersion.replace(/[^A-Za-z0-9._+-]/g, "_") || "unknown";
  const base = `${version}-${context.now.toISOString().replace(/[:.]/g, "-")}`;
  for (let attempt = 1; ; attempt++) {
    const directory = path.join(root, attempt === 1 ? base : `${base}-${attempt}`);
    try {
      fs.mkdirSync(directory);
      const skills = path.join(directory, "skills");
      fs.mkdirSync(skills);
      return { directory, skills, createdRoot };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw error;
    }
  }
}
