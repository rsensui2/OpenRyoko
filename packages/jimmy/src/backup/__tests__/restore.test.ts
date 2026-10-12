import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectPosixMode, POSIX_MODES_SUPPORTED } from "../../shared/test-support/posix-mode.js";
import type { DiskSpaceStatus } from "../../shared/storage-health.js";
import { createHomeArchive, inspectHomeArchive } from "../archive.js";
import { listBackups } from "../catalog.js";
import { restoreHomeArchive, type RestoreOptions } from "../restore.js";
import {
  HOME_CONTENT,
  makeHome,
  rawDirectory,
  rawFile,
  rawSymlink,
  removeTempDirs,
  tempDir,
  writeRawArchive,
  writeTree,
} from "./fixture.js";

const TAKEN = new Date("2026-10-12T03:00:00.000Z");
const NOW = new Date("2026-10-12T09:30:00.000Z");
const ROOMY: DiskSpaceStatus = { level: "ok", freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, freePercent: 50 };
const FULL: DiskSpaceStatus = { level: "critical", freeBytes: 12 * 1024 ** 2, totalBytes: 100 * 1024 ** 3, freePercent: 0.01 };

interface Scene {
  root: string;
  home: string;
  backups: string;
  archive: string;
}

/** A home with one archive of it sitting in <home>/backups. */
async function scene(): Promise<Scene> {
  const root = tempDir();
  const home = makeHome(root);
  const backups = path.join(home, "backups");
  const result = await createHomeArchive({
    home, destination: path.join(backups, "home-20261012T030000Z.tar.gz"), id: "home-20261012T030000Z", createdAt: TAKEN,
    excludePaths: [backups],
  });
  return { root, home, backups, archive: result.file };
}

function optionsFor(target: Scene, extra: Partial<RestoreOptions> = {}): RestoreOptions {
  return { archive: target.archive, home: target.home, backupDirectory: target.backups, now: NOW, diskSpace: () => ROOMY, ...extra };
}

const read = (home: string, relative: string): string => fs.readFileSync(path.join(home, ...relative.split("/")), "utf8");

/** Every file under `directory`, as a path -> contents map. Symlinks are listed, never followed. */
function snapshotTree(directory: string, prefix = ""): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) found[relative] = `-> ${fs.readlinkSync(absolute)}`;
    else if (entry.isDirectory()) Object.assign(found, snapshotTree(absolute, relative));
    else found[relative] = fs.readFileSync(absolute, "utf8");
  }
  return found;
}

afterEach(removeTempDirs);

