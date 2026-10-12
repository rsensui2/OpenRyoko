import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { POSIX_MODES_SUPPORTED } from "../../shared/test-support/posix-mode.js";
import { RECEIPT_FILE } from "../receipt.js";
import { syncBundledSkills } from "../sync.js";
import { fixture, NOW, removeFixtures, sha, snapshot, STAMP, writeTree } from "./fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
  removeFixtures();
});

describe("bundled skill sync: staying inside skills/", () => {
  it.each([
    ["a parent directory", "../knowledge"],
    ["a nested path", "mine/inner"],
    ["a hidden directory", ".disabled"],
    ["the skills directory itself", "."],
    ["a Windows-style parent", "..\\knowledge"],
    ["an empty name", ""],
  ])("refuses a receipt that names %s, before writing anything", (_label, name) => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    // Directories the user owns, each holding a file the forged entry describes exactly:
    // a sync that trusted the name would take them for unmodified retired skills and
    // move them away. The name is the only thing wrong with the entry.
    const owned = { "SKILL.md": "the user's own" };
    writeTree(path.join(f.home, "knowledge"), owned);
    writeTree(path.join(f.skills, "mine", "inner"), owned);
    writeTree(path.join(f.skills, ".disabled"), owned);
    const receipt = f.receipt();
    receipt.skills[name] = { version: "2026.10.10", sha256: sha(""), files: { "SKILL.md": sha(owned["SKILL.md"]) } };
    fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), JSON.stringify(receipt));
    // Work a sync would otherwise do, so "nothing changed" is not vacuous.
    f.ship("example", { "SKILL.md": "v2" });
    f.ship("brand-new", { "SKILL.md": "new" });
    const before = snapshot(f.root);

    expect(() => f.sync("2026.10.11")).toThrow(RECEIPT_FILE);
    expect(snapshot(f.root)).toEqual(before);
  });

  it("refuses a receipt that names an absolute path", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const outside = path.join(f.root, "outside");
    writeTree(outside, { "SKILL.md": "the user's own" });
    const receipt = f.receipt();
    receipt.skills[outside] = { version: "2026.10.10", sha256: sha(""), files: { "SKILL.md": sha("the user's own") } };
    fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), JSON.stringify(receipt));
    f.ship("example", { "SKILL.md": "v2" });
    const before = snapshot(f.root);

    expect(() => f.sync("2026.10.11")).toThrow(RECEIPT_FILE);
    expect(snapshot(f.root)).toEqual(before);
  });

  it.each(["../../config.yaml", "/etc/hosts", "references/../../x.md", "references\\x.md", ""])(
    "refuses a receipt whose file list holds %j",
    (relative) => {
      const f = fixture();
      f.ship("example", { "SKILL.md": "v1" });
      f.sync("2026.10.10");
      const receipt = f.receipt();
      receipt.skills.example.files[relative] = sha("x");
      fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), JSON.stringify(receipt));
      f.ship("example", { "SKILL.md": "v2" });
      const before = snapshot(f.root);

      expect(() => f.sync("2026.10.11")).toThrow(RECEIPT_FILE);
      expect(snapshot(f.root)).toEqual(before);
    },
  );

  it("refuses a receipt entry that does not describe a skill", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    // An empty directory matches an entry with no files; without this check it would be "retired".
    fs.mkdirSync(path.join(f.skills, "scratch"));
    const receipt = f.receipt();
    receipt.skills.scratch = { version: "2026.10.10", sha256: sha(""), files: {} };
    fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), JSON.stringify(receipt));
    const before = snapshot(f.root);

    expect(() => f.sync("2026.10.11")).toThrow(RECEIPT_FILE);
    expect(snapshot(f.root)).toEqual(before);
  });

  it.each(["yes", false, 1, null])("refuses a receipt whose deleted mark is %j rather than true", (mark) => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const receipt = f.receipt();
    receipt.skills.example.deleted = mark;
    fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), JSON.stringify(receipt));
    fs.rmSync(path.join(f.skills, "example"), { recursive: true });
    const before = snapshot(f.root);

    expect(() => f.migrate("2026.10.10")).toThrow(RECEIPT_FILE);
    expect(snapshot(f.root)).toEqual(before);
  });

  it("refuses a receipt it cannot read instead of starting over", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    fs.mkdirSync(f.skills);
    fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), "{ not json");
    const before = snapshot(f.root);

    expect(() => f.sync()).toThrow(RECEIPT_FILE);
    expect(snapshot(f.root)).toEqual(before);
  });

  it("refuses a receipt written in a format it does not know", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    fs.mkdirSync(f.skills);
    fs.writeFileSync(path.join(f.skills, RECEIPT_FILE), JSON.stringify({ schemaVersion: 2, packageVersion: "2026.10.10", skills: {}, notices: {} }));
    const before = snapshot(f.root);

    expect(() => f.sync()).toThrow(RECEIPT_FILE);
    expect(snapshot(f.root)).toEqual(before);
  });

  it("does not write through a symlinked skills directory", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    const shared = path.join(f.root, "shared-skills");
    writeTree(path.join(shared, "mine"), { "SKILL.md": "the user's skill store" });
    fs.symlinkSync(shared, f.skills);
    const before = snapshot(f.root);

    const result = f.sync();

    expect(result).toMatchObject({ skipped: "skills-root-symlink", added: [], adopted: [], kept: [], notices: [] });
    expect(snapshot(f.root)).toEqual(before);
  });

  it("never writes the receipt through a link left where its temporary file goes", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    fs.mkdirSync(f.skills);
    const outside = path.join(f.root, "outside.json");
    fs.writeFileSync(outside, "the user's file");
    // The gateway is often the same PID on every container start, so this name is predictable.
    fs.symlinkSync(outside, path.join(f.skills, `${RECEIPT_FILE}.tmp-${process.pid}`));

    const result = f.sync();

    expect(result.added).toEqual(["example"]);
    expect(fs.readFileSync(outside, "utf8")).toBe("the user's file");
    expect(Object.keys(f.receipt().skills)).toEqual(["example"]);
    expect(fs.lstatSync(path.join(f.skills, RECEIPT_FILE)).isFile()).toBe(true);
    expect(fs.readdirSync(f.skills).sort()).toEqual([RECEIPT_FILE, "example"]);
  });

  it("refuses a receipt that is itself a link", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const elsewhere = path.join(f.root, "receipt-elsewhere.json");
    fs.renameSync(path.join(f.skills, RECEIPT_FILE), elsewhere);
    fs.symlinkSync(elsewhere, path.join(f.skills, RECEIPT_FILE));
    f.ship("example", { "SKILL.md": "v2" });
    const before = snapshot(f.root);

    expect(() => f.sync("2026.10.11")).toThrow(RECEIPT_FILE);
    expect(snapshot(f.root)).toEqual(before);
  });

  it("refuses to treat something that is not a directory as the skills directory", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    fs.writeFileSync(f.skills, "not a directory");
    const before = snapshot(f.root);

    // Named for what it is, not reported as a problem with a receipt that cannot exist.
    expect(() => f.sync()).toThrow(`${f.skills} is not a directory, so shipped skills cannot be synced into it`);
    expect(snapshot(f.root)).toEqual(before);
  });

  it("works when the home itself is reached through a symlink", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    const alias = path.join(f.root, "home-alias");
    fs.symlinkSync(f.home, alias);

    const result = syncBundledSkills({ templateDir: f.template, home: alias, packageVersion: "2026.10.10", now: NOW, replacements: {} });

    expect(result.added).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("v1");
  });

  it("refuses a package whose skill carries a symlink, before writing anything", () => {
    const f = fixture();
    // "alpha" sorts first: a sync that wrote as it went would have installed it already.
    f.ship("alpha", { "SKILL.md": "v1" });
    f.ship("broken", { "SKILL.md": "v1" });
    // The link resolves, so a sync that read through it would install a file from outside the package.
    fs.writeFileSync(path.join(f.root, "not-in-the-package.md"), "from outside the package");
    fs.symlinkSync(path.join(f.root, "not-in-the-package.md"), path.join(f.template, "skills", "broken", "extra.md"));
    const before = snapshot(f.root);

    expect(() => f.sync()).toThrow(/"broken" carries extra\.md/);
    expect(snapshot(f.root)).toEqual(before);
  });

  it("refuses to back up into a backup directory that is a symlink", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const elsewhere = path.join(f.root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, f.backups);
    f.ship("example", { "SKILL.md": "v2" });
    const before = snapshot(f.root);

    expect(() => f.sync("2026.10.11")).toThrow(/\.migration-backups/);
    expect(snapshot(f.root)).toEqual(before);
  });
});

