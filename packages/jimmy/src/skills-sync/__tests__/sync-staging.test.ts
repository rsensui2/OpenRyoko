import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fixture, removeFixtures, snapshot, STAMP, writeTree } from "./fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeFixtures();
});

// A skill is built in <home>/.bundled-skill-XXXXXX and then moved into skills/. The
// staging directory sits in the home like everything else, so whoever can write there
// can reach into it while the sync runs. Each test does exactly that, at one instant.

const stagingOf = (home: string) => fs.readdirSync(home).filter((name) => name.startsWith(".bundled-skill-")).map((name) => path.join(home, name));
const isStaged = (dir: fs.PathLike, skill: string) => String(dir).includes(".bundled-skill-") && path.basename(String(dir)) === skill;

/** Run `tamper` once, right after the sync has created the directory `matches` picks. */
function afterCreating(matches: (dir: string) => boolean, tamper: (dir: string) => void): () => boolean {
  const mkdir = fs.mkdirSync;
  let done = false;
  vi.spyOn(fs, "mkdirSync").mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
    const made = (mkdir as (...args: unknown[]) => string | undefined)(dir, ...rest);
    if (!done && matches(String(dir))) {
      done = true;
      tamper(String(dir));
    }
    return made;
  }) as typeof fs.mkdirSync);
  return () => done;
}

/** Run `tamper` once, right before the sync makes the call `matches` picks. */
function beforeRenaming(matches: (from: string, to: string) => boolean, tamper: () => void): () => boolean {
  const rename = fs.renameSync;
  let done = false;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (!done && matches(String(from), String(to))) {
      done = true;
      tamper();
    }
    return rename(from, to);
  });
  return () => done;
}

describe("bundled skill sync: nothing is written through what was planted in the staging directory", () => {
  it.each(["a file that exists", "a file that does not exist yet"])("does not write a staged file through a link to %s", (target) => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    const outside = path.join(f.root, "outside.md");
    if (target === "a file that exists") fs.writeFileSync(outside, "the user's file");
    const planted = afterCreating((dir) => isStaged(dir, "example"), (dir) => fs.symlinkSync(outside, path.join(dir, "SKILL.md")));

    const result = f.sync();

    expect(planted()).toBe(true);
    if (target === "a file that exists") expect(fs.readFileSync(outside, "utf8")).toBe("the user's file");
    else expect(fs.existsSync(outside)).toBe(false);
    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("EEXIST") }]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
    expect(stagingOf(f.home)).toEqual([]);
  });

  it("does not create a staged file inside a directory linked in where its own should be", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    const planted = afterCreating((dir) => isStaged(dir, "example"), (dir) => fs.symlinkSync(outside, path.join(dir, "references")));

    const result = f.sync();

    expect(planted()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("EEXIST") }]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
  });

  it("still stages a skill with directories several levels deep", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/deep/er/a.md": "a1", "references/b.md": "b1" });

    expect(f.sync().added).toEqual(["example"]);

    expect(f.read("example", "references", "deep", "er", "a.md")).toBe("a1");
    expect(f.read("example", "references", "b.md")).toBe("b1");
  });
});

