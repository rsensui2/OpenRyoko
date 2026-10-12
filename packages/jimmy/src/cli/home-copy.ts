import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Copy a tree that ships in the package to <base>/<segments...> in the instance home,
 * replacing the files already there, without writing through anything planted in the
 * home. A copy that follows links writes the package's text over whatever a link left
 * at `MIGRATION.md` points to, anywhere the user can write.
 *
 * `base` is a directory the caller vouches for — the home, or the skills directory —
 * and is resolved once: a link to it, or above it, is the user's arrangement. Below
 * it nothing is followed:
 *
 * - Every directory is made one level at a time, and has to be a real directory where
 *   it is supposed to be. A link or a file in its place refuses the copy (it throws).
 * - Every file is written beside its destination under a random name, created
 *   exclusively, and then renamed onto it. A rename replaces a link; it never writes
 *   through one. The directory is confirmed once more immediately before the rename.
 *
 * `.gitkeep` files stand for their directory and are not copied themselves.
 */
export function placeTree(source: string, base: string, ...segments: string[]): void {
  let directory = fs.realpathSync(base);
  for (const segment of segments) {
    directory = path.join(directory, segment);
    ensurePlainDirectory(directory);
  }
  copyInto(source, directory);
}

function copyInto(source: string, directory: string): void {
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      ensurePlainDirectory(to);
      copyInto(from, to);
    } else if (entry.name !== ".gitkeep") {
      placeFile(from, to);
    }
  }
}

/** Make the directory if it is not there — this level and no other — and insist that
 *  what is there, made just now or long ago, is a real directory. */
function ensurePlainDirectory(directory: string): void {
  try { fs.mkdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPlainDirectory(directory);
}

/** `directory` is built from the base's real path, so it resolves to itself only while
 *  no part of it below the base is a link. */
function assertPlainDirectory(directory: string): void {
  if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) {
    throw new Error(`${directory} is not a plain directory, so nothing was written into it`);
  }
}

function placeFile(from: string, to: string): void {
  const temporary = `${to}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.copyFileSync(from, temporary, fs.constants.COPYFILE_EXCL);
  try {
    assertPlainDirectory(path.dirname(to));
    fs.renameSync(temporary, to);
  } catch (error) {
    // One file, by the name only this call knows. Nothing is removed by walking a tree.
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