describe("bundled skill sync: failures and odd states", () => {
  it("leaves no partial skill and no staging directory when a skill cannot be staged", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "references/a.md": "a1" });
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...rest) => {
      if (String(file).endsWith(path.join("references", "a.md"))) throw new Error("disk full");
      return (write as (...args: unknown[]) => void)(file, ...rest);
    });

    const result = f.sync();

    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("disk full") }]);
    expect(fs.readdirSync(f.home)).toEqual([]);
  });

  it("still syncs the other skills when one of them fails", () => {
    const f = fixture();
    f.ship("broken", { "SKILL.md": "v1", "references/a.md": "a1" });
    f.ship("fine", { "SKILL.md": "v1" });
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...rest) => {
      if (String(file).endsWith(path.join("broken", "references", "a.md"))) throw new Error("disk full");
      return (write as (...args: unknown[]) => void)(file, ...rest);
    });

    const result = f.sync();

    expect(result.added).toEqual(["fine"]);
    expect(result.failed.map((failure) => failure.name)).toEqual(["broken"]);
    expect(fs.existsSync(path.join(f.skills, "broken"))).toBe(false);
    expect(Object.keys(f.receipt().skills)).toEqual(["fine"]);
    expect(fs.readdirSync(f.home).sort()).toEqual(["skills"]);
  });

  it("puts the previous copy back when the replacement cannot be moved into place", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    const recorded = f.receipt().skills.example;
    f.ship("example", { "SKILL.md": "v2" });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(".bundled-skill-")) throw new Error("rename refused");
      return rename(from, to);
    });

    const result = f.sync("2026.10.11");

    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("rename refused") }]);
    expect(f.read("example", "SKILL.md")).toBe("v1");
    expect(f.receipt().skills.example).toEqual(recorded);
    expect(fs.readdirSync(f.home).filter((name) => name.startsWith(".bundled-skill-"))).toEqual([]);
  });

  it("does not mistake a skill it lost in a failed update for one the operator deleted", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    const rename = fs.renameSync;
    // The previous copy moves to the backup, then neither the new copy nor the rollback can land.
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path.join(f.skills, "example")) throw new Error("rename refused");
      return rename(from, to);
    });

    const failed = f.sync("2026.10.11");

    expect(failed.updated).toEqual([]);
    expect(failed.failed).toEqual([{ name: "example", error: expect.stringContaining(path.join(f.backups, `2026.10.11-${STAMP}`, "skills", "example")) }]);
    expect(fs.existsSync(path.join(f.skills, "example"))).toBe(false);
    expect(fs.readFileSync(path.join(f.backups, `2026.10.11-${STAMP}`, "skills", "example", "SKILL.md"), "utf8")).toBe("v1");
    expect(f.receipt().skills).not.toHaveProperty("example");
    vi.restoreAllMocks();

    // The next start repairs it instead of recording a deletion nobody made.
    const repaired = f.sync("2026.10.11");
    expect(repaired).toMatchObject({ added: ["example"], kept: [] });
    expect(f.read("example", "SKILL.md")).toBe("v2");
  });

  it("does not replace a skill that is edited while the sync is running", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    const mkdtemp = fs.mkdtempSync;
    // The staging directory is created after planning and before the swap.
    vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
      fs.writeFileSync(path.join(f.skills, "example", "SKILL.md"), "edited mid-sync");
      return mkdtemp(prefix);
    }) as typeof fs.mkdtempSync);

    const result = f.sync("2026.10.11");

    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringMatching(/changed/) }]);
    expect(f.read("example", "SKILL.md")).toBe("edited mid-sync");
    expect(fs.existsSync(f.backups)).toBe(false);
  });

  it("does not follow skills/ if it is swapped for a symlink while the sync is running", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    fs.mkdirSync(f.skills);
    const elsewhere = path.join(f.root, "elsewhere");
    fs.mkdirSync(elsewhere);
    const mkdtemp = fs.mkdtempSync;
    vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
      fs.rmdirSync(f.skills);
      fs.symlinkSync(elsewhere, f.skills);
      return mkdtemp(prefix);
    }) as typeof fs.mkdtempSync);

    const result = f.sync();

    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("is not a plain directory") }]);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it("does not install over something that appears while the sync is running", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    const mkdtemp = fs.mkdtempSync;
    vi.spyOn(fs, "mkdtempSync").mockImplementation(((prefix: string) => {
      writeTree(path.join(f.skills, "example"), { "SKILL.md": "created by the user just now" });
      return mkdtemp(prefix);
    }) as typeof fs.mkdtempSync);

    const result = f.sync();

    expect(result.added).toEqual([]);
    expect(result.failed).toEqual([{ name: "example", error: expect.stringContaining("appeared at its path") }]);
    expect(f.read("example", "SKILL.md")).toBe("created by the user just now");
    expect(f.receipt().skills).toEqual({});
  });

  it("leaves a skill it cannot read alone, whether it still ships or was retired", () => {
    const f = fixture();
    f.ship("locked", { "SKILL.md": "v1" });
    f.ship("locked-retired", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    f.ship("locked", { "SKILL.md": "v2" });
    f.unship("locked-retired");
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (String(file).startsWith(path.join(f.skills, "locked"))) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return (read as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ updated: [], retired: [], notices: [], failed: [], backupDir: null });
    expect(result.kept).toEqual([{ name: "locked", reason: "unreadable" }, { name: "locked-retired", reason: "unreadable" }]);
    vi.restoreAllMocks();
    expect(f.read("locked", "SKILL.md")).toBe("v1");
    expect(f.read("locked-retired", "SKILL.md")).toBe("v1");
    expect(Object.keys(f.receipt().skills)).toEqual(["locked", "locked-retired"]);
  });

  it("retires nothing when the package ships no skills at all", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    fs.rmSync(path.join(f.template, "skills"), { recursive: true });
    const before = snapshot(f.home);

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ added: [], retired: [], kept: [] });
    expect(snapshot(f.home)).toEqual(before);
  });

  it("leaves a home last synced by a newer OpenRyoko alone", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v2" });
    f.ship("newer-only", { "SKILL.md": "added in the newer release" });
    f.sync("2026.10.11");
    // An older CLI pointed at the same home: it ships the old text and lacks the new skill.
    f.ship("example", { "SKILL.md": "v1" });
    f.unship("newer-only");
    f.ship("older-only", { "SKILL.md": "retired by the newer release" });
    const before = snapshot(f.home);

    const result = f.sync("2026.10.10");

    expect(result).toMatchObject({ skipped: "newer-receipt", added: [], updated: [], retired: [] });
    expect(snapshot(f.home)).toEqual(before);
  });

  it("forgets a retired skill the user already removed", () => {
    const f = fixture();
    f.ship("staying", { "SKILL.md": "stays" });
    f.ship("old", { "SKILL.md": "retired soon" });
    f.sync("2026.10.10");
    fs.rmSync(path.join(f.skills, "old"), { recursive: true });
    f.unship("old");

    const result = f.sync("2026.10.11");

    expect(result).toMatchObject({ retired: [], kept: [], backupDir: null });
    expect(Object.keys(f.receipt().skills)).toEqual(["staying"]);
  });

  it("ignores Finder and git housekeeping files when deciding whether a skill was edited", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1" });
    f.sync("2026.10.10");
    fs.writeFileSync(path.join(f.skills, "example", ".DS_Store"), "finder");
    f.ship("example", { "SKILL.md": "v2", ".gitkeep": "" });

    const result = f.sync("2026.10.11");

    expect(result.updated).toEqual(["example"]);
    expect(f.read("example", "SKILL.md")).toBe("v2");
    expect(fs.readdirSync(path.join(f.skills, "example"))).toEqual(["SKILL.md"]);
    expect(fs.readFileSync(path.join(result.backupDir!, "skills", "example", ".DS_Store"), "utf8")).toBe("finder");
  });

  it("keeps a shipped script executable", () => {
    const f = fixture();
    f.ship("example", { "SKILL.md": "v1", "scripts/run.sh": "#!/bin/sh\n" });
    fs.chmodSync(path.join(f.template, "skills", "example", "scripts", "run.sh"), 0o755);
    fs.chmodSync(path.join(f.template, "skills", "example", "SKILL.md"), 0o644);
    const chmod = vi.spyOn(fs, "chmodSync");

    f.sync();

    // Owner bits only: the rest is the process umask's to decide, as for any new file.
    if (POSIX_MODES_SUPPORTED) {
      expect(fs.statSync(path.join(f.skills, "example", "scripts", "run.sh")).mode & 0o700).toBe(0o700);
      expect(fs.statSync(path.join(f.skills, "example", "SKILL.md")).mode & 0o700).toBe(0o600);
    }
    // The mode is set as the file is created. A separate chmod fails with EPERM on
    // mounts without POSIX permissions (CIFS), and would fail the whole install there.
    expect(chmod).not.toHaveBeenCalled();
  });

  it("neither reads nor writes skills.json, which records what the user installed", () => {
    const f = fixture();
    const manifest = `${JSON.stringify({ installed: { example: { source: "own/rep@example", installedAt: "t" } } }, null, 2)}\n`;
    fs.writeFileSync(path.join(f.home, "skills.json"), manifest);
    fs.writeFileSync(path.join(f.template, "skills.json"), '{\n  "installed": {}\n}\n');
    f.ship("example", { "SKILL.md": "v1" });
    f.ship("old", { "SKILL.md": "retired soon" });
    f.sync("2026.10.10");
    f.ship("example", { "SKILL.md": "v2" });
    f.unship("old");
    expect(f.sync("2026.10.11")).toMatchObject({ updated: ["example"], retired: ["old"] });

    expect(fs.readFileSync(path.join(f.home, "skills.json"), "utf8")).toBe(manifest);

    const fresh = fixture();
    fs.writeFileSync(path.join(fresh.template, "skills.json"), '{\n  "installed": {}\n}\n');
    fresh.ship("example", { "SKILL.md": "v1" });
    fresh.sync();
    expect(fs.existsSync(path.join(fresh.home, "skills.json"))).toBe(false);
  });
});
