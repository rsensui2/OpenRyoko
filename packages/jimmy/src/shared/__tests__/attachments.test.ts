import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTACHMENTS_DIR, newAttachmentDir, removeAttachmentDirs } from "../attachments.js";
import { JINN_HOME, TMP_DIR } from "../paths.js";

/* Attachments a connector downloads are named by whoever sent them. Saved
 * straight into tmp/, a file called engine-health.json replaces the gateway's
 * own state file of that name — and the end-of-turn cleanup, which deletes
 * every attachment path, then removes it. So each message gets a directory of
 * its own under tmp/attachments/, and cleanup removes that directory and
 * never anything outside tmp/attachments/. */

const stateFile = path.join(TMP_DIR, "engine-health.json");

beforeEach(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(stateFile, '{"engines":{}}');
});

afterEach(() => {
  fs.rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  fs.rmSync(stateFile, { force: true });
});

function save(dir: string, ...segments: string[]): string {
  const file = path.join(dir, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "bytes");
  return file;
}

describe("newAttachmentDir", () => {
  it("names a directory of its own under tmp/attachments for every message", () => {
    const first = newAttachmentDir();
    const second = newAttachmentDir();
    expect(path.dirname(first)).toBe(ATTACHMENTS_DIR);
    expect(ATTACHMENTS_DIR).toBe(path.join(TMP_DIR, "attachments"));
    expect(second).not.toBe(first);
  });

  it("creates nothing until a file is saved there, so a message without attachments leaves no trace", () => {
    const dir = newAttachmentDir();
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("removeAttachmentDirs", () => {
  it("removes the whole directory of the message an attachment belongs to", () => {
    const dir = newAttachmentDir();
    const first = save(dir, "0", "photo.png");
    const second = save(dir, "1", "photo.png");
    const other = save(newAttachmentDir(), "0", "kept.png");

    removeAttachmentDirs([first, second]);

    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(other)).toBe(true); // another message's files are not ours to remove
  });

  it("leaves alone everything outside tmp/attachments — the gateway's state files above all", () => {
    const outsideHome = save(JINN_HOME, `not-an-attachment-${process.pid}.txt`);
    try {
      removeAttachmentDirs([stateFile, outsideHome, path.join(ATTACHMENTS_DIR, "..", "engine-health.json"), "relative.txt", ""]);
      expect(fs.readFileSync(stateFile, "utf-8")).toBe('{"engines":{}}');
      expect(fs.existsSync(outsideHome)).toBe(true);
    } finally {
      fs.rmSync(outsideHome, { force: true });
    }
  });

  it("never removes tmp/attachments itself", () => {
    const kept = save(newAttachmentDir(), "0", "kept.png");
    removeAttachmentDirs([ATTACHMENTS_DIR, `${ATTACHMENTS_DIR}${path.sep}`]);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it("does not mind a directory that is already gone", () => {
    expect(() => removeAttachmentDirs([path.join(newAttachmentDir(), "0", "photo.png")])).not.toThrow();
  });
});
