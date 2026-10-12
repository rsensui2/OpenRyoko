import crypto from "node:crypto";
import fs from "node:fs";

/** A receipt for a few dozen skills is a few kilobytes. Anything near this is not one. */
export const MAX_RECEIPT_BYTES = 1024 * 1024;
/** Bundled skill files are text of a few kilobytes; nothing a release ships comes close. */
export const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024;
/** Files and directories in one skill. The largest bundled skill has a handful. */
export const MAX_SKILL_ENTRIES = 500;

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
 * meanwhile is still cut off.
 */
function readInChunks(file: string, maxBytes: number, consume: (chunk: Buffer) => void): void {
  const fd = fs.openSync(file, OPEN_FLAGS);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("it is not a regular file");
    if (stat.size > maxBytes) throw new TooLargeError(`it is larger than ${maxBytes} bytes`);
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, CHUNK_BYTES, null);
      if (read === 0) return;
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

/** The file's sha256, without ever holding more than one chunk of it. */
export function hashBounded(file: string, maxBytes: number): string {
  const hash = crypto.createHash("sha256");
  readInChunks(file, maxBytes, (chunk) => { hash.update(chunk); });
  return hash.digest("hex");
}
