import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fixture, removeFixtures, sha, snapshot, type Files } from "./fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeFixtures();
});

// `ryoko backup restore` writes back every file its archive holds and removes nothing.
// A bundled skill the sync has replaced since the backup, with a version that has more
// files, comes out of a restore as the old files plus the newer version's extra ones,
// beside the receipt from the archive, which records the old version. Nobody edited
// anything, and the skill must not be taken for one that somebody did.

type Home = ReturnType<typeof fixture>;

/** Archive skills/ the way the daily backup does: all of it, the receipt included. */
function backUp(f: Home): string {
  const archive = path.join(f.root, `archive-${fs.readdirSync(f.root).length}`);
  fs.cpSync(f.skills, archive, { recursive: true });
  return archive;
}

/** Restore it the way the backup does: every archived file is written back, nothing is removed. */
function restore(f: Home, archive: string): void {
  fs.cpSync(archive, f.skills, { recursive: true, force: true });
}

const V1: Files = { "SKILL.md": "v1", "references/a.md": "a1" };
const V2: Files = { "SKILL.md": "v2", "references/a.md": "a1", "references/new.md": "added in v2", "scripts/run.sh": "#!/bin/sh\n" };

const hashes = (files: Files) => Object.fromEntries(Object.entries(files).map(([relative, content]) => [relative, sha(content)]));
const skillDir = (f: Home) => path.join(f.skills, "example");
const write = (f: Home, relative: string, content: string) => fs.writeFileSync(path.join(skillDir(f), ...relative.split("/")), content);

/** Backed up at v1, brought to v2 by the sync, then restored from that backup. */
function restoredOverNewer(): Home {
  const f = fixture();
  f.ship("example", V1);
  f.sync("2026.10.9");
  const archive = backUp(f);
  f.ship("example", V2);
  expect(f.sync("2026.10.10").updated).toEqual(["example"]);
  restore(f, archive);
  // What a restore leaves: the old files, the newer version's extra ones, the old record.
  expect(f.read("example", "SKILL.md")).toBe("v1");
  expect(f.read("example", "references", "new.md")).toBe("added in v2");
  expect(f.receipt().skills.example.files).toEqual(hashes(V1));
  return f;
}

/** The sync left the skill exactly as it was, as one somebody edited: "modified" when a
 *  newer version is waiting for it, "customized" when the shipped one has not changed. */
function expectLeftAsEdited(f: Home, version = "2026.10.10", reason: "modified" | "customized" = "modified"): void {
  const before = snapshot(skillDir(f));
  const result = f.sync(version);
  expect(result).toMatchObject({ updated: [], adopted: [], failed: [], backupDir: null });
  expect(result.kept).toEqual([{ name: "example", reason }]);
  expect(snapshot(skillDir(f))).toEqual(before);
}