describe("bundled skill sync: what is moved into skills/ is what was staged, from where it was staged", () => {
  /** Another directory of the user's that happens to hold a skill of the same name. */
  function elsewhereWith(root: string, content: string): string {
    const elsewhere = path.join(root, "elsewhere");
    writeTree(path.join(elsewhere, "example"), { "SKILL.md": content });
    return elsewhere;
  }

  /** Move the staging directory out of the home and leave a link to `target` in its place. */
  function swapStaging(home: string, root: string, target: string): void {
    const [staging] = stagingOf(home);
    fs.renameSync(staging, path.join(root, "real-staging"));
    fs.symlinkSync(target, staging);
  }

  it("does not move a directory from outside the home in when the staging directory becomes a link", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    const elsewhere = elsewhereWith(f.root, "the user's own");
    // skills/ is created after the skill is staged: the last step before the move.
    const swapped = afterCreating((dir) => dir === f.skills, () => swapStaging(f.home, f.root, elsewhere));

    const result = f.sync();

    expect(swapped()).toBe(true);
    expect(fs.readFileSync(path.join(elsewhere, "example", "SKILL.md"), "utf8")).toBe("the user's own");
    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("staged copy") }]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
    expect(f.receipt().skills).toEqual({});
  });

  it("does not move one in even when it is, byte for byte, the skill being installed", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    // Only where it comes from is wrong: the user's other skill store would lose its copy.
    const elsewhere = elsewhereWith(f.root, "v1");
    const swapped = afterCreating((dir) => dir === f.skills, () => swapStaging(f.home, f.root, elsewhere));

    const result = f.sync();

    expect(swapped()).toBe(true);
    expect(fs.readFileSync(path.join(elsewhere, "example", "SKILL.md"), "utf8")).toBe("v1");
    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("staged copy") }]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
  });

  it("does not install a link when the staged skill itself is replaced by one", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    const elsewhere = elsewhereWith(f.root, "v1");
    const swapped = afterCreating((dir) => dir === f.skills, () => {
      const staged = path.join(stagingOf(f.home)[0], "example");
      fs.rmSync(staged, { recursive: true });
      fs.symlinkSync(path.join(elsewhere, "example"), staged);
    });

    const result = f.sync();

    expect(swapped()).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("staged copy") }]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
    expect(fs.readFileSync(path.join(elsewhere, "example", "SKILL.md"), "utf8")).toBe("v1");
  });

  it.each<[string, (staged: string) => void]>([
    ["a file rewritten", (staged) => fs.writeFileSync(path.join(staged, "SKILL.md"), "not what ships")],
    ["a file added", (staged) => fs.writeFileSync(path.join(staged, "extra.md"), "not what ships")],
    ["a file removed", (staged) => fs.rmSync(path.join(staged, "references", "a.md"))],
    ["a link added", (staged) => fs.symlinkSync("/etc/hosts", path.join(staged, "hosts"))],
  ])("does not install a staged copy with %s since it was written", (_label, tamper) => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    const tampered = afterCreating((dir) => dir === f.skills, () => tamper(path.join(stagingOf(f.home)[0], "example")));

    const result = f.sync();

    expect(tampered()).toBe(true);
    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("staged copy") }]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
    // Recorded as installed, the altered copy would count as the shipped one from then on.
    expect(f.receipt().skills).toEqual({});
  });

  it("puts the previous copy back when the staging directory is swapped after that copy was moved away", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    const elsewhere = elsewhereWith(f.root, "the user's own");
    const before = snapshot(path.join(f.skills, "example"));
    const rename = fs.renameSync;
    let swapped = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      // The previous copy has just gone to the backup; the new one is about to come in.
      if (!swapped && String(to).startsWith(f.backups)) {
        swapped = true;
        swapStaging(f.home, f.root, elsewhere);
      }
    });

    const result = f.sync("2026.10.11");

    expect(swapped).toBe(true);
    expect(fs.readFileSync(path.join(elsewhere, "example", "SKILL.md"), "utf8")).toBe("the user's own");
    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("staged copy") }]);
    expect(snapshot(path.join(f.skills, "example"))).toEqual(before);
    expect(result.backupDir).toBeNull();
    expect(fs.existsSync(f.backups)).toBe(false);
  });

  it("does not move the previous copy away at all when the staged one is already wrong", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...rest) => {
      (write as (...args: unknown[]) => void)(file, ...rest);
      if (String(file).includes(".bundled-skill-")) (write as (...args: unknown[]) => void)(file, "not what ships");
    });
    const renames = vi.spyOn(fs, "renameSync");

    const result = f.sync("2026.10.11");

    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("staged copy") }]);
    expect(f.read("example", "SKILL.md")).toBe("v1");
    // Not moved out and back: it never left.
    expect(renames.mock.calls.filter(([from]) => String(from) === path.join(f.skills, "example"))).toEqual([]);
    expect(fs.existsSync(path.join(f.backups, `2026.10.11-${STAMP}`, "skills"))).toBe(false);
  });
});

