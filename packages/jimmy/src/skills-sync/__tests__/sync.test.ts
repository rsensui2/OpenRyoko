import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { RECEIPT_FILE } from "../receipt.js";
import { syncBundledSkills } from "../sync.js";
import { fixture, NOW, removeFixtures, sha, snapshot, STAMP, writeTree } from "./fixture.js";

/** Every fs call that changes the disk. A run with nothing to do must reach none of them. */
const MUTATORS = [
  "writeFileSync", "appendFileSync", "renameSync", "mkdirSync", "mkdtempSync", "rmSync", "rmdirSync",
  "unlinkSync", "cpSync", "copyFileSync", "chmodSync", "symlinkSync", "linkSync", "utimesSync", "truncateSync",
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  removeFixtures();
});

describe("bundled skill sync: what happens to each skill", () => {
  it("installs a shipped skill the home does not have and records what it placed", () => {
    const f = fixture();
    const binary = Buffer.from([0, 255, 11, 22]);
    f.ship("example", {
      "SKILL.md": "Hello {{portalName}}",
      "references/config.yaml": "name: {{portalSlug}}",
      "assets/blob.bin": binary,
    });
    writeTree(path.join(f.template, "skills", "unfinished"), { "notes.md": "not a skill" });

    const result = f.sync();

    expect(result).toMatchObject({ added: ["example"], updated: [], adopted: [], retired: [], kept: [], failed: [], backupDir: null });
    expect(result.inSync).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("Hello Momo");
    expect(f.read("example", "references", "config.yaml")).toBe("name: momo");
    expect(fs.readFileSync(path.join(f.skills, "example", "assets", "blob.bin"))).toEqual(binary);
    expect(fs.existsSync(path.join(f.skills, "unfinished"))).toBe(false);
    expect(f.receipt()).toEqual({
      schemaVersion: 1,
      packageVersion: "2026.10.10",
      skills: {
        example: {
          version: "2026.10.10",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          files: {
            "SKILL.md": sha("Hello Momo"),
            "assets/blob.bin": sha(binary),
            "references/config.yaml": sha("name: momo"),
          },
        },
      },
      notices: {},
    });
  });

  it("leaves a symlinked skill and whatever it points at alone", () => {
    const f = fixture();
    for (const name of ["linked", "dangling"]) f.ship(name, { "SKILL.md": "shipped" });
    const elsewhere = path.join(f.root, "my-skills", "linked");
    writeTree(elsewhere, { "SKILL.md": "the user's own copy" });
    fs.mkdirSync(f.skills);
    fs.symlinkSync(elsewhere, path.join(f.skills, "linked"));
    fs.symlinkSync("missing-user-source", path.join(f.skills, "dangling"));
    const before = snapshot(f.root);

    const result = f.sync();

    expect(result).toMatchObject({ added: [], updated: [], adopted: [], notices: [] });
    expect(result.kept).toEqual([{ name: "dangling", reason: "symlink" }, { name: "linked", reason: "symlink" }]);
    expect(f.receipt().skills).toEqual({});
    // The receipt is the only thing the sync may add; links and targets stay as they were.
    const after = snapshot(f.root);
    delete after[path.join("instance", "skills", RECEIPT_FILE)];
    expect(after).toEqual(before);
  });

  it("leaves a skill alone when anything inside it is a symlink, even with identical content", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    const shared = path.join(f.root, "shared-references");
    writeTree(shared, { "a.md": "a1" });
    f.place("example", { "SKILL.md": "v1" });
    fs.symlinkSync(shared, path.join(f.skills, "example", "references"));
    const skillBefore = snapshot(path.join(f.skills, "example"));
    const sharedBefore = snapshot(shared);

    // Read through the link, this copy is byte-identical to the shipped skill.
    const identical = f.sync("2026.10.10");
    expect(identical.kept).toEqual([{ name: "example", reason: "symlink" }]);
    expect(identical).toMatchObject({ added: [], updated: [], adopted: [], notices: [], backupDir: null });

    f.ship("example", { "SKILL.md": "v2", "references/a.md": "a2" });
    const changed = f.sync("2026.10.11");

    expect(changed.kept).toEqual([{ name: "example", reason: "symlink" }]);
    expect(changed).toMatchObject({ added: [], updated: [], adopted: [], notices: [], backupDir: null });
    expect(snapshot(path.join(f.skills, "example"))).toEqual(skillBefore);
    expect(snapshot(shared)).toEqual(sharedBefore);
    expect(f.receipt().skills).toEqual({});
  });

  it("replaces an unmodified skill when the shipped version changes, keeping the previous copy", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1", "references/gone.md": "dropped in v2" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2 for {{portalName}}", "references/a.md": "a1" });

    const result = f.sync("2026.10.11");

    const backup = path.join(f.backups, `2026.10.11-${STAMP}`);
    expect(result).toMatchObject({ added: [], updated: ["example"], retired: [], kept: [], failed: [], backupDir: backup });
    expect(f.read("example", "SKILL.md")).toBe("v2 for Momo");
    expect(fs.existsSync(path.join(f.skills, "example", "references", "gone.md"))).toBe(false);
    expect(fs.readFileSync(path.join(backup, "skills", "example", "SKILL.md"), "utf8")).toBe("v1");
    expect(fs.readFileSync(path.join(backup, "skills", "example", "references", "gone.md"), "utf8")).toBe("dropped in v2");
    expect(f.receipt().skills.example).toMatchObject({
      version: "2026.10.11",
      files: { "SKILL.md": sha("v2 for Momo"), "references/a.md": sha("a1") },
    });
    expect(f.receipt().packageVersion).toBe("2026.10.11");
  });

  it("never overwrites a skill the user edited, and says an update is waiting", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    fs.writeFileSync(path.join(f.skills, "example", "SKILL.md"), "v1 plus my own rules");
    const recorded = f.receipt().skills.example;
    f.ship("example", { "SKILL.md": "v2" });

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ added: [], updated: [], adopted: [], retired: [], backupDir: null });
    expect(result.kept).toEqual([{ name: "example", reason: "modified" }]);
    expect(result.notices).toEqual([{ name: "example", reason: "modified" }]);
    expect(result.inSync).toEqual([]);
    expect(f.read("example", "SKILL.md")).toBe("v1 plus my own rules");
    expect(f.receipt().skills.example).toEqual(recorded);
    expect(fs.existsSync(f.backups)).toBe(false);
  });

  it("keeps an edited skill quietly while the shipped version has not moved on", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    fs.writeFileSync(path.join(f.skills, "example", "SKILL.md"), "v1 plus my own rules");

    const result = f.sync("2026.10.11");

    expect(result.kept).toEqual([{ name: "example", reason: "customized" }]);
    expect(result.notices).toEqual([]);
    expect(f.read("example", "SKILL.md")).toBe("v1 plus my own rules");
  });

  it("treats a file the user added to a shipped skill as an edit", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    fs.writeFileSync(path.join(f.skills, "example", "my-notes.md"), "mine");
    f.ship("example", { "SKILL.md": "v2" });

    const result = f.sync("2026.10.11");

    expect(result.kept).toEqual([{ name: "example", reason: "modified" }]);
    expect(f.read("example", "SKILL.md")).toBe("v1");
    expect(f.read("example", "my-notes.md")).toBe("mine");
  });

  it("adopts a skill that already matches the shipped version without rewriting it", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "Hello {{portalName}}", "references/a.md": "a1" });
    f.place("example", { "SKILL.md": "Hello Momo", "references/a.md": "a1" });
    const before = snapshot(path.join(f.skills, "example"));
    const inode = fs.statSync(path.join(f.skills, "example")).ino;

    const result = f.sync();

    expect(result).toMatchObject({ added: [], updated: [], adopted: ["example"], kept: [], notices: [], backupDir: null });
    expect(result.inSync).toEqual(["example"]);
    expect(snapshot(path.join(f.skills, "example"))).toEqual(before);
    expect(fs.statSync(path.join(f.skills, "example")).ino).toBe(inode);
    expect(f.receipt().skills.example.files).toEqual({ "SKILL.md": sha("Hello Momo"), "references/a.md": sha("a1") });
  });

  it("adopts a copy whose placeholders were never filled in, as an AI-applied migration leaves it", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "Hello {{portalName}}" });
    f.place("example", { "SKILL.md": "Hello {{portalName}}" });

    expect(f.sync("2026.10.10").adopted).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("Hello {{portalName}}");
    expect(f.receipt().skills.example.files).toEqual({ "SKILL.md": sha("Hello {{portalName}}") });
    expect(f.sync("2026.10.10")).toMatchObject({ updated: [], adopted: [], inSync: ["example"] });

    f.ship("example", { "SKILL.md": "Hi {{portalName}}" });
    expect(f.sync("2026.10.11").updated).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("Hi Momo");
  });

  it("leaves an unrecorded skill that differs from the shipped version alone, and says so", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v2", "references/new.md": "must not be mixed in" });
    f.place("example", { "SKILL.md": "an older copy, or the user's own" });
    const before = snapshot(path.join(f.skills, "example"));

    const result = f.sync();

    expect(result).toMatchObject({ added: [], updated: [], adopted: [], inSync: [], backupDir: null });
    expect(result.kept).toEqual([{ name: "example", reason: "unmanaged" }]);
    expect(result.notices).toEqual([{ name: "example", reason: "unmanaged" }]);
    expect(snapshot(path.join(f.skills, "example"))).toEqual(before);
    expect(f.receipt().skills).toEqual({});
  });

  it("moves a retired, unmodified skill to the backup directory and forgets it", () => {
    const f = fixture();
    f.ship("staying", { "SKILL.md": "stays" });
    f.ship("old", { "SKILL.md": "retired soon", "references/a.md": "a1" });
    f.sync("2026.10.10");
    f.unship("old");

    const result = f.sync("2026.10.11");

    const backup = path.join(f.backups, `2026.10.11-${STAMP}`);
    expect(result).toMatchObject({ added: [], updated: [], retired: ["old"], kept: [], backupDir: backup });
    expect(fs.existsSync(path.join(f.skills, "old"))).toBe(false);
    expect(fs.readFileSync(path.join(backup, "skills", "old", "SKILL.md"), "utf8")).toBe("retired soon");
    expect(fs.readFileSync(path.join(backup, "skills", "old", "references", "a.md"), "utf8")).toBe("a1");
    expect(Object.keys(f.receipt().skills)).toEqual(["staying"]);
    expect(f.read("staying", "SKILL.md")).toBe("stays");
  });

  it("keeps a retired skill the user edited", () => {
    const f = fixture();
    f.ship("staying", { "SKILL.md": "stays" });
    f.ship("old", { "SKILL.md": "retired soon" });
    f.sync("2026.10.10");
    fs.writeFileSync(path.join(f.skills, "old", "SKILL.md"), "retired soon, but I rely on my version");
    f.unship("old");

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ retired: [], notices: [], backupDir: null });
    expect(result.kept).toEqual([{ name: "old", reason: "retired-modified" }]);
    expect(f.read("old", "SKILL.md")).toBe("retired soon, but I rely on my version");
    expect(fs.existsSync(f.backups)).toBe(false);
  });

  it("never claims a skill the user created under a name the package does not ship", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.place("mine", { "SKILL.md": "written by the user" });
    f.sync("2026.10.10");

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ retired: [], kept: [] });
    expect(f.read("mine", "SKILL.md")).toBe("written by the user");
    expect(Object.keys(f.receipt().skills)).toEqual(["example"]);
  });

  it("does not take an empty directory for a missing or deleted skill", () => {
    const f = fixture();
    f.ship("unwanted", { "SKILL.md": "v1" });
    f.ship("dropped-later", { "SKILL.md": "v1" });
    fs.mkdirSync(path.join(f.skills, "unwanted"), { recursive: true });
    f.sync("2026.10.10");
    fs.rmSync(path.join(f.skills, "dropped-later"), { recursive: true });
    fs.mkdirSync(path.join(f.skills, "dropped-later"));

    // Not missing, so not deleted: neither an ordinary run nor a restore fills them in.
    for (const result of [f.sync("2026.10.10"), f.restore("2026.10.10")]) {
      expect(result.added).toEqual([]);
      expect(result.kept).toEqual([{ name: "dropped-later", reason: "customized" }, { name: "unwanted", reason: "unmanaged" }]);
    }
    expect(fs.readdirSync(path.join(f.skills, "unwanted"))).toEqual([]);
    expect(fs.readdirSync(path.join(f.skills, "dropped-later"))).toEqual([]);
  });

  it("leaves a plain file that occupies a shipped skill's name alone", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    fs.mkdirSync(f.skills);
    fs.writeFileSync(path.join(f.skills, "example"), "reserved by user");

    const result = f.sync();

    expect(result.kept).toEqual([{ name: "example", reason: "not-directory" }]);
    expect(fs.readFileSync(path.join(f.skills, "example"), "utf8")).toBe("reserved by user");
  });
});