describe("bundled skill sync: a skill restored from a backup taken before it was last replaced", () => {
  it("is brought back up to date, and what the restore left is kept beside the other previous copies", () => {
    const f = restoredOverNewer();

    const result = f.sync("2026.10.10");

    expect(result).toMatchObject({ updated: ["example"], kept: [], notices: [], failed: [], inSync: ["example"] });
    for (const [relative, content] of Object.entries(V2)) expect(f.read("example", ...relative.split("/"))).toBe(content);
    expect(f.receipt().skills.example.files).toEqual(hashes(V2));
    const previous = path.join(result.backupDir!, "skills", "example");
    expect(fs.readFileSync(path.join(previous, "SKILL.md"), "utf8")).toBe("v1");
    expect(fs.readFileSync(path.join(previous, "references", "new.md"), "utf8")).toBe("added in v2");
    // From here on it is an ordinary, current skill.
    expect(f.sync("2026.10.10")).toMatchObject({ updated: [], kept: [], inSync: ["example"], backupDir: null });
  });

  it("is brought up to date when the version that ships now also dropped a file the backup had", () => {
    const f = fixture();
    f.ship("example", { ...V1, "references/old.md": "dropped later" });
    f.sync("2026.10.9");
    const archive = backUp(f);
    f.ship("example", V2);
    f.sync("2026.10.10");
    restore(f, archive);
    expect(fs.readdirSync(path.join(skillDir(f), "references")).sort()).toEqual(["a.md", "new.md", "old.md"]);

    expect(f.sync("2026.10.10").updated).toEqual(["example"]);

    expect(fs.readdirSync(path.join(skillDir(f), "references")).sort()).toEqual(["a.md", "new.md"]);
    expect(f.receipt().skills.example.files).toEqual(hashes(V2));
  });

  it("is recognised by the file as this instance was given it: with its own name filled in", () => {
    const f = fixture();
    f.ship("example", V1);
    f.sync("2026.10.9");
    const archive = backUp(f);
    f.ship("example", { ...V2, "references/guide.md": "Ask {{portalName}} first.\n" });
    f.sync("2026.10.10");
    restore(f, archive);
    expect(f.read("example", "references", "guide.md")).toBe("Ask Momo first.\n");

    expect(f.sync("2026.10.10").updated).toEqual(["example"]);
  });

  it("is left alone when one of the extra files is the user's own", () => {
    const f = restoredOverNewer();
    write(f, "notes.md", "mine");
    const before = snapshot(skillDir(f));
    const opened = vi.spyOn(fs, "openSync");

    const result = f.sync("2026.10.10");
    const read = opened.mock.calls.map((call) => String(call[0])).filter((file) => file.startsWith(skillDir(f)));
    opened.mockRestore();

    expect(result).toMatchObject({ updated: [], adopted: [], failed: [], backupDir: null });
    expect(result.kept).toEqual([{ name: "example", reason: "modified" }]);
    expect(snapshot(skillDir(f))).toEqual(before);
    // A file the package has never had at that path settles it: nothing is read to find out.
    expect(read).toEqual([]);
  });

  it("is left alone when an extra file sits where the package has one, but is not the package's", () => {
    const f = restoredOverNewer();
    write(f, "references/new.md", "added in v2, and then changed by me");

    expectLeftAsEdited(f);
  });

  it("is left alone when a file the receipt records was edited as well", () => {
    const f = restoredOverNewer();
    write(f, "SKILL.md", "v1, with my own notes");

    expectLeftAsEdited(f);
  });

  it("is left alone when a file the receipt records is gone", () => {
    const f = restoredOverNewer();
    fs.rmSync(path.join(skillDir(f), "references", "a.md"));

    expectLeftAsEdited(f);
  });

  it("is left alone when the file left behind is no longer what the package ships", () => {
    const f = restoredOverNewer();
    // A later release changed the very file the restore left behind: the copy in the
    // home is an old one now, and no longer proof of anything.
    f.ship("example", { ...V2, "references/new.md": "changed in v3" });

    expectLeftAsEdited(f, "2026.10.11");
  });

  it("is still judged by the receipt, not by looking like an earlier release", () => {
    const f = fixture();
    f.ship("example", V1);
    f.release("v2026.7.1");
    f.ship("example", V2);
    f.sync("2026.10.10");
    // The receipt says v2 was placed. Somebody then put the older text back by hand:
    // the files of an earlier release plus files that ship today, and still an edit.
    write(f, "SKILL.md", "v1");

    expectLeftAsEdited(f, "2026.10.10", "customized");
  });
});

describe("bundled skill sync: the same mix in a home that has no receipt for the skill", () => {
  /** v1 went out in an earlier release; v2 ships now. Nothing records what is in the home. */
  function unrecorded(files: Files): Home {
    const f = fixture();
    f.ship("example", V1);
    f.release("v2026.7.1");
    f.ship("example", V2);
    f.place("example", files);
    return f;
  }

  it("brings an untouched earlier copy up to date though it holds files only the shipped version has", () => {
    const f = unrecorded({ ...V1, "references/new.md": "added in v2" });

    const result = f.sync("2026.10.10");

    expect(result).toMatchObject({ updated: ["example"], kept: [], failed: [] });
    for (const [relative, content] of Object.entries(V2)) expect(f.read("example", ...relative.split("/"))).toBe(content);
    expect(fs.readFileSync(path.join(result.backupDir!, "skills", "example", "references", "new.md"), "utf8")).toBe("added in v2");
    expect(f.receipt().skills.example.files).toEqual(hashes(V2));
  });

  it.each<[string, Files]>([
    ["an extra file of the user's own", { ...V1, "notes.md": "mine" }],
    ["an extra file where the package has one, with other content", { ...V1, "references/new.md": "mine" }],
    ["one shipped extra and one of the user's", { ...V1, "references/new.md": "added in v2", "notes.md": "mine" }],
    ["an edited file of the earlier release beside the extra", { ...V1, "SKILL.md": "v1, edited", "references/new.md": "added in v2" }],
    ["a file of the earlier release missing beside the extra", { "SKILL.md": "v1", "references/new.md": "added in v2" }],
  ])("leaves a copy with %s exactly as it is", (_label, files) => {
    const f = unrecorded(files);
    const before = snapshot(skillDir(f));

    const result = f.sync("2026.10.10");

    expect(result).toMatchObject({ updated: [], adopted: [], backupDir: null });
    expect(result.kept).toEqual([{ name: "example", reason: "unmanaged" }]);
    expect(snapshot(skillDir(f))).toEqual(before);
  });
});