describe("bundled skill sync: the staging directory is looked at again each time it is about to be used", () => {
  it("writes nothing through a staging directory that became a link before the skill was staged", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    const elsewhere = path.join(f.root, "elsewhere");
    fs.mkdirSync(elsewhere);
    const mkdtemp = fs.mkdtempSync;
    let staging = "";
    // Made when the run begins, and swapped before anything is staged in it: with
    // several skills to do, that is a long time.
    vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
      staging = mkdtemp(prefix);
      fs.rmdirSync(staging);
      fs.symlinkSync(elsewhere, staging);
      return staging;
    }) as typeof fs.mkdtempSync);
    const made = vi.spyOn(fs, "mkdirSync");

    const result = f.sync();

    // The skill would be written out as a new directory wherever the link leads, and stay there.
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(made.mock.calls.map((call) => String(call[0])).filter((dir) => dir.startsWith(staging + path.sep))).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("is not a plain directory") }]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
  });

  it("writes nothing through one that becomes a link in the instant the skill's directory is made", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    const elsewhere = path.join(f.root, "elsewhere");
    fs.mkdirSync(elsewhere);
    const mkdir = fs.mkdirSync;
    let swapped = false;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((dir: fs.PathLike, ...rest: unknown[]) => {
      if (!swapped && isStaged(dir, "example")) {
        swapped = true;
        const staging = path.dirname(String(dir));
        fs.rmdirSync(staging);
        fs.symlinkSync(elsewhere, staging);
      }
      return (mkdir as (...args: unknown[]) => string | undefined)(dir, ...rest);
    }) as typeof fs.mkdirSync);

    const result = f.sync();

    expect(swapped).toBe(true);
    // The directory landed behind the link. Found out at once, nothing is written into
    // it, and it is taken away again while it is still empty.
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("is not a plain directory") }]);
  });

  it.each<[string, (home: string, root: string, elsewhere: string) => void]>([
    ["the staging directory", (home, root, elsewhere) => {
      const [staging] = stagingOf(home);
      fs.renameSync(staging, path.join(root, "real-staging"));
      fs.symlinkSync(elsewhere, staging);
    }],
    ["the staged copy", (home, root, elsewhere) => {
      const staged = path.join(stagingOf(home)[0], "example");
      fs.renameSync(staged, path.join(root, "real-staged"));
      fs.symlinkSync(path.join(elsewhere, "example"), staged);
    }],
  ])("does not move a skill in when %s becomes a link after its content was checked", (_label, swap) => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    const elsewhere = path.join(f.root, "elsewhere");
    writeTree(path.join(elsewhere, "example"), { "SKILL.md": "the user's own" });
    const realpath = fs.realpathSync;
    let swapped = false;
    // skills/ is resolved once the staged copy has been read and found right. That
    // takes a moment, and the move must not go by what was true before it.
    vi.spyOn(fs, "realpathSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (!swapped && String(target) === f.skills) {
        swapped = true;
        swap(f.home, f.root, elsewhere);
      }
      return (realpath as (...args: unknown[]) => string)(target, ...rest);
    }) as typeof fs.realpathSync);

    const result = f.sync();

    expect(swapped).toBe(true);
    // Moved in and reported as installed, it would be a directory from outside the home, or a link to one.
    expect(fs.readFileSync(path.join(elsewhere, "example", "SKILL.md"), "utf8")).toBe("the user's own");
    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("is not a plain directory") }]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
    expect(f.receipt().skills).toEqual({});
  });
});

