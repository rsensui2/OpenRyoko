import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENTS_DIR,
  holdAttachmentDirs,
  newAttachmentDir,
  removeAttachmentDirs,
  STALE_ATTACHMENTS_AFTER_MS,
  startAttachmentSweep,
  sweepStaleAttachmentDirs,
} from "../attachments.js";
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

/* A connector saves a message's attachments before anyone decides what to do
 * with the message. One that is then dropped — the bot stays silent, the
 * gateway restarts mid-turn — never reaches the end-of-turn cleanup, and its
 * files stayed for good: anyone who could post in a channel the bot reads
 * could fill the disk. The sweep takes what is left. */
describe("sweepStaleAttachmentDirs", () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.UTC(2026, 9, 12, 12, 0, 0);
  /** Make `target` look as if it was last written `ageMs` before `now`. */
  const aged = (target: string, ageMs: number) => {
    const when = new Date(now - ageMs);
    fs.lutimesSync(target, when, when);
    return target;
  };

  it("removes the directory of a message that arrived more than a day ago, and keeps a recent one", () => {
    const stale = newAttachmentDir();
    const fresh = newAttachmentDir();
    save(stale, "0", "old.png");
    save(fresh, "0", "new.png");
    aged(stale, STALE_ATTACHMENTS_AFTER_MS + HOUR);
    aged(fresh, STALE_ATTACHMENTS_AFTER_MS - HOUR);

    expect(sweepStaleAttachmentDirs(now)).toBe(1);

    expect(removals.requests).toEqual([stale]);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(fresh, "0", "new.png"))).toBe(true);
    expect(STALE_ATTACHMENTS_AFTER_MS).toBe(24 * HOUR);
  });

  it("keeps what a queued or running turn still needs, however old, until that turn lets go of it", () => {
    const waiting = newAttachmentDir();
    const file = save(waiting, "0", "report.pdf");
    aged(waiting, 5 * STALE_ATTACHMENTS_AFTER_MS); // a turn paused for days on a usage limit
    holdAttachmentDirs([file]);

    expect(sweepStaleAttachmentDirs(now)).toBe(0);
    expect(fs.existsSync(file)).toBe(true);

    removeAttachmentDirs([file]); // the turn ended: this is its own cleanup
    expect(fs.existsSync(waiting)).toBe(false);

    // The same directory name coming back is no longer protected.
    save(waiting, "0", "report.pdf");
    aged(waiting, 5 * STALE_ATTACHMENTS_AFTER_MS);
    expect(sweepStaleAttachmentDirs(now)).toBe(1);
  });

  it("holds nothing on the say-so of a path outside tmp/attachments", () => {
    holdAttachmentDirs([stateFile, outsideTmp, ATTACHMENTS_DIR, "relative/path", ""]);
    const stale = aged(path.dirname(path.dirname(save(newAttachmentDir(), "0", "old.png"))), 2 * STALE_ATTACHMENTS_AFTER_MS);
    expect(sweepStaleAttachmentDirs(now)).toBe(1);
    expect(removals.requests).toEqual([stale]);
  });

  it("takes a stray old file too: everything in tmp/attachments is an attachment", () => {
    const stray = aged(save(ATTACHMENTS_DIR, "left-behind.bin"), 2 * STALE_ATTACHMENTS_AFTER_MS);
    expect(sweepStaleAttachmentDirs(now)).toBe(1);
    expect(fs.existsSync(stray)).toBe(false);
  });

  it("removes an old link by itself and leaves what it points at alone", () => {
    const link = path.join(ATTACHMENTS_DIR, "planted-link");
    fs.symlinkSync(JINN_HOME, link);
    aged(link, 2 * STALE_ATTACHMENTS_AFTER_MS);

    sweepStaleAttachmentDirs(now);

    expect(removals.requests).toEqual([link]); // never the directory the link leads to
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(outsideTmp, "utf-8")).toBe("keep me");
    expect(fs.readFileSync(stateFile, "utf-8")).toBe('{"engines":{}}');
  });

  it("asks to remove nothing but direct children of tmp/attachments, and never tmp/attachments itself", () => {
    for (let n = 0; n < 5; n++) aged(path.dirname(path.dirname(save(newAttachmentDir(), "0", `f${n}.png`))), 3 * STALE_ATTACHMENTS_AFTER_MS);
    aged(ATTACHMENTS_DIR, 3 * STALE_ATTACHMENTS_AFTER_MS);

    expect(sweepStaleAttachmentDirs(now)).toBe(5);

    expect(removals.requests).toHaveLength(5);
    for (const request of removals.requests) expect(path.dirname(request)).toBe(ATTACHMENTS_DIR);
    expect(fs.existsSync(ATTACHMENTS_DIR)).toBe(true);
  });

  it("does nothing, and does not fail, when no attachment was ever saved", () => {
    removals.remove(ATTACHMENTS_DIR, { recursive: true, force: true }); // the test's own, inside its sandbox
    expect(sweepStaleAttachmentDirs(now)).toBe(0);
    expect(removals.requests).toEqual([]);
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true }); // for afterEach
  });

  it("carries on past an entry it cannot remove", () => {
    const stuck = aged(path.dirname(path.dirname(save(newAttachmentDir(), "0", "a.png"))), 2 * STALE_ATTACHMENTS_AFTER_MS);
    const fine = aged(path.dirname(path.dirname(save(newAttachmentDir(), "0", "b.png"))), 2 * STALE_ATTACHMENTS_AFTER_MS);
    const real = vi.mocked(fs.rmSync).getMockImplementation()!;
    vi.mocked(fs.rmSync).mockImplementation((target, options) => {
      if (target === stuck) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      return real(target, options);
    });

    expect(sweepStaleAttachmentDirs(now)).toBe(1);

    expect(fs.existsSync(fine)).toBe(false);
    expect(fs.existsSync(stuck)).toBe(true);
  });
});

describe("startAttachmentSweep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sweeps when the gateway starts, then every hour, until it is stopped", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 12, 12, 0, 0) });
    const leftBehind = (ageMs: number) => {
      const dir = path.dirname(path.dirname(save(newAttachmentDir(), "0", "x.png")));
      const when = new Date(Date.now() - ageMs);
      fs.lutimesSync(dir, when, when);
      return dir;
    };
    const fromBeforeTheRestart = leftBehind(2 * STALE_ATTACHMENTS_AFTER_MS);
    const almostStale = leftBehind(STALE_ATTACHMENTS_AFTER_MS - 30 * 60 * 1000);

    const stop = startAttachmentSweep();
    expect(fs.existsSync(fromBeforeTheRestart)).toBe(false); // at start
    expect(fs.existsSync(almostStale)).toBe(true);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(fs.existsSync(almostStale)).toBe(false); // an hour later it is over a day old

    stop();
    const afterStop = leftBehind(2 * STALE_ATTACHMENTS_AFTER_MS);
    vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    expect(fs.existsSync(afterStop)).toBe(true);
  });

  it("is started when the gateway boots and stopped when it shuts down", () => {
    // Wiring, checked in the source: the boot function cannot be run in a test.
    const server = fs.readFileSync(new URL("../../gateway/server.ts", import.meta.url), "utf-8");
    expect(server).toContain("const stopAttachmentSweep = startAttachmentSweep();");
    expect(server).toContain("stopAttachmentSweep();");
  });

  it("does not keep the process alive for the sake of the sweep", () => {
    const unref = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    startAttachmentSweep()();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
