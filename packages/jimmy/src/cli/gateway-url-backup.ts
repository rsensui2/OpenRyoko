import fs from "node:fs";
import path from "node:path";

const BACKUP_ROOT = "backups";
/** Two runs in one millisecond, or a name someone took first: try a few more. */
const MAX_RUN_NAMES = 20;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export interface BackupRun {
  /** <home>/backups/gateway-url-<time>, as the caller named the home. */
  readonly directory: string;
  /** Copy a file of the home to the same relative path under the run directory. */
  keep(file: string, relative: string, mode: number): void;
}

const isTaken = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "EEXIST";

/**
 * Create this run's backup directory, <home>/backups/gateway-url-<stamp>.
 *
 * The copies made here are of files in the home, and the home is where anything can
 * be planted. So nothing is created over, or through, what is already there:
 *
 * - backups/ has to be a real directory. A link there would send every copy to
 *   wherever it points, so this throws instead, and the caller fixes nothing.
 * - The run directory is created exclusively. One already there under the same name,
 *   link or directory, is somebody else's, and another name is taken.
 * - Each file is copied exclusively, into a directory confirmed, immediately before,
 *   to be inside the run directory and not a link to somewhere else.
 */
export function createBackupRun(home: string, stamp: string): BackupRun {
  const root = path.join(fs.realpathSync(home), BACKUP_ROOT);
  const shown = path.join(home, BACKUP_ROOT);
  try { fs.mkdirSync(root, { mode: 0o700 }); }
  catch (error) { if (!isTaken(error)) throw error; }
  if (!fs.lstatSync(root).isDirectory()) throw new Error(`${shown} is not a plain directory, so no backup can be made in it`);

  const name = createRunDirectory(root, `gateway-url-${stamp}`);
  const directory = path.join(root, name);
  if (!resolvesToItself(directory)) {
    // backups/ became a link while the directory was being made: it is not in the home.
    try { fs.rmdirSync(directory); } catch { /* not ours to insist on */ }
    throw new Error(`${shown} stopped being a plain directory while a backup was being made in it`);
  }
  return {
    directory: path.join(shown, name),
    keep(file, relative, mode) {
      const target = path.join(directory, relative);
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (!resolvesToItself(parent)) throw new Error(`${parent} is not a plain directory inside the backup, so nothing was copied there`);
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
      setMode(target, mode);
    },
  };
}

/** `directory` is built from the home's real path, so it resolves to itself only while
 *  no part of it has been replaced by a link. */
function resolvesToItself(directory: string): boolean {
  return fs.realpathSync(directory) === directory;
}

function createRunDirectory(root: string, base: string): string {
  for (let attempt = 1; attempt <= MAX_RUN_NAMES; attempt++) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      fs.mkdirSync(path.join(root, name), { mode: 0o700 });
      return name;
    } catch (error) {
      if (!isTaken(error)) throw error;
    }
  }
  throw new Error(`every name tried for a backup directory under ${root} is already taken`);
}

/** On the open file, never by path: a chmod by path follows a link put there since. */
function setMode(file: string, mode: number): void {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not the regular file the backup wrote`);
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}