describe("restoreHomeArchive", () => {
  it("brings back what was edited and what was deleted, byte for byte", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "gateway: { port: broken\n");
    fs.writeFileSync(path.join(target.home, "cron", "jobs.json"), "[]\n");
    fs.rmSync(path.join(target.home, "MEMORY.md"));
    fs.rmSync(path.join(target.home, "skills", "demo"), { recursive: true });
    fs.rmSync(path.join(target.home, "knowledge"), { recursive: true });

    const result = await restoreHomeArchive(optionsFor(target));

    for (const [relative, contents] of Object.entries(HOME_CONTENT)) expect(read(target.home, relative), relative).toBe(contents);
    if (POSIX_MODES_SUPPORTED) expect(fs.statSync(path.join(target.home, "skills", "demo", "run.sh")).mode & 0o111).not.toBe(0);
    expect(result.changes.filter((change) => change.type !== "directory").map((change) => [change.path, change.action]).sort()).toEqual([
      ["MEMORY.md", "create"],
      ["config.yaml", "replace"],
      ["cron/jobs.json", "replace"],
      ["knowledge/議事録/notes.md", "create"],
      ["skills/demo/SKILL.md", "create"],
      ["skills/demo/run.sh", "create"],
    ]);
    expect(result.unchanged).toBeGreaterThan(0);
    expect(result.dryRun).toBe(false);
  });

  it("rebuilds a home that is gone entirely", async () => {
    const target = await scene();
    const fresh = path.join(target.root, "rebuilt");

    const result = await restoreHomeArchive(optionsFor(target, { home: fresh, backupDirectory: path.join(fresh, "backups") }));

    for (const [relative, contents] of Object.entries(HOME_CONTENT)) expect(read(fresh, relative), relative).toBe(contents);
    expect(result.preRestore).toBeNull();
    expectPosixMode(fresh, 0o700);
  });

  it("restores only the kinds it is asked for", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");
    fs.writeFileSync(path.join(target.home, "MEMORY.md"), "rewritten by mistake\n");
    fs.writeFileSync(path.join(target.home, "AGENTS.md"), "rewritten by mistake\n");

    const result = await restoreHomeArchive(optionsFor(target, { only: ["config", "memory"] }));

    expect(read(target.home, "config.yaml")).toBe(HOME_CONTENT["config.yaml"]);
    expect(read(target.home, "MEMORY.md")).toBe(HOME_CONTENT["MEMORY.md"]);
    expect(read(target.home, "AGENTS.md")).toBe("rewritten by mistake\n");
    expect(result.kinds).toEqual(["config", "memory"]);
    expect(result.changes.map((change) => change.path).sort()).toEqual(["MEMORY.md", "config.yaml"]);
  });

  it("restores the cron jobs without rewinding the run history beside them", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "cron", "jobs.json"), "[]\n");
    fs.appendFileSync(path.join(target.home, "cron", "runs", "daily.jsonl"), '{"status":"ok","at":"after the backup"}\n');

    await restoreHomeArchive(optionsFor(target, { only: ["cron"] }));

    expect(read(target.home, "cron/jobs.json")).toBe(HOME_CONTENT["cron/jobs.json"]);
    expect(read(target.home, "cron/runs/daily.jsonl")).toContain("after the backup");
  });

  it("reports what a restore would do, and does none of it, on a dry run", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");
    fs.rmSync(path.join(target.home, "MEMORY.md"));
    const before = snapshotTree(target.home);

    const result = await restoreHomeArchive(optionsFor(target, { dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(result.changes.map((change) => [change.path, change.action]).sort()).toEqual([["MEMORY.md", "create"], ["config.yaml", "replace"]]);
    expect(result.preRestore).toBeNull();
    expect(snapshotTree(target.home)).toEqual(before);
  });

  it("saves the state it is about to overwrite, and that snapshot restores it again", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "edited after the backup\n");
    fs.writeFileSync(path.join(target.home, "knowledge", "new.md"), "written after the backup\n");

    const result = await restoreHomeArchive(optionsFor(target));

    expect(result.preRestore).toEqual({
      id: "pre-restore-20261012T093000Z", file: path.join(target.backups, "pre-restore-20261012T093000Z.tar.gz"),
    });
    expectPosixMode(result.preRestore!.file, 0o600);
    const saved = await inspectHomeArchive(result.preRestore!.file);
    expect(saved.ok).toBe(true);
    expect(saved.manifest!.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(["config.yaml", "knowledge/new.md"]));
    expect(read(target.home, "config.yaml")).toBe(HOME_CONTENT["config.yaml"]);

    await restoreHomeArchive(optionsFor(target, { archive: result.preRestore!.file, now: new Date(NOW.getTime() + 60_000) }));

    expect(read(target.home, "config.yaml")).toBe("edited after the backup\n");
    expect(listBackups(target.backups).filter((item) => item.preRestore)).toHaveLength(2);
  });

  it("deletes nothing: what was added since the backup stays, and is reported", async () => {
    const target = await scene();
    writeTree(target.home, {
      "knowledge/new.md": "written after the backup\n",
      "skills/later/SKILL.md": "installed after the backup\n",
      "skills/demo/node_modules/dep/index.js": "module.exports = 3\n",
      "skills/demo/.git/HEAD": "ref: refs/heads/main\n",
    });
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");

    const result = await restoreHomeArchive(optionsFor(target));

    expect(read(target.home, "knowledge/new.md")).toBe("written after the backup\n");
    expect(read(target.home, "skills/later/SKILL.md")).toBe("installed after the backup\n");
    expect(read(target.home, "skills/demo/node_modules/dep/index.js")).toBe("module.exports = 3\n");
    expect(read(target.home, "skills/demo/.git/HEAD")).toBe("ref: refs/heads/main\n");
    expect(result.untouched.sort()).toEqual(["knowledge/new.md", "skills/later/SKILL.md"]);
  });

  it("takes no snapshot and writes nothing when the home already matches", async () => {
    const target = await scene();
    const before = snapshotTree(target.home);

    const result = await restoreHomeArchive(optionsFor(target));

    expect(result.changes).toEqual([]);
    expect(result.preRestore).toBeNull();
    expect(snapshotTree(target.home)).toEqual(before);
  });

  it("cleans up its staging directory", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");

    await restoreHomeArchive(optionsFor(target));

    expect(fs.readdirSync(path.join(target.home, "tmp")).filter((name) => name.startsWith("restore-"))).toEqual([]);
  });

  it("restores a file with the mode it was archived with", async () => {
    const target = await scene();
    fs.rmSync(path.join(target.home, "config.yaml"));
    const strict = await createHomeArchive({
      home: makeStrictHome(target.root), destination: path.join(target.backups, "home-20261012T040000Z.tar.gz"),
      id: "home-20261012T040000Z", createdAt: TAKEN,
    });

    await restoreHomeArchive(optionsFor(target, { archive: strict.file, only: ["config"] }));

    expectPosixMode(path.join(target.home, "config.yaml"), 0o600);
  });

  it("refuses when there is no room to work in, before touching anything", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");
    const before = snapshotTree(target.home);

    await expect(restoreHomeArchive(optionsFor(target, { diskSpace: () => FULL }))).rejects.toThrow(/free disk space/);

    expect(snapshotTree(target.home)).toEqual(before);
  });

  it("restores nothing when the current state cannot be saved first", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");
    const blocked = path.join(target.root, "blocked");
    fs.writeFileSync(blocked, "a file where the backup directory should be\n");

    await expect(restoreHomeArchive(optionsFor(target, { backupDirectory: blocked })))
      .rejects.toThrow(/current state could not be saved.*nothing was restored/s);

    expect(read(target.home, "config.yaml")).toBe("broken\n");
  });

  it("says so when the archive holds nothing of the kind asked for", async () => {
    const root = tempDir();
    const home = path.join(root, "home");
    const archive = writeRawArchive(path.join(root, "home-20261012T030000Z.tar.gz"), [rawFile("config.yaml", "port: 1\n")]);

    await expect(restoreHomeArchive({
      archive, home, backupDirectory: path.join(home, "backups"), now: NOW, only: ["org"], diskSpace: () => ROOMY,
    })).rejects.toThrow(/holds nothing.*org/s);
    expect(fs.existsSync(home)).toBe(false);
  });
});

