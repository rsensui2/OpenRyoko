import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
 */
export const ATTACHMENTS_DIR = path.join(TMP_DIR, "attachments");

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
 * Remove the per-message directories the given attachment files were saved
 * in. A path that is not inside tmp/attachments/ is left alone: this is called
 * with whatever a connector put in `localPath`, and must never delete on its
 * say-so anything but an attachment directory.
 */
export function removeAttachmentDirs(filePaths: readonly string[]): void {
  // Nothing here may depend on the working directory: a relative path is not
  // resolved, it is skipped. Attachment paths are always absolute.
  if (!path.isAbsolute(ATTACHMENTS_DIR)) return;
  const root = path.normalize(ATTACHMENTS_DIR);
  const directories = new Set<string>();
  for (const filePath of filePaths) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) continue;
    const relative = path.relative(root, path.normalize(filePath));
    const [messageDir] = relative.split(path.sep);
    if (!messageDir || messageDir === ".." || path.isAbsolute(relative)) continue;
    directories.add(path.join(root, messageDir));
  }
  for (const directory of directories) {
    // Checked once more where it counts: only a direct child of tmp/attachments/.
    if (path.dirname(directory) !== root) continue;
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp directory is not worth failing a turn over.
    }
  }
}
