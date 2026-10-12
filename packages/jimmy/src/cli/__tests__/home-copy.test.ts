import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeTree } from "../home-copy.js";

const roots: string[] = [];

/** A package tree to copy, an instance home to copy it into, and a place outside both. */
function setup(files: Record<string, string> = { "MIGRATION.md": "# 1.0.0\n", "files/docs/new.md": "new doc\n" }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openryoko-home-copy-")));
  roots.push(root);
  const source = path.join(root, "package", "migrations", "1.0.0");
  const home = path.join(root, "home");
  const outside = path.join(root, "outside");
  for (const directory of [source, home, outside]) fs.mkdirSync(directory, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    fs.writeFileSync(path.join(source, relative), content);
  }
  const staged = path.join(home, "migrations", "1.0.0");
  return { root, source, home, outside, staged, place: () => placeTree(source, home, "migrations", "1.0.0") };
}

/** A file of the user's, outside the home, that nothing here may touch. */
function secretIn(outside: string): string {
  const secret = path.join(outside, "notes.md");
  fs.writeFileSync(secret, "the user's notes\n", { mode: 0o600 });
  return secret;
}

const listed = (directory: string): string[] => fs.readdirSync(directory, { recursive: true }).map(String).sort();

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("placeTree: package files copied into the home", () => {
  it("copies the tree, making the directories it needs", () => {
    const t = setup();

    t.place();

    expect(fs.readFileSync(path.join(t.staged, "MIGRATION.md"), "utf8")).toBe("# 1.0.0\n");
    expect(fs.readFileSync(path.join(t.staged, "files", "docs", "new.md"), "utf8")).toBe("new doc\n");
    expect(listed(path.join(t.home, "migrations"))).toEqual(["1.0.0", "1.0.0/MIGRATION.md", "1.0.0/files", "1.0.0/files/docs", "1.0.0/files/docs/new.md"]);
  });

  it("makes the directory a .gitkeep stands for, without the .gitkeep", () => {
    const t = setup({ "MIGRATION.md": "# 1.0.0\n", "files/memory/.gitkeep": "" });

    t.place();

    expect(fs.readdirSync(path.join(t.staged, "files", "memory"))).toEqual([]);
  });

  it("replaces what it placed before, and keeps a file's mode", () => {
    const t = setup({ "MIGRATION.md": "# first\n", "files/scripts/run.sh": "#!/bin/sh\n" });
    fs.chmodSync(path.join(t.source, "files", "scripts", "run.sh"), 0o755);
    t.place();
    fs.writeFileSync(path.join(t.source, "MIGRATION.md"), "# second\n");

    t.place();

    expect(fs.readFileSync(path.join(t.staged, "MIGRATION.md"), "utf8")).toBe("# second\n");
    expect(fs.statSync(path.join(t.staged, "files", "scripts", "run.sh")).mode & 0o777).toBe(0o755);
    // Nothing but the tree: no temporary file is left beside it.
    expect(listed(t.staged)).toEqual(["MIGRATION.md", "files", "files/scripts", "files/scripts/run.sh"]);
  });

  it("follows a link to the base itself: where the home is, is the user's arrangement", () => {
    const t = setup();
    const alias = path.join(t.root, "home-alias");
    fs.symlinkSync(t.home, alias);

    placeTree(t.source, alias, "migrations", "1.0.0");

    expect(fs.readFileSync(path.join(t.staged, "MIGRATION.md"), "utf8")).toBe("# 1.0.0\n");
  });
});