describe("bundled skill sync: repeat runs", () => {
  it("writes nothing on a second run", () => {
    const f = fixture();
    // One skill in every state the sync distinguishes.
    for (const name of ["pristine", "edited", "retiring", "removed"]) f.ship(name, { "SKILL.md": `${name} v1`, "references/a.md": "a1" });
    f.sync("2026.10.10");
    fs.writeFileSync(path.join(f.skills, "edited", "SKILL.md"), "edited by the user");
    fs.rmSync(path.join(f.skills, "removed"), { recursive: true });
    for (const name of ["pristine", "edited", "unrecorded", "linked"]) f.ship(name, { "SKILL.md": `${name} v2`, "references/a.md": "a1" });
    f.unship("retiring");
    f.place("unrecorded", { "SKILL.md": "something else" });
    fs.symlinkSync("missing-user-source", path.join(f.skills, "linked"));

    const first = f.sync("2026.10.11");
    expect(first).toMatchObject({ added: [], updated: ["pristine"], retired: ["retiring"] });
    expect(first.kept).toEqual([
      { name: "edited", reason: "modified" },
      { name: "linked", reason: "symlink" },
      { name: "removed", reason: "deleted" },
      { name: "unrecorded", reason: "unmanaged" },
    ]);
    expect(first.notices).toEqual([
      { name: "edited", reason: "modified" },
      { name: "removed", reason: "deleted" },
      { name: "unrecorded", reason: "unmanaged" },
    ]);

    const before = snapshot(f.home);
    const spies = MUTATORS.map((name) => vi.spyOn(fs, name));
    const second = f.sync("2026.10.11");

    for (const spy of spies) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
    expect(snapshot(f.home)).toEqual(before);
    expect(second).toMatchObject({ added: [], updated: [], adopted: [], retired: [], notices: [], failed: [], backupDir: null });
    expect(second.kept).toEqual(first.kept);
    expect(second.inSync).toEqual(["pristine"]);
  });

  it("announces an untouched skill once per package version", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v2" });
    f.place("example", { "SKILL.md": "the user's own" });

    expect(f.sync("2026.10.10").notices).toEqual([{ name: "example", reason: "unmanaged" }]);
    expect(f.sync("2026.10.10").notices).toEqual([]);
    expect(f.sync("2026.10.10").kept).toEqual([{ name: "example", reason: "unmanaged" }]);
    expect(f.sync("2026.10.11").notices).toEqual([{ name: "example", reason: "unmanaged" }]);
    expect(f.sync("2026.10.11").notices).toEqual([]);
  });

  it("stops announcing a skill once the user brings it in line", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v2" });
    f.place("example", { "SKILL.md": "the user's own" });
    f.sync("2026.10.10");
    f.place("example", { "SKILL.md": "v2" });

    const result = f.sync("2026.10.10");

    expect(result).toMatchObject({ adopted: ["example"], kept: [], notices: [] });
    expect(f.receipt().notices).toEqual({});
  });

  it("re-renders an unmodified skill when the portal is renamed", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "Hello {{portalName}}" });
    f.sync("2026.10.10", "Momo");

    const result = f.sync("2026.10.10", "Kiki");

    expect(result.updated).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("Hello Kiki");
    expect(fs.readFileSync(path.join(result.backupDir!, "skills", "example", "SKILL.md"), "utf8")).toBe("Hello Momo");
  });

  it("gives each run its own backup directory", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    const first = f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v3" });
    const second = f.sync("2026.10.10");

    expect(first.backupDir).toBe(path.join(f.backups, `2026.10.10-${STAMP}`));
    expect(second.backupDir).not.toBe(first.backupDir);
    expect(path.dirname(second.backupDir!)).toBe(f.backups);
    expect(fs.readFileSync(path.join(first.backupDir!, "skills", "example", "SKILL.md"), "utf8")).toBe("v1");
    expect(fs.readFileSync(path.join(second.backupDir!, "skills", "example", "SKILL.md"), "utf8")).toBe("v2");
  });
});

