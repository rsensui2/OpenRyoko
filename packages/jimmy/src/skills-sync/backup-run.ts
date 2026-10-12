import fs from "node:fs";
import path from "node:path";

/**
 * Where whatever the sync takes out of the way goes:
 * <home>/.migration-backups/<version>-<time>/skills/<name>/ for a replaced or retired
 * skill, and .../staging/<name>/ for a staging directory left in the home.
 */
export const BACKUP_ROOT = ".migration-backups";

export interface RunContext {
  /** Real path of the instance home. Staging and backups stay inside it, on its filesystem. */
  home: string;
  skillsRoot: string;
  packageVersion: string;
  now: Date;
}

export type BackupRun = ReturnType<typeof backupRun>;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A replacement failed and so did putting the previous copy back: the skill is now
 *  missing from skills/, moved there by the sync itself and not by the operator. */
export class SkillLostError extends Error {}

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
 * Is this path, right now, the real directory it is supposed to be? `directory` is
 * built from the home's real path, so it resolves to itself only while no part of it
 * has been replaced by a link. Called immediately before a rename, never earlier.
 */
export function assertPlainDirectory(directory: string): void {
  if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) {
    throw new Error(`${directory} is not a plain directory inside the instance home`);
  }
}

/**
 * One backup directory per run, created only when something is about to be moved into
 * it. Everything the sync takes out of the way is moved here with one rename: nothing
 * is deleted, and nothing inside what is moved is read or followed.
 */
export function backupRun(context: RunContext) {
  const root = path.join(context.home, BACKUP_ROOT);
  let run: { directory: string; createdRoot: boolean; rooms: Map<string, string> } | null = null;
  let held = 0;
  /** <run>/skills or <run>/staging, made the first time something goes there. */
  const room = (kind: "skills" | "staging"): string => {
    run ??= { ...createRun(root, context), rooms: new Map() };
    const made = run.rooms.get(kind);
    if (made !== undefined) return made;
    const directory = path.join(run.directory, kind);
    fs.mkdirSync(directory);
    run.rooms.set(kind, directory);
    return directory;
  };
  return {
    /** Move a skill out of skills/ and return where it went. */
    take(name: string, source: string): string {
      const skills = room("skills");
      const target = path.join(skills, name);
      // skills/ last, as everywhere: it is the end the user's own directories hang off.
      assertPlainDirectory(skills);
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
    /**
     * Move a staging directory out of the top of the home, whole, and return where it
     * went. It has to be a real directory sitting directly in the home, and it goes to
     * a real directory inside this run's: the same two checks as for a skill, with the
     * end through which something could leave the home checked last.
     */
    setAside(source: string): string {
      const staging = room("staging");
      const target = path.join(staging, path.basename(source));
      assertPlainDirectory(source);
      assertPlainDirectory(staging);
      fs.renameSync(source, target);
      held += 1;
      return target;
    },
    /** Where what was moved is, or null — with nothing left behind — when nothing ended up there. */
    finish(): string | null {
      if (!run) return null;
      // rmdir removes a directory only if it is empty, and never follows a link.
      for (const directory of run.rooms.values()) {
        try { fs.rmdirSync(directory); } catch { /* it holds something */ }
      }
      if (held > 0) return run.directory;
      for (const empty of [run.directory, ...(run.createdRoot ? [root] : [])]) {
        try { fs.rmdirSync(empty); } catch { break; }
      }
      return null;
    },
  };
}

/** Create <root>/<version>-<time>. Nothing is created through a link: the root is made
 *  without following one, and must be a real directory once it exists. */
function createRun(root: string, context: RunContext): { directory: string; createdRoot: boolean } {
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
      return { directory, createdRoot };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 100) throw error;
    }
  }
}
