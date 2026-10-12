import fs from "node:fs";
import path from "node:path";
import type { BundledSkill } from "./bundled.js";
import { hashFiles, inspectHomeSkill } from "./home-skill.js";
import { sameList } from "./names.js";
import { skillDirectory, type SkillPlan } from "./plan.js";
import type { FailedSkill } from "./types.js";

/** Where replaced and retired skills go: <home>/.migration-backups/<version>-<time>/skills/<name>/ */
export const BACKUP_ROOT = ".migration-backups";
/** Staged outside skills/, so a running gateway never discovers a half-written skill. */
const STAGING_PREFIX = ".bundled-skill-";

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

/**
 * Carry out the planned changes, one skill at a time. Each skill is built in full
 * before it is moved into place, and the copy it replaces is moved away, never
 * deleted. A skill that fails is left as it was and does not stop the others.
 */
export function applyPlans(plans: readonly SkillPlan[], context: ApplyContext): { failed: FailedSkill[]; backupDir: string | null } {
  const changes = plans.filter((plan): plan is Change => plan.action === "install" || plan.action === "update" || plan.action === "retire");
  if (changes.length === 0) return { failed: [], backupDir: null };

  const backup = backupRun(context);
  if (changes.some((plan) => plan.action !== "install")) backup.assertUsable();
  const staging = changes.some((plan) => plan.action !== "retire")
    ? fs.mkdtempSync(path.join(context.home, STAGING_PREFIX))
    : null;
  try {
    const failed = changes.flatMap((plan): FailedSkill[] => {
      try {
        applyChange(plan, context, staging, backup);
        return [];
      } catch (error) {
        return [{ name: plan.name, error: messageOf(error) }];
      }
    });
    return { failed, backupDir: backup.directory() };
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}

function applyChange(plan: Change, context: ApplyContext, staging: string | null, backup: BackupRun): void {
  const destination = skillDirectory(context.skillsRoot, plan.name);
  if (plan.action === "retire") {
    assertUnchanged(destination, plan.observed);
    assertSkillsRoot(context.skillsRoot);
    backup.take(plan.name, destination);
    return;
  }
  if (!staging) throw new Error("no staging directory");
  const staged = stageSkill(staging, plan.skill);
  if (plan.action === "install") {
    fs.mkdirSync(context.skillsRoot, { recursive: true });
    assertSkillsRoot(context.skillsRoot);
    if (inspectHomeSkill(destination).kind !== "missing") throw new Error("something appeared at its path while the sync was running; it was left alone");
    fs.renameSync(staged, destination);
    return;
  }
  assertUnchanged(destination, plan.observed);
  assertSkillsRoot(context.skillsRoot);
  const previous = backup.take(plan.name, destination);
  try {
    fs.renameSync(staged, destination);
  } catch (error) {
    backup.giveBack(previous, destination);
    throw error;
  }
}

/** Write the rendered skill from memory: what lands is exactly what was hashed.
 *  The packaged mode is given at creation, which keeps a script executable. There is
 *  no chmod afterwards: it fails on mounts without POSIX permissions (CIFS). */
function stageSkill(staging: string, skill: BundledSkill): string {
  const staged = path.join(staging, skill.name);
  fs.mkdirSync(staged);
  for (const directory of skill.directories) fs.mkdirSync(path.join(staged, ...directory.split("/")), { recursive: true });
  for (const [relative, file] of Object.entries(skill.files)) {
    fs.writeFileSync(path.join(staged, ...relative.split("/")), file.bytes, { mode: file.mode });
  }
  return staged;
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

/** Checked again right before every move: skills/ must still be a real directory in
 *  the home, not something swapped for a link since the plan was made. */
function assertSkillsRoot(skillsRoot: string): void {
  if (!fs.lstatSync(skillsRoot).isDirectory() || fs.realpathSync(skillsRoot) !== skillsRoot) {
    throw new Error(`${skillsRoot} is not a plain directory inside the instance home`);
  }
}

/** One backup directory per run, created only when something is actually moved into it. */
function backupRun(context: ApplyContext) {
  const root = path.join(context.home, BACKUP_ROOT);
  let directory: string | null = null;
  return {
    directory: () => directory,
    /** A backup root that is a link would move skills out of the home. Refuse first. */
    assertUsable(): void {
      let stat: fs.Stats;
      try { stat = fs.lstatSync(root); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (!stat.isDirectory()) throw new Error(`${root} is not a plain directory, so nothing can be backed up into it`);
    },
    /** Move a skill out of skills/ and return where it went. */
    take(name: string, source: string): string {
      directory ??= createRunDirectory(root, context);
      const target = path.join(directory, "skills", name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
      return target;
    },
    /** Undo `take` after a failed replacement, leaving no empty run directory behind. */
    giveBack(previous: string, destination: string): void {
      try {
        fs.renameSync(previous, destination);
      } catch (error) {
        throw new Error(`its previous copy could not be put back and is at ${previous} (${messageOf(error)})`);
      }
      if (directory && removeIfEmpty(path.dirname(previous)) && removeIfEmpty(directory)) directory = null;
    },
  };
}

function createRunDirectory(root: string, context: ApplyContext): string {
  fs.mkdirSync(root, { recursive: true });
  const version = context.packageVersion.replace(/[^A-Za-z0-9._+-]/g, "_") || "unknown";
  const base = `${version}-${context.now.toISOString().replace(/[:.]/g, "-")}`;
  for (let attempt = 1; ; attempt++) {
    const candidate = path.join(root, attempt === 1 ? base : `${base}-${attempt}`);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw error;
    }
  }
}

function removeIfEmpty(directory: string): boolean {
  try {
    fs.rmdirSync(directory);
    return true;
  } catch {
    return false;
  }
}