describe("restoreHomeArchive, refusing what it must not trust", () => {
  it("refuses an archive that fails verification, with the home untouched", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");
    const whole = fs.readFileSync(target.archive);
    fs.writeFileSync(target.archive, whole.subarray(0, whole.length - 20));
    const before = snapshotTree(target.home);

    await expect(restoreHomeArchive(optionsFor(target))).rejects.toThrow(/failed verification/);

    expect(snapshotTree(target.home)).toEqual(before);
    expect(listBackups(target.backups).filter((item) => item.preRestore)).toEqual([]);
  });

  it("refuses an archive whose contents no longer match its manifest", async () => {
    const root = tempDir();
    const home = makeHome(root);
    const archive = writeRawArchive(path.join(root, "home-20261012T030000Z.tar.gz"), [rawFile("config.yaml", "tampered: true\n")], (manifest) => ({
      ...manifest,
      entries: manifest.entries.map((entry) => ({ ...entry, sha256: "0".repeat(64) })),
    }));

    await expect(restoreHomeArchive({ archive, home, backupDirectory: path.join(home, "backups"), now: NOW, diskSpace: () => ROOMY }))
      .rejects.toThrow(/failed verification.*sha256/s);
    expect(read(home, "config.yaml")).toBe(HOME_CONTENT["config.yaml"]);
  });

  it.each([
    ["a path that climbs out of the home", [rawFile("../escaped.txt", "outside\n")]],
    ["an absolute path", [rawFile("/tmp/ryoko-restore-escape.txt", "outside\n")]],
    ["a path that climbs out midway", [rawDirectory("skills"), rawFile("skills/../../escaped.txt", "outside\n")]],
  ])("refuses an archive holding %s", async (_label, entries) => {
    const root = tempDir();
    const home = makeHome(root);
    const archive = writeRawArchive(path.join(root, "home-20261012T030000Z.tar.gz"), [rawFile("config.yaml", "evil: true\n"), ...entries]);
    const before = snapshotTree(root);

    await expect(restoreHomeArchive({ archive, home, backupDirectory: path.join(home, "backups"), now: NOW, diskSpace: () => ROOMY }))
      .rejects.toThrow(/failed verification.*unsafe path/s);

    // Not the escaping entry, and not the innocent-looking one beside it either.
    expect(snapshotTree(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, "escaped.txt"))).toBe(false);
  });

  it("refuses an archive that plants a symlink and then writes through it", async () => {
    const root = tempDir();
    const home = makeHome(root);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const archive = writeRawArchive(path.join(root, "home-20261012T030000Z.tar.gz"), [
      rawDirectory("skills"),
      rawSymlink("skills/escape", outside),
      rawFile("skills/escape/planted.txt", "outside the home\n"),
    ]);

    await expect(restoreHomeArchive({
      archive, home, backupDirectory: path.join(home, "backups"), now: NOW, allowExternalSymlinks: true, diskSpace: () => ROOMY,
    })).rejects.toThrow(/failed verification.*not a directory/s);

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(home, "skills", "escape"))).toBe(false);
  });

  it("never writes through a symlink that is in the home, either", async () => {
    const target = await scene();
    const outside = path.join(target.root, "outside");
    writeTree(outside, { "keep.txt": "not the instance's to touch\n" });
    fs.rmSync(path.join(target.home, "skills", "demo"), { recursive: true });
    fs.symlinkSync(outside, path.join(target.home, "skills", "demo"));

    const result = await restoreHomeArchive(optionsFor(target));

    expect(snapshotTree(outside)).toEqual({ "keep.txt": "not the instance's to touch\n" });
    expect(fs.lstatSync(path.join(target.home, "skills", "demo")).isDirectory()).toBe(true);
    expect(read(target.home, "skills/demo/SKILL.md")).toBe(HOME_CONTENT["skills/demo/SKILL.md"]);
    expect(result.changes.find((change) => change.path === "skills/demo")).toMatchObject({ type: "directory", action: "replace" });
  });

  it("does not recreate a symlink that points outside the home unless told to", async () => {
    const root = tempDir();
    const home = makeHome(root);
    const outside = path.join(root, "shared-skill");
    writeTree(outside, { "SKILL.md": "kept outside the home\n" });
    fs.symlinkSync(outside, path.join(home, "skills", "shared"));
    fs.symlinkSync("../docs/overview.md", path.join(home, "knowledge", "overview-link.md"));
    const backups = path.join(home, "backups");
    const taken = await createHomeArchive({
      home, destination: path.join(backups, "home-20261012T030000Z.tar.gz"), id: "home-20261012T030000Z", createdAt: TAKEN,
    });
    fs.rmSync(path.join(home, "skills", "shared"));
    fs.rmSync(path.join(home, "knowledge", "overview-link.md"));
    const options: RestoreOptions = { archive: taken.file, home, backupDirectory: backups, now: NOW, diskSpace: () => ROOMY };

    const refusal = await restoreHomeArchive(options).then(() => null, (error: Error) => error.message);
    expect(refusal).toContain(`skills/shared -> ${outside}`);
    expect(refusal).toContain("outside the home");
    expect(refusal).toContain("--allow-external-symlinks");
    // Refused as a whole: the harmless link beside it was not restored either.
    expect(fs.existsSync(path.join(home, "knowledge", "overview-link.md"))).toBe(false);
    expect(fs.existsSync(path.join(home, "skills", "shared"))).toBe(false);

    // A link that stays inside the home needs no permission.
    await restoreHomeArchive({ ...options, only: ["knowledge"] });
    expect(fs.readlinkSync(path.join(home, "knowledge", "overview-link.md"))).toBe("../docs/overview.md");

    await restoreHomeArchive({ ...options, allowExternalSymlinks: true, now: new Date(NOW.getTime() + 60_000) });
    expect(fs.readlinkSync(path.join(home, "skills", "shared"))).toBe(outside);
    expect(snapshotTree(outside)).toEqual({ "SKILL.md": "kept outside the home\n" });
  });

  it("refuses to clear a directory out of the way of a file, and restores nothing at all", async () => {
    const target = await scene();
    fs.rmSync(path.join(target.home, "MEMORY.md"));
    writeTree(target.home, { "MEMORY.md/notes.md": "someone made this a directory\n" });
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");

    await expect(restoreHomeArchive(optionsFor(target))).rejects.toThrow(/MEMORY\.md is a directory in the home/);

    expect(read(target.home, "config.yaml")).toBe("broken\n");
    expect(read(target.home, "MEMORY.md/notes.md")).toBe("someone made this a directory\n");
  });

  it("writes only under the paths a home archive is made of, whatever else the archive carries", async () => {
    const root = tempDir();
    const home = makeHome(root);
    const archive = writeRawArchive(path.join(root, "home-20261012T030000Z.tar.gz"), [
      rawFile("config.yaml", "port: 7902\n"),
      rawFile("gateway-auth.json", '{"value":"attacker"}\n'),
      rawDirectory(".claude"),
      rawFile(".claude/settings.local.json", '{"permissions":{"allow":["Bash(*)"]}}\n'),
      rawFile("hook-relay.mjs", "process.exit(1)\n"),
      rawDirectory("cron"),
      rawDirectory("cron/commands"),
      rawFile("cron/commands/stale.lock", "{}\n"),
    ]);

    const result = await restoreHomeArchive({ archive, home, backupDirectory: path.join(home, "backups"), now: NOW, diskSpace: () => ROOMY });

    expect(read(home, "config.yaml")).toBe("port: 7902\n");
    expect(read(home, "gateway-auth.json")).toBe('{"value":"placeholder"}\n');
    expect(read(home, ".claude/settings.local.json")).toBe("{}\n");
    expect(fs.existsSync(path.join(home, "hook-relay.mjs"))).toBe(false);
    expect(fs.existsSync(path.join(home, "cron", "commands", "stale.lock"))).toBe(false);
    expect(result.ignored.sort()).toEqual([
      ".claude", ".claude/settings.local.json", "cron/commands", "cron/commands/stale.lock", "gateway-auth.json", "hook-relay.mjs",
    ]);
  });
});

/** A home whose config.yaml is owner-only, as a hardened instance keeps it. */
function makeStrictHome(root: string): string {
  const home = path.join(root, "strict");
  writeTree(home, { "config.yaml": HOME_CONTENT["config.yaml"]! });
  fs.chmodSync(path.join(home, "config.yaml"), 0o600);
  return home;
}