describe("placeTree: nothing is written through what was planted in the home", () => {
  it("does not overwrite a file outside the home through a link left where MIGRATION.md goes", () => {
    const t = setup();
    const secret = secretIn(t.outside);
    fs.mkdirSync(t.staged, { recursive: true });
    fs.symlinkSync(secret, path.join(t.staged, "MIGRATION.md"));

    t.place();

    expect(fs.readFileSync(secret, "utf8")).toBe("the user's notes\n");
    // The link is what gets replaced. What it pointed at is not touched.
    expect(fs.lstatSync(path.join(t.staged, "MIGRATION.md")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(t.staged, "MIGRATION.md"), "utf8")).toBe("# 1.0.0\n");
  });

  it("does not create a file outside the home through a link that leads nowhere", () => {
    const t = setup();
    const absent = path.join(t.outside, "created-by-the-copy.md");
    fs.mkdirSync(t.staged, { recursive: true });
    fs.symlinkSync(absent, path.join(t.staged, "MIGRATION.md"));

    t.place();

    expect(fs.existsSync(absent)).toBe(false);
    expect(fs.lstatSync(path.join(t.staged, "MIGRATION.md")).isFile()).toBe(true);
  });

  it.each([
    ["migrations"],
    ["migrations/1.0.0"],
    ["migrations/1.0.0/files"],
    ["migrations/1.0.0/files/docs"],
  ])("refuses a link where the directory %s belongs, and writes nothing through it", (relative) => {
    const t = setup();
    const planted = path.join(t.home, ...relative.split("/"));
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.symlinkSync(t.outside, planted);

    expect(() => t.place()).toThrow(/not a plain directory/);

    expect(fs.readdirSync(t.outside)).toEqual([]);
  });

  it("refuses a link that leads nowhere where a directory belongs, rather than making its target", () => {
    const t = setup();
    const absent = path.join(t.outside, "made-by-the-copy");
    fs.symlinkSync(absent, path.join(t.home, "migrations"));

    expect(() => t.place()).toThrow(/not a plain directory/);

    expect(fs.existsSync(absent)).toBe(false);
  });

  it("refuses a file where a directory belongs, and a directory where a file belongs", () => {
    const blocked = setup();
    fs.writeFileSync(path.join(blocked.home, "migrations"), "not a directory");
    expect(() => blocked.place()).toThrow(/not a plain directory/);
    expect(fs.readFileSync(path.join(blocked.home, "migrations"), "utf8")).toBe("not a directory");

    const taken = setup();
    fs.mkdirSync(path.join(taken.staged, "MIGRATION.md"), { recursive: true });
    fs.writeFileSync(path.join(taken.staged, "MIGRATION.md", "mine.md"), "kept");
    expect(() => taken.place()).toThrow();
    expect(fs.readFileSync(path.join(taken.staged, "MIGRATION.md", "mine.md"), "utf8")).toBe("kept");
    // And the copy that could not be put there is not left lying beside it.
    expect(fs.readdirSync(taken.staged)).toEqual(["MIGRATION.md"]);
  });

  it("does not move a file in through a directory that became a link after it was checked", () => {
    const t = setup({ "MIGRATION.md": "# 1.0.0\n" });
    const secret = path.join(t.outside, "MIGRATION.md");
    fs.writeFileSync(secret, "the user's own file of that name\n");
    const copy = fs.copyFileSync;
    let swapped = false;
    // The copy is written beside its destination first. Then the directory is swapped.
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, ...rest) => {
      (copy as (...args: unknown[]) => void)(from, to, ...rest);
      if (!swapped) {
        swapped = true;
        fs.renameSync(t.staged, path.join(t.root, "real-staged"));
        fs.symlinkSync(t.outside, t.staged);
      }
    });

    expect(() => t.place()).toThrow(/not a plain directory/);

    expect(swapped).toBe(true);
    expect(fs.readFileSync(secret, "utf8")).toBe("the user's own file of that name\n");
    expect(fs.readdirSync(t.outside)).toEqual(["MIGRATION.md"]);
  });

  it("does not move a file in when a directory further up became a link to a tree of the same shape", () => {
    const t = setup({ "MIGRATION.md": "# 1.0.0\n" });
    // Somewhere else that also has a 1.0.0/ with a file of that name in it.
    const secret = path.join(t.outside, "1.0.0", "MIGRATION.md");
    fs.mkdirSync(path.dirname(secret));
    fs.writeFileSync(secret, "the user's own file of that name\n");
    const copy = fs.copyFileSync;
    let swapped = false;
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, ...rest) => {
      (copy as (...args: unknown[]) => void)(from, to, ...rest);
      if (!swapped) {
        swapped = true;
        // migrations/1.0.0 still looks like a directory afterwards: it is the other one.
        fs.renameSync(path.join(t.home, "migrations"), path.join(t.root, "real-migrations"));
        fs.symlinkSync(t.outside, path.join(t.home, "migrations"));
      }
    });

    expect(() => t.place()).toThrow(/not a plain directory/);

    expect(swapped).toBe(true);
    expect(fs.readFileSync(secret, "utf8")).toBe("the user's own file of that name\n");
    expect(fs.readdirSync(path.dirname(secret))).toEqual(["MIGRATION.md"]);
  });

  it("does not write through a link left at the very name its temporary file takes", () => {
    const t = setup({ "MIGRATION.md": "# 1.0.0\n" });
    const secret = secretIn(t.outside);
    vi.spyOn(crypto, "randomBytes").mockImplementation((() => Buffer.alloc(8, 0xab)) as unknown as typeof crypto.randomBytes);
    fs.mkdirSync(t.staged, { recursive: true });
    fs.symlinkSync(secret, path.join(t.staged, `MIGRATION.md.${"ab".repeat(8)}.tmp`));

    expect(() => t.place()).toThrow(/EEXIST/);

    expect(fs.readFileSync(secret, "utf8")).toBe("the user's notes\n");
  });

  it("gives each file a temporary name of its own", () => {
    const t = setup({ "MIGRATION.md": "# 1.0.0\n", "notes.md": "n\n" });
    const rename = vi.spyOn(fs, "renameSync");

    t.place();

    const temporaries = rename.mock.calls.map(([from]) => path.basename(String(from)));
    expect(temporaries).toHaveLength(2);
    expect(new Set(temporaries.map((name) => name.replace(/^(MIGRATION|notes)\.md\./, ""))).size).toBe(2);
    for (const name of temporaries) expect(name).toMatch(/\.[0-9a-f]{16}\.tmp$/);
  });
});
