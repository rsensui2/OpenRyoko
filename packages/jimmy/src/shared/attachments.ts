import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";
import { TMP_DIR } from "./paths.js";

/**
 * Where connectors keep the attachments they download: tmp/attachments/, one
 * directory per incoming message.
 *
 * Not tmp/ itself. An attachment is named by whoever sent it, and tmp/ also
 * holds the gateway's own state (engine-health.json, claude-usage.json): a
 * file with one of those names would replace it, and the end-of-turn cleanup
 * would then delete it. A directory per message also keeps two messages — or
 * two files of one message — with the same file name from overwriting each
 * other while a turn is still reading them.
 *
 * Absolute, always. The home can be given as a relative path (RYOKO_HOME=./home),
 * and the cleanup below refuses every relative path it is handed — it must
 * never guess what one is relative to. Left relative, this directory was
 * refused along with them, and nothing was ever removed or swept. It is
 * resolved here, once, against the directory the gateway was started in.
 */
export const ATTACHMENTS_DIR = path.resolve(TMP_DIR, "attachments");

/**
 * A directory for the attachments of one incoming message. Only the name is
 * decided here; whoever saves a file creates the directory, so a message
 * without attachments (or whose downloads all fail) leaves nothing behind.
 */
export function newAttachmentDir(): string {
  return path.join(ATTACHMENTS_DIR, randomUUID());
}

/**
 * Where the `slot`-th attachment of a message goes inside that message's
 * directory. One slot each, because one message can carry two files with the
 * same name (Discord calls every pasted screenshot image.png).
 */
export function attachmentSlot(messageDir: string, slot: number): string {
  return path.join(messageDir, String(slot));
}

/**
 * The per-message directory under tmp/attachments/ that `filePath` lies in, or
 * null when it lies anywhere else. A path that is not absolute is not
 * resolved, it is refused: what it is relative to is anybody's guess.
 */
function messageDirOf(filePath: unknown): string | null {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath) || !path.isAbsolute(ATTACHMENTS_DIR)) return null;
  const root = path.normalize(ATTACHMENTS_DIR);
  const relative = path.relative(root, path.normalize(filePath));
  const [messageDir] = relative.split(path.sep);
  if (!messageDir || messageDir === ".." || path.isAbsolute(relative)) return null;
  const directory = path.join(root, messageDir);
  // Checked once more where it counts: only a direct child of tmp/attachments/.
  return path.dirname(directory) === root ? directory : null;
}

/** Directories a queued or running turn still reads from: the sweep leaves them. */
const heldDirs = new Set<string>();

/**
 * Keep the per-message directories of these attachment files out of the
 * sweep until {@link removeAttachmentDirs} is called for them. A turn can wait
 * far longer than a day before it reads its attachments — behind a long
 * session, or paused on a usage limit — and must still find them.
 */
export function holdAttachmentDirs(filePaths: readonly string[]): void {
  for (const filePath of filePaths) {
    const directory = messageDirOf(filePath);
    if (directory) heldDirs.add(directory);
  }
}

/**
 * Remove the per-message directories the given attachment files were saved
 * in. A path that is not inside tmp/attachments/ is left alone: this is called
 * with whatever a connector put in `localPath`, and must never delete on its
 * say-so anything but an attachment directory.
 */
export function removeAttachmentDirs(filePaths: readonly string[]): void {
  const directories = new Set<string>();
  for (const filePath of filePaths) {
    const directory = messageDirOf(filePath);
    if (directory) directories.add(directory);
  }
  for (const directory of directories) {
    heldDirs.delete(directory);
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp directory is not worth failing a turn over.
    }
  }
}

/** How long a message's attachments stay when nothing came to remove them. */
export const STALE_ATTACHMENTS_AFTER_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

/**
 * Remove what has been lying in tmp/attachments/ for longer than
 * `olderThanMs`, and return how many entries went.
 *
 * Attachments are saved when a message arrives and removed when its turn
 * ends. A message that never gets a turn — the bot stays silent on it, the
 * gateway is restarted first — left its files for good, so that posting files
 * where the bot reads was enough to fill the disk. Only direct children of
 * tmp/attachments/ are removed (a link is removed as a link), never the
 * directory itself, and never one a turn still holds.
 */
export function sweepStaleAttachmentDirs(now: number = Date.now(), olderThanMs: number = STALE_ATTACHMENTS_AFTER_MS): number {
  if (!path.isAbsolute(ATTACHMENTS_DIR)) return 0;
  const root = path.normalize(ATTACHMENTS_DIR);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0; // nothing was ever saved here
  }
  let removed = 0;
  for (const name of names) {
    const entry = path.join(root, name);
    if (path.dirname(entry) !== root || heldDirs.has(entry)) continue;
    try {
      if (fs.lstatSync(entry).mtimeMs > now - olderThanMs) continue;
      fs.rmSync(entry, { recursive: true, force: true });
      removed++;
    } catch {
      // Best effort: the next sweep tries again.
    }
  }
  return removed;
}

/**
 * Sweep now — what a previous run of the gateway left behind — and then every
 * hour. Returns the function that stops it. The timer never keeps the process
 * alive on its own.
 */
export function startAttachmentSweep(): () => void {
  const sweep = () => {
    const removed = sweepStaleAttachmentDirs();
    if (removed > 0) logger.info(`Removed ${removed} leftover attachment director${removed === 1 ? "y" : "ies"} older than a day`);
  };
  sweep();
  const timer = setInterval(sweep, SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
