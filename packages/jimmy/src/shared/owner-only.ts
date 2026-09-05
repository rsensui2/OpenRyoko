import fs from "node:fs";

/** Create an instance directory and keep it private on POSIX. On Windows the
 * ACL is inherited from the user's profile, so chmod semantics do not apply. */
export function ensureOwnerOnlyDirectory(dir: string): { changed: boolean; warning?: string } {
  const existed = fs.existsSync(dir);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      const stat = fs.statSync(dir);
      const actual = stat.mode & 0o777;
      if (actual !== 0o700) fs.chmodSync(dir, 0o700);
    }
    return { changed: !existed };
  } catch (err) {
    return { changed: false, warning: err instanceof Error ? err.message : String(err) };
  }
}