describe("bundled skill sync: skills/ is the last thing checked before a skill leaves it", () => {
  it("does not move a skill in through skills/ when it is swapped while the staged copy is being checked", () => {
    const f = fixture();
    f.ship("other", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v1" });
    const elsewhere = path.join(f.root, "elsewhere");
    fs.mkdirSync(elsewhere);
    const realpath = fs.realpathSync;
    let swapped = false;
    vi.spyOn(fs, "realpathSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (!swapped && isStaged(target, "example")) {
        swapped = true;
        fs.renameSync(f.skills, path.join(f.root, "real-skills"));
        fs.symlinkSync(elsewhere, f.skills);
      }
      return (realpath as (...args: unknown[]) => string)(target, ...rest);
    }) as typeof fs.realpathSync);

    const result = f.sync("2026.10.10");

    expect(swapped).toBe(true);
    // The new skill did not land in whatever skills/ now points at.
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("is not a plain directory") }]);
  });

  it("does not move a skill out through skills/ when it is swapped while the backup directory is being checked", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    const elsewhere = path.join(f.root, "elsewhere");
    writeTree(path.join(elsewhere, "example"), { "SKILL.md": "v1" });
    const backupSkills = path.join(f.backups, `2026.10.11-${STAMP}`, "skills");
    const realpath = fs.realpathSync;
    let swapped = false;
    // The two ends of the move are checked one after the other. Whatever is checked
    // first can be swapped while the second is looked at; that must not be skills/,
    // through which the user's own directories can be reached.
    vi.spyOn(fs, "realpathSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (!swapped && String(target) === backupSkills) {
        swapped = true;
        fs.renameSync(f.skills, path.join(f.root, "real-skills"));
        fs.symlinkSync(elsewhere, f.skills);
      }
      return (realpath as (...args: unknown[]) => string)(target, ...rest);
    }) as typeof fs.realpathSync);

    const result = f.sync("2026.10.11");

    expect(swapped).toBe(true);
    expect(fs.readFileSync(path.join(elsewhere, "example", "SKILL.md"), "utf8")).toBe("v1");
    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("is not a plain directory") }]);
    expect(fs.readFileSync(path.join(f.root, "real-skills", "example", "SKILL.md"), "utf8")).toBe("v1");
  });
});

/** As the sync makes its staging directory, the user creates this skill themselves. */
function createdByTheUserMidSync(skill: string): void {
  const mkdtemp = fs.mkdtempSync;
  vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "created by the user just now");
    return mkdtemp(prefix);
  }) as typeof fs.mkdtempSync);
}