describe("bundled skill sync: skills the operator deleted", () => {
  it("does not put back a skill it placed and the operator then deleted", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    f.ship("other", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const placed = f.receipt().skills.example;
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });

    const result = f.sync("2026.10.10");

    expect(result).toMatchObject({ added: [], updated: [], adopted: [], retired: [], failed: [], backupDir: null });
    expect(result.kept).toEqual([{ name: "example", reason: "deleted" }]);
    expect(result.notices).toEqual([{ name: "example", reason: "deleted" }]);
    expect(result.inSync).toEqual(["other"]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
    // The tombstone keeps what was placed, so tracking can resume if the directory returns.
    expect(f.receipt().skills.example).toEqual({ ...placed, deleted: true });
    expect(f.receipt().skills.other).not.toHaveProperty("deleted");
  });

  it("keeps the skill out on every later start, and mentions it once per package version", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });
    expect(f.sync("2026.10.10").notices).toEqual([{ name: "example", reason: "deleted" }]);
    const before = snapshot(f.home);

    const again = f.sync("2026.10.10");
    expect(again.notices).toEqual([]);
    expect(again.kept).toEqual([{ name: "example", reason: "deleted" }]);
    expect(snapshot(f.home)).toEqual(before);

    // A newer package, even one that changed the skill, still leaves it out.
    f.ship("example", { "SKILL.md": "v2" });
    const upgraded = f.sync("2026.10.11");
    expect(upgraded.added).toEqual([]);
    expect(upgraded.notices).toEqual([{ name: "example", reason: "deleted" }]);
    expect(f.sync("2026.10.11").notices).toEqual([]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
  });

  it("puts the skill back only when asked to restore deleted skills, and tracks it again", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });

    const result = f.restore("2026.10.11");

    expect(result).toMatchObject({ added: ["example"], kept: [], notices: [], inSync: ["example"] });
    expect(f.read("example", "SKILL.md")).toBe("v2");
    expect(f.receipt().skills.example).toMatchObject({ version: "2026.10.11", files: { "SKILL.md": sha("v2") } });
    expect(f.receipt().skills.example).not.toHaveProperty("deleted");
    expect(f.receipt().notices).toEqual({});
    // Back under the sync's care: the next start leaves it in place.
    expect(f.sync("2026.10.11")).toMatchObject({ added: [], kept: [], inSync: ["example"] });
  });

  it("leaves a deleted skill out unless a caller explicitly asks for it back", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });

    // No restoreDeleted at all: the safe reading is the default.
    const result = syncBundledSkills({ templateDir: f.template, home: f.home, packageVersion: "2026.10.10", now: NOW, replacements: {} });

    expect(result.added).toEqual([]);
    expect(result.kept).toEqual([{ name: "example", reason: "deleted" }]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
  });

  it("restores a deleted skill on request even if no earlier run has seen the deletion", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });

    expect(f.restore("2026.10.10").added).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("v1");
  });

  it("still installs a missing skill it has no record of placing", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    // A release adds a skill: missing, but never placed, so nobody deleted it.
    f.ship("brand-new", { "SKILL.md": "new" });

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ added: ["brand-new"], kept: [] });
    expect(f.read("brand-new", "SKILL.md")).toBe("new");
  });

  it("installs a missing skill at start after one it never recorded was moved aside", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v2" });
    f.place("example", { "SKILL.md": "an older copy" });
    expect(f.sync("2026.10.10").kept).toEqual([{ name: "example", reason: "unmanaged" }]);
    fs.renameSync(path.join(f.skills, "example"), path.join(f.root, "example-aside"));

    expect(f.sync("2026.10.10").added).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("v2");
  });

  it("drops the tombstone when the deleted skill is retired", () => {
    const f = fixture();
    f.ship("staying", { "SKILL.md": "stays" });
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });
    f.sync("2026.10.10");
    f.unship("example");

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ retired: [], kept: [], notices: [], backupDir: null });
    expect(Object.keys(f.receipt().skills)).toEqual(["staying"]);
    expect(f.receipt().notices).toEqual({});
  });

  it("resumes tracking when the deleted skill's directory comes back", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const aside = path.join(f.root, "example-aside");
    fs.renameSync(path.join(f.skills, "example"), aside);
    expect(f.sync("2026.10.10").kept).toEqual([{ name: "example", reason: "deleted" }]);
    fs.renameSync(aside, path.join(f.skills, "example"));

    const returned = f.sync("2026.10.10");
    expect(returned).toMatchObject({ added: [], updated: [], kept: [], notices: [], inSync: ["example"] });
    expect(f.receipt().skills.example).not.toHaveProperty("deleted");
    expect(f.receipt().notices).toEqual({});

    // The copy that came back is the one the sync placed, so it follows the next release.
    f.ship("example", { "SKILL.md": "v2" });
    expect(f.sync("2026.10.11").updated).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("v2");
  });

  it("clears the tombstone, without touching the skill, when the operator recreates it differently", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });
    f.sync("2026.10.10");
    f.place("example", { "SKILL.md": "rewritten by the operator" });

    const result = f.sync("2026.10.10");

    expect(result.kept).toEqual([{ name: "example", reason: "customized" }]);
    expect(f.read("example", "SKILL.md")).toBe("rewritten by the operator");
    expect(f.receipt().skills.example).not.toHaveProperty("deleted");
  });
});
