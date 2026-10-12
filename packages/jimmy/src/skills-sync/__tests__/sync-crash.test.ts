import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RECEIPT_FILE } from "../receipt.js";
import { fixture, NOW, removeFixtures, sha, snapshot, STAMP, writeTree, type Files } from "./fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeFixtures();
});

type Moment = "before the previous copy is moved away" | "between the two moves" | "before the receipt is brought up to date";

/**
 * Run an update and copy the home as it stands at one instant of it, then make that
 * copy the home: what the next start finds if the process died right there.
 */
function crashDuringUpdate(moment: Moment) {
  const f = fixture();
  f.ship("example", { "SKILL.md": "v1" });
  f.ship("other", { "SKILL.md": "v1" });
  f.sync("2026.10.10");
  f.ship("example", { "SKILL.md": "v2" });
  const frozen = path.join(f.root, "home-at-the-crash");
  const freeze = () => { if (!fs.existsSync(frozen)) fs.cpSync(f.home, frozen, { recursive: true }); };
  const rename = fs.renameSync;
  let receiptWrites = 0;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    const intoBackup = String(to).startsWith(f.backups);
    const fromStaging = String(from).includes(".bundled-skill-");
    const receipt = String(to) === path.join(f.skills, RECEIPT_FILE);
    if (moment === "before the previous copy is moved away" && intoBackup) freeze();
    if (moment === "between the two moves" && fromStaging) freeze();
    // The first receipt write of the run announces the replacement; the second closes it.
    if (moment === "before the receipt is brought up to date" && receipt && ++receiptWrites === 2) freeze();
    return rename(from, to);
  });
  expect(f.sync("2026.10.11").updated).toEqual(["example"]);
  vi.restoreAllMocks();
  expect(fs.existsSync(frozen), "the instant was reached").toBe(true);
  fs.rmSync(f.home, { recursive: true });
  fs.renameSync(frozen, f.home);
  return f;
}

describe("bundled skill sync: a process that dies part-way through replacing a skill", () => {
  it("does not take the skill for one the operator deleted when it died between the two moves", () => {
    const f = crashDuringUpdate("between the two moves");
    // The previous copy is in the backup directory and the new one never landed.
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);

    const result = f.sync("2026.10.11");

    expect(result.kept).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(result.added).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("v2");
    expect(f.receipt().skills.example).toEqual({ version: "2026.10.11", sha256: expect.any(String), files: { "SKILL.md": sha("v2") } });
    // And it stays repaired: nothing left to do, nothing marked.
    expect(f.sync("2026.10.11")).toMatchObject({ added: [], updated: [], kept: [], inSync: ["example", "other"] });
  });

  it("recovers the same way at the next start of a later release", () => {
    const f = crashDuringUpdate("between the two moves");
    f.ship("example", { "SKILL.md": "v3" });

    const result = f.sync("2026.10.12");

    expect(result).toMatchObject({ added: ["example"], kept: [] });
    expect(f.read("example", "SKILL.md")).toBe("v3");
  });

  it("simply replaces the skill when it died before anything was moved", () => {
    const f = crashDuringUpdate("before the previous copy is moved away");
    expect(f.read("example", "SKILL.md")).toBe("v1");

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ updated: ["example"], kept: [], failed: [] });
    expect(f.read("example", "SKILL.md")).toBe("v2");
    expect(f.receipt().skills.example).not.toHaveProperty("replacing");
  });

  it("records the new copy when it died after the skill landed but before the receipt said so", () => {
    const f = crashDuringUpdate("before the receipt is brought up to date");
    expect(f.read("example", "SKILL.md")).toBe("v2");

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ adopted: ["example"], updated: [], kept: [] });
    expect(f.receipt().skills.example).toEqual({ version: "2026.10.11", sha256: expect.any(String), files: { "SKILL.md": sha("v2") } });
  });

  it("still honours a deletion the operator makes after such a crash was repaired", () => {
    const f = crashDuringUpdate("between the two moves");
    f.sync("2026.10.11");
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });

    expect(f.sync("2026.10.11").kept).toEqual([{ name: "example", reason: "deleted" }]);
  });
});

