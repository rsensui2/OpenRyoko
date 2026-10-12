import crypto from "node:crypto";
import fs from "node:fs";

/** A receipt for a few dozen skills is a few kilobytes. Anything near this is not one. */
export const MAX_RECEIPT_BYTES = 1024 * 1024;
/** One file of a skill. Bundled skill files are text; the largest ships at 13 KB. */
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
/** All the files of one skill together. The largest bundled skill is 35 KB. Without
 *  this, a skill of many files each just under the limit above is gigabytes to hash. */
export const MAX_SKILL_BYTES = 2 * 1024 * 1024;
/** Files and directories in one skill. The largest bundled skill has five files. */
export const MAX_SKILL_ENTRIES = 500;

/** What may be read from the files of one skill: `file` bytes of any one of them, and
 *  `total` bytes of all of them together. */
export interface ReadLimits {
  file: number;
  total: number;
}
export const SKILL_LIMITS: ReadLimits = { file: MAX_SKILL_FILE_BYTES, total: MAX_SKILL_BYTES };

const CHUNK_BYTES = 64 * 1024;
// Never through a link, and never blocking on a FIFO swapped in after the lstat.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** The file, or the skill holding it, is bigger than anything the sync has business reading. */
export class TooLargeError extends Error {}

/**
 * Feed a regular file of at most `maxBytes` to `consume`, in chunks. The home is the
 * user's: a file there can be any size, and a start-up that reads one whole can be
 * made to run out of memory — which kills the process outright, past any try/catch.
 * The size is checked on the open file and again as it is read, so a file that grows
 * meanwhile is still cut off. Returns the number of bytes read.
 */
function readInChunks(file: string, maxBytes: number, consume: (chunk: Buffer) => void): number {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("it is not a regular file");
    if (stat.size > maxBytes) throw new TooLargeError(`it is larger than ${maxBytes} bytes`);
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, CHUNK_BYTES, null);
      if (read === 0) return total;
      total += read;
      if (total > maxBytes) throw new TooLargeError(`it is larger than ${maxBytes} bytes`);
      consume(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The names in a directory, or null when it holds more than `max`. Entries are read
 * one at a time and never more than `max` + 1 of them: a directory in the home can
 * hold any number, and listing it whole is what a start-up must not do.
 */
export function listBounded(directory: string, max: number): string[] | null {
  const names: string[] = [];
  const handle = fs.opendirSync(directory);
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (names.length >= max) return null;
      names.push(entry.name);
    }
    return names;
  } finally {
    handle.closeSync();
  }
}

/** The whole file, when it is small enough to hold. */
export function readBounded(file: string, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  readInChunks(file, maxBytes, (chunk) => { chunks.push(Buffer.from(chunk)); });
  return Buffer.concat(chunks);
}

/**
 * Read the files of one skill, in order, under one budget: each may take what is left
 * of `limits.total`, and never more than `limits.file`. The file that would break the
 * budget is not read, and the ones after it are not opened.
 */
function eachBounded<T>(files: readonly string[], limits: ReadLimits, read: (file: string, maxBytes: number) => { value: T; bytes: number }): T[] {
  let remaining = limits.total;
  return files.map((file) => {
    const { value, bytes } = read(file, Math.min(limits.file, remaining));
    remaining -= bytes;
    return value;
  });
}

/** The sha256 of each file, without ever holding more than one chunk of any. */
export function hashEachBounded(files: readonly string[], limits: ReadLimits): string[] {
  return eachBounded(files, limits, (file, maxBytes) => {
    const hash = crypto.createHash("sha256");
    const bytes = readInChunks(file, maxBytes, (chunk) => { hash.update(chunk); });
    return { value: hash.digest("hex"), bytes };
  });
}

/** Each file whole: together they are at most `limits.total` bytes. */
export function readEachBounded(files: readonly string[], limits: ReadLimits): Buffer[] {
  return eachBounded(files, limits, (file, maxBytes) => {
    const value = readBounded(file, maxBytes);
    return { value, bytes: value.length };
  });
}
