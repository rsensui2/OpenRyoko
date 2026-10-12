import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENTS_DIR, newAttachmentDir, removeAttachmentDirs } from "../attachments.js";
import { JINN_HOME, TMP_DIR } from "../paths.js";
import { confineRemovals, type ConfinedRemovals } from "../test-support/confined-removals.js";

/* Attachments a connector downloads are named by whoever sent them. Saved
 * straight into tmp/, a file called engine-health.json replaces the gateway's
 * own state file of that name — and the end-of-turn cleanup, which deletes
 * every attachment path, then removes it. So each message gets a directory of
 * its own under tmp/attachments/, and cleanup removes that directory and
 * never anything outside tmp/attachments/.
 *
 * The code under test deletes directories, so these tests must stay harmless
 * when it is wrong. Two rules keep them that way:
 *  - fs.rmSync is confined (see test-support/confined-removals.ts): it really
 *    deletes only inside this test's own tmp/attachments/; any other request
 *    is recorded and dropped. A broken safety check then fails an assertion
 *    on `removals.requests` instead of removing files.
 *  - Every path handed to the code is absolute and inside the test home. The
 *    one test about relative paths first moves the working directory (as the
 *    code sees it) into tmp/attachments/. */

const stateFile = path.join(TMP_DIR, "engine-health.json");
const outsideTmp = path.join(JINN_HOME, "not-an-attachment.txt");
let removals: ConfinedRemovals;

function save(dir: string, ...segments: string[]): string {
  const file = path.join(dir, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "bytes");
  return file;
}

beforeEach(() => {
  // Before anything is created or removed: refuses a sandbox that is not
  // inside the OS temp directory.
  removals = confineRemovals(ATTACHMENTS_DIR);
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  fs.writeFileSync(stateFile, '{"engines":{}}');
  fs.writeFileSync(outsideTmp, "keep me");
});

afterEach(() => {
  vi.restoreAllMocks();
  // The test's own cleanup: only what lives inside tmp/attachments/ is removed
  // recursively; the two marker files are single files this test created.
  for (const entry of fs.readdirSync(ATTACHMENTS_DIR)) removals.remove(path.join(ATTACHMENTS_DIR, entry), { recursive: true, force: true });
  fs.unlinkSync(stateFile);
  fs.unlinkSync(outsideTmp);
});

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
  it("removes the whole directory of the message an attachment belongs to, and only that", () => {
    const dir = newAttachmentDir();
    const first = save(dir, "0", "photo.png");
    const second = save(dir, "1", "photo.png");
    const other = save(newAttachmentDir(), "0", "kept.png");

    removeAttachmentDirs([first, second]);

    expect(removals.requests).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(other)).toBe(true); // another message's files are not ours to remove
  });

  it("asks to remove nothing for a path outside tmp/attachments — the gateway's state files above all", () => {
    removeAttachmentDirs([
      stateFile,
      outsideTmp,
      TMP_DIR,
      JINN_HOME,
      path.dirname(JINN_HOME),
      path.join(ATTACHMENTS_DIR, "..", "engine-health.json"),
      path.join(ATTACHMENTS_DIR, "some-message", "..", "..", "engine-health.json"),
      `${ATTACHMENTS_DIR}-sibling${path.sep}file.png`,
    ]);

    expect(removals.requests).toEqual([]);
    expect(fs.readFileSync(stateFile, "utf-8")).toBe('{"engines":{}}');
    expect(fs.readFileSync(outsideTmp, "utf-8")).toBe("keep me");
  });

  it("never asks to remove tmp/attachments itself", () => {
    const kept = save(newAttachmentDir(), "0", "kept.png");
    removeAttachmentDirs([ATTACHMENTS_DIR, `${ATTACHMENTS_DIR}${path.sep}`, path.join(ATTACHMENTS_DIR, ".")]);
    expect(removals.requests).toEqual([]);
    expect(fs.existsSync(kept)).toBe(true);
  });

  it("ignores a path that is not absolute instead of resolving it against the working directory", () => {
    const dir = newAttachmentDir();
    const file = save(dir, "0", "photo.png");
    // Seen from inside tmp/attachments/, these relative paths point straight at
    // a real attachment — resolving them would find something to delete. (The
    // working directory is only pretended: nothing here can reach outside.)
    vi.spyOn(process, "cwd").mockReturnValue(ATTACHMENTS_DIR);

    removeAttachmentDirs([path.relative(ATTACHMENTS_DIR, file), path.basename(dir), `.${path.sep}${path.basename(dir)}`, ".", ""]);

    expect(removals.requests).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("ignores what is not a path at all", () => {
    removeAttachmentDirs([undefined, null, 42, {}, ["x"]] as unknown as string[]);
    expect(removals.requests).toEqual([]);
  });

  it("does not mind a directory that is already gone", () => {
    const dir = newAttachmentDir();
    expect(() => removeAttachmentDirs([path.join(dir, "0", "photo.png")])).not.toThrow();
    expect(removals.requests).toEqual([dir]);
  });

  it("carries on when one directory cannot be removed", () => {
    const stuck = newAttachmentDir();
    const fine = newAttachmentDir();
    const kept = save(stuck, "0", "a.png");
    const gone = save(fine, "0", "b.png");
    vi.mocked(fs.rmSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    });

    expect(() => removeAttachmentDirs([kept, gone])).not.toThrow();

    expect(fs.existsSync(gone)).toBe(false);
  });
});