describe("bundled skill sync: announcing a replacement before starting it", () => {
  it("marks the skill in the receipt before moving its previous copy, and clears the mark after", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    const rename = fs.renameSync;
    let markedWhenMoved: unknown = "never moved";
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).startsWith(f.backups)) markedWhenMoved = f.receipt().skills.example.replacing;
      return rename(from, to);
    });

    f.sync("2026.10.11");

    expect(markedWhenMoved).toBe(true);
    expect(f.receipt().skills.example).not.toHaveProperty("replacing");
  });

  it("does not start a replacement it cannot announce", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.ship("fresh", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    f.ship("brand-new", { "SKILL.md": "new" });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path.join(f.skills, RECEIPT_FILE)) throw new Error("read-only file system");
      return rename(from, to);
    });

    const result = f.sync("2026.10.11");

    // Without the mark, a crash mid-way would look like a deletion; so the skill is not touched.
    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("read-only file system") }]);
    expect(f.read("example", "SKILL.md")).toBe("v1");
    expect(fs.existsSync(f.backups)).toBe(false);
    // A skill that is only being added needs no announcement.
    expect(result.added).toEqual(["brand-new"]);
  });

  it.each(["2026.10.10", "2026.10.11"])("clears the mark from a skill whose replacement then failed (package %s)", (version) => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(".bundled-skill-")) throw new Error("rename refused");
      return rename(from, to);
    });

    // Under the same package version nothing else in the receipt changes: it has to be
    // written anyway, or the mark put there before the attempt would stay on disk.
    const result = f.sync(version);

    expect(result.failed.map((failure) => failure.name)).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("v1");
    expect(f.receipt().skills.example).not.toHaveProperty("replacing");
  });

  it("clears a mark left by a crash once the skill is found edited instead", () => {
    const f = crashDuringUpdate("before the previous copy is moved away");
    expect(f.receipt().skills.example.replacing).toBe(true);
    // After the crash, before the next start, the operator edits the skill.
    fs.writeFileSync(path.join(f.skills, "example", "SKILL.md"), "edited after the crash");

    const result = f.sync("2026.10.11");

    expect(result.kept).toEqual([{ name: "example", reason: "modified" }]);
    expect(f.read("example", "SKILL.md")).toBe("edited after the crash");
    expect(f.receipt().skills.example).not.toHaveProperty("replacing");
    // No stale mark means a later deletion is honoured, not "repaired".
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });
    expect(f.sync("2026.10.11").kept).toEqual([{ name: "example", reason: "deleted" }]);
  });

  it.each(["yes", false, 1, null])("refuses a receipt whose replacing mark is %j rather than true", (mark) => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const receipt = f.receipt();
    receipt.skills.example.replacing = mark;
    fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), JSON.stringify(receipt));

    expect(() => f.sync("2026.10.10")).toThrow(RECEIPT_FILE);
  });
});

describe("bundled skill sync: text taken from the home never reaches a log line raw", () => {
  const FORGED = "a\n2026-10-12T00:00:00.000Z [ERROR] gateway compromised\u001b[2K";

  it("quotes a file path from the receipt in its error", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const receipt = f.receipt();
    receipt.skills.example.files[FORGED] = "not a hash";
    fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), JSON.stringify(receipt));

    let message = "";
    try { f.sync("2026.10.10"); } catch (error) { message = (error as Error).message; }

    expect(message).toContain(RECEIPT_FILE);
    expect(message).toContain("gateway compromised");
    // One line, no escape sequences: it cannot pass for a log line of its own.
    expect(message).not.toMatch(/[\n\r\u001b]/);
  });
});