describe("bundled skill sync: a staged copy that could not be installed is kept, not deleted", () => {
  const RUN = `2026.10.10-${STAMP}`;

  /** An install that fails once its copy is staged: at that moment the user creates the skill themselves. */
  function failingInstall() {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    createdByTheUserMidSync(path.join(f.skills, "example"));
    return f;
  }

  it("moves the staging directory, with the copy in it, to the backup directory", () => {
    const f = failingInstall();
    const removals = vi.spyOn(fs, "rmSync");

    const result = f.sync();

    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("appeared at its path") }]);
    expect(stagingOf(f.home)).toEqual([]);
    expect(result.stagingSetAside).toHaveLength(1);
    const kept = path.join(f.backups, RUN, "staging", result.stagingSetAside![0], "example");
    expect(fs.readFileSync(path.join(kept, "SKILL.md"), "utf8")).toBe("v1");
    expect(fs.readFileSync(path.join(kept, "references", "a.md"), "utf8")).toBe("a1");
    expect(result.backupDir).toBe(path.join(f.backups, RUN));
    expect(removals.mock.calls.filter(([, options]) => options?.recursive)).toEqual([]);
    expect(f.read("example", "SKILL.md")).toBe("created by the user just now");
  });

  it("removes its staging directory, and makes no backup directory, when every copy was moved into place", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    const removals = vi.spyOn(fs, "rmSync");

    const result = f.sync();

    expect(result).toMatchObject({ added: ["example"], failed: [], backupDir: null });
    expect(result.stagingSetAside).toBeUndefined();
    expect(fs.readdirSync(f.home)).toEqual(["skills"]);
    expect(removals).not.toHaveBeenCalled();
  });

  it("leaves a staging path that has been turned into a link as it is, with what it points at", () => {
    const f = failingInstall();
    const elsewhere = path.join(f.root, "elsewhere");
    writeTree(path.join(elsewhere, "example"), { "SKILL.md": "the user's own" });
    const kept = snapshot(elsewhere);
    const swapped = afterCreating((dir) => dir === f.skills, () => {
      const [staging] = stagingOf(f.home);
      fs.renameSync(staging, path.join(f.root, "real-staging"));
      fs.symlinkSync(elsewhere, staging);
    });

    const result = f.sync();

    expect(swapped()).toBe(true);
    expect(result.failed).toHaveLength(1);
    // Not removed through, not moved, not followed.
    expect(snapshot(elsewhere)).toEqual(kept);
    expect(stagingOf(f.home).map((link) => fs.readlinkSync(link))).toEqual([elsewhere]);
    expect(result.stagingSetAside).toBeUndefined();
    expect(fs.existsSync(f.backups)).toBe(false);
  });

  it("leaves the staging directory in the home when it cannot be moved either, and no empty backup directory", () => {
    const f = failingInstall();
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (path.basename(String(from)).startsWith(".bundled-skill-")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return rename(from, to);
    });

    const result = f.sync();

    expect(result.failed).toHaveLength(1);
    expect(result.stagingSetAside).toBeUndefined();
    expect(result.backupDir).toBeNull();
    const [staging] = stagingOf(f.home);
    expect(fs.readFileSync(path.join(staging, "example", "SKILL.md"), "utf8")).toBe("v1");
    expect(fs.existsSync(f.backups)).toBe(false);
  });

  const cannotBeDenied = process.platform === "win32" || process.getuid?.() === 0;

  it.skipIf(cannotBeDenied)("stages nothing for a skill when skills/ cannot be written to", () => {
    const f = fixture();
    f.ship("other", { "SKILL.md": "v1" });
    f.sync();
    f.ship("example", { "SKILL.md": "v1" });
    fs.chmodSync(f.skills, 0o555);
    let result;
    try { result = f.sync(); }
    finally { fs.chmodSync(f.skills, 0o755); }

    // Staged and then not movable, its copy would be kept: one more at every start.
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("not writable") }]);
    expect(result.stagingSetAside).toBeUndefined();
    expect(stagingOf(f.home)).toEqual([]);
    expect(fs.existsSync(f.backups)).toBe(false);
  });

  it.skipIf(cannotBeDenied)("stages nothing for a skill whose own directory cannot be moved away", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync();
    f.ship("example", { "SKILL.md": "v2" });
    fs.chmodSync(path.join(f.skills, "example"), 0o555);
    let result;
    try { result = f.sync("2026.10.11"); }
    finally { fs.chmodSync(path.join(f.skills, "example"), 0o755); }

    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("not writable") }]);
    expect(result.stagingSetAside).toBeUndefined();
    expect(stagingOf(f.home)).toEqual([]);
    expect(fs.existsSync(f.backups)).toBe(false);
    expect(f.read("example", "SKILL.md")).toBe("v1");
  });
});

describe("bundled skill sync: it never deletes a directory tree in the home", () => {
  it("moves what is in its way, and removes only directories that are empty", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.ship("old", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    f.unship("old");
    f.ship("blocked", { "SKILL.md": "v1" });
    // Left by a sync that died long ago.
    const stale = path.join(f.home, ".bundled-skill-Ab3xYz");
    writeTree(stale, { "example/SKILL.md": "half" });
    fs.utimesSync(stale, new Date(0), new Date(0));
    createdByTheUserMidSync(path.join(f.skills, "blocked"));
    const rm = vi.spyOn(fs, "rmSync");
    const rmdir = vi.spyOn(fs, "rmdirSync");
    const unlink = vi.spyOn(fs, "unlinkSync");

    const result = f.sync("2026.10.11");

    // One run that updated, retired, failed to install, and found an old staging directory.
    expect(result).toMatchObject({ updated: ["example"], retired: ["old"], failed: [{ name: "blocked" }] });
    expect(result.stagingSetAside).toHaveLength(2);
    expect(rm).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir.mock.calls.filter(([, options]) => options !== undefined)).toEqual([]);
    // Everything that was in the way is under the backup directory, not gone.
    const run = path.join(f.backups, `2026.10.11-${STAMP}`);
    expect(fs.readdirSync(run).sort()).toEqual(["skills", "staging"]);
    expect(fs.readdirSync(path.join(run, "skills")).sort()).toEqual(["example", "old"]);
    expect(fs.readdirSync(path.join(run, "staging")).sort()).toEqual(result.stagingSetAside);
  });
});