describe("bundled skill sync: staging directories a sync that died left in the home", () => {
  const HOUR = 60 * 60 * 1000;
  const STALE = ".bundled-skill-Ab3xYz";

  /** A directory in the home, last touched `age` milliseconds before the sync runs. */
  function leftover(home: string, name: string, files: Files, age: number): string {
    const directory = path.join(home, name);
    writeTree(directory, files);
    fs.mkdirSync(directory, { recursive: true });
    const touched = new Date(NOW.getTime() - age);
    fs.utimesSync(directory, touched, touched);
    return directory;
  }

  /** A package shipping "example", which once also shipped "retired". */
  function home() {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    f.ship("retired", { "SKILL.md": "v1" });
    f.release("v2026.7.1");
    f.unship("retired");
    return f;
  }

  /** Where this run puts the staging directories it takes out of the home. */
  const setAsideIn = (backups: string, version = "2026.10.10") => path.join(backups, `${version}-${STAMP}`, "staging");

  it("moves one that was abandoned and holds nothing but bundled skills into the backup directory, as it is", () => {
    const f = home();
    // A skill no release has shipped yet: this package is the first to stage it.
    f.ship("brand-new", { "SKILL.md": "v1" });
    // Died while writing "example"; "retired" was staged by an earlier release.
    const stale = leftover(f.home, STALE, { "example/SKILL.md": "v", "retired/SKILL.md": "v1" }, 2 * HOUR);
    const newer = leftover(f.home, ".bundled-skill-zzzzzz", { "brand-new/SKILL.md": "v" }, 2 * HOUR);
    const empty = leftover(f.home, ".bundled-skill-000000", {}, 2 * HOUR);
    const before = snapshot(stale);

    const result = f.sync();

    for (const gone of [stale, newer, empty]) expect(fs.existsSync(gone)).toBe(false);
    expect(result.stagingSetAside).toEqual([".bundled-skill-000000", STALE, ".bundled-skill-zzzzzz"]);
    expect(result.backupDir).toBe(path.join(f.backups, `2026.10.10-${STAMP}`));
    expect(fs.readdirSync(setAsideIn(f.backups)).sort()).toEqual([".bundled-skill-000000", STALE, ".bundled-skill-zzzzzz"]);
    expect(snapshot(path.join(setAsideIn(f.backups), STALE))).toEqual(before);
    // And the run itself is unaffected.
    expect(result.added).toEqual(["brand-new", "example"]);
    expect(fs.readdirSync(f.home).sort()).toEqual([".migration-backups", "skills"]);
  });

  it("moves a directory of the user's that only looks like one with everything in it, where it can be had back", () => {
    const f = home();
    f.sync();
    // A copy the operator set aside before editing the skill, under a name of their own
    // that happens to fit: six letters after the prefix.
    const mine = leftover(f.home, ".bundled-skill-backup", { "example/SKILL.md": "v1, with my own notes", "example/references/a.md": "a1" }, 2 * HOUR);
    const before = snapshot(mine);

    const result = f.sync();

    expect(result.stagingSetAside).toEqual([".bundled-skill-backup"]);
    expect(snapshot(path.join(setAsideIn(f.backups), ".bundled-skill-backup"))).toEqual(before);
    expect(result.backupDir).toBe(path.join(f.backups, `2026.10.10-${STAMP}`));
  });

  it("follows nothing inside it: a directory swapped for a link at the last moment goes along as a link", () => {
    const f = home();
    const outside = path.join(f.root, "outside");
    writeTree(outside, { "keep.md": "the user's", "more/keep.md": "the user's" });
    const kept = snapshot(outside);
    const stale = leftover(f.home, STALE, { "example/SKILL.md": "v", "example/references/a.md": "a" }, 2 * HOUR);
    const rename = fs.renameSync;
    let swapped = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      // Looked over and found to be a sync's own; then, before it is dealt with:
      if (!swapped && String(from) === stale) {
        swapped = true;
        fs.unlinkSync(path.join(stale, "example", "references", "a.md"));
        fs.rmdirSync(path.join(stale, "example", "references"));
        fs.symlinkSync(outside, path.join(stale, "example", "references"));
      }
      return rename(from, to);
    });
    const removals = vi.spyOn(fs, "rmSync");

    const result = f.sync();

    expect(swapped).toBe(true);
    // A recursive delete walks into such a link and empties what it points at.
    expect(snapshot(outside)).toEqual(kept);
    expect(removals.mock.calls.filter(([, options]) => options?.recursive)).toEqual([]);
    expect(fs.readlinkSync(path.join(setAsideIn(f.backups), STALE, "example", "references"))).toBe(outside);
    expect(result.stagingSetAside).toEqual([STALE]);
  });

  it("leaves a recent one: another sync may be staging into it right now", () => {
    const f = home();
    const fresh = leftover(f.home, STALE, { "example/SKILL.md": "v1" }, HOUR / 2);

    const result = f.sync();

    expect(fs.readFileSync(path.join(fresh, "example", "SKILL.md"), "utf8")).toBe("v1");
    expect(result.stagingSetAside).toBeUndefined();
    expect(fs.existsSync(f.backups)).toBe(false);
  });

  it.each<[string, Files]>([
    ["a file of its own at the top", { "notes.md": "mine" }],
    ["a directory that is no bundled skill", { "my-own-skill/SKILL.md": "mine" }],
    ["a bundled skill beside something else", { "example/SKILL.md": "v1", "my-own-skill/SKILL.md": "mine" }],
  ])("leaves one that holds %s: no sync made that", (_label, files) => {
    const f = home();
    const kept = leftover(f.home, STALE, files, 2 * HOUR);
    const before = snapshot(kept);

    expect(f.sync().stagingSetAside).toBeUndefined();

    expect(snapshot(kept)).toEqual(before);
  });

  it("leaves one whose skill holds a link, and what the link points at", () => {
    const f = home();
    const outside = path.join(f.root, "outside.md");
    fs.writeFileSync(outside, "not the sync's");
    const kept = leftover(f.home, STALE, { "example/SKILL.md": "v1" }, 0);
    fs.symlinkSync(outside, path.join(kept, "example", "linked.md"));
    const old = new Date(NOW.getTime() - 2 * HOUR);
    fs.utimesSync(kept, old, old);

    f.sync();

    expect(fs.readlinkSync(path.join(kept, "example", "linked.md"))).toBe(outside);
    expect(fs.readFileSync(outside, "utf8")).toBe("not the sync's");
  });

  it("leaves a link that merely has such a name, and the directory behind it", () => {
    const f = home();
    const elsewhere = leftover(f.root, "elsewhere", { "example/SKILL.md": "v1" }, 2 * HOUR);
    const link = path.join(f.home, STALE);
    fs.symlinkSync(elsewhere, link);
    // The link itself is old too: only being a link saves it.
    const old = new Date(NOW.getTime() - 2 * HOUR);
    fs.lutimesSync(link, old, old);

    f.sync();

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(elsewhere, "example", "SKILL.md"), "utf8")).toBe("v1");
  });

  it.each([".bundled-skill-notes", ".bundled-skill-Ab3xYz1", ".bundled-skill-", "bundled-skill-Ab3xYz", ".bundled-skill-Ab3-Yz"])(
    "leaves %s: a staging directory is never named that",
    (name) => {
      const f = home();
      const kept = leftover(f.home, name, { "example/SKILL.md": "v1" }, 2 * HOUR);

      f.sync();

      expect(fs.existsSync(path.join(kept, "example", "SKILL.md"))).toBe(true);
    },
  );

  it("moves a bounded number in one run, and the rest in the next", () => {
    const f = home();
    for (let index = 0; index < 40; index++) leftover(f.home, `.bundled-skill-${String(index).padStart(6, "0")}`, {}, 2 * HOUR);
    const remaining = () => fs.readdirSync(f.home).filter((name) => name.startsWith(".bundled-skill-")).length;

    expect(f.sync().stagingSetAside).toHaveLength(32);
    expect(remaining()).toBe(8);
    expect(f.sync().stagingSetAside).toHaveLength(8);
    expect(remaining()).toBe(0);
  });

  it("carries on with the sync when one cannot be moved, and leaves no empty backup directory for it", () => {
    const f = home();
    const stale = leftover(f.home, STALE, { "example/SKILL.md": "v" }, 2 * HOUR);
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === stale) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return rename(from, to);
    });

    const result = f.sync();

    expect(result).toMatchObject({ added: ["example"], failed: [], backupDir: null });
    expect(result.stagingSetAside).toBeUndefined();
    expect(fs.readFileSync(path.join(stale, "example", "SKILL.md"), "utf8")).toBe("v");
    expect(fs.existsSync(f.backups)).toBe(false);
  });

  it.each<[string, (stale: string, room: string) => fs.PathLike]>([
    ["as it is made", (_stale, room) => room],
    ["while the directory to be moved is being looked at", (stale) => stale],
  ])("does not move one out of the home when the place it goes to is swapped for a link %s", (_label, moment) => {
    const f = home();
    const stale = leftover(f.home, STALE, { "example/SKILL.md": "v" }, 2 * HOUR);
    const room = setAsideIn(f.backups);
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    const realpath = fs.realpathSync;
    let swapped = false;
    // Both ends are checked before the move, the one it could leave the home through last.
    vi.spyOn(fs, "realpathSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (!swapped && String(target) === String(moment(stale, room)) && fs.existsSync(room)) {
        swapped = true;
        fs.rmdirSync(room);
        fs.symlinkSync(outside, room);
      }
      return (realpath as (...args: unknown[]) => string)(target, ...rest);
    }) as typeof fs.realpathSync);

    const result = f.sync();

    expect(swapped).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(stale, "example", "SKILL.md"), "utf8")).toBe("v");
    expect(result.stagingSetAside).toBeUndefined();
    expect(result).toMatchObject({ added: ["example"], failed: [] });
  });

  it("does not move one when the backup directory is not a place to put it", () => {
    const f = home();
    const stale = leftover(f.home, STALE, { "example/SKILL.md": "v" }, 2 * HOUR);
    const elsewhere = path.join(f.root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, f.backups);

    const result = f.sync();

    // Clearing up is never a reason for the sync to fail, or to leave the home.
    expect(result).toMatchObject({ added: ["example"], failed: [] });
    expect(result.stagingSetAside).toBeUndefined();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(fs.existsSync(stale)).toBe(true);
  });

  it("looks for none in a home it does not sync", () => {
    const f = home();
    const store = path.join(f.root, "my-skills");
    fs.mkdirSync(store);
    fs.symlinkSync(store, f.skills);
    const stale = leftover(f.home, STALE, { "example/SKILL.md": "v" }, 2 * HOUR);

    expect(f.sync()).toMatchObject({ skipped: "skills-root-symlink" });

    expect(fs.existsSync(stale)).toBe(true);
  });

  it("looks for none in a home a newer OpenRyoko synced last", () => {
    const f = home();
    f.sync("2026.10.11");
    const stale = leftover(f.home, STALE, { "example/SKILL.md": "v" }, 2 * HOUR);

    expect(f.sync("2026.10.10")).toMatchObject({ skipped: "newer-receipt" });

    expect(fs.existsSync(stale)).toBe(true);
  });
});
