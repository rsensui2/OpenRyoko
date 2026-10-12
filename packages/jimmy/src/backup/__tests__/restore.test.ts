import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  sha256,
  tempDir,
  writeRawArchive,
  writeTree,
} from "./fixture.js";

const TAKEN = new Date("2026-10-12T03:00:00.000Z");
const NOW = new Date("2026-10-12T09:30:00.000Z");
const ROOMY: DiskSpaceStatus = { level: "ok", freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, freePercent: 50 };
const FULL: DiskSpaceStatus = { level: "critical", freeBytes: 12 * 1024 ** 2, totalBytes: 100 * 1024 ** 3, freePercent: 0.01 };
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

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

  it("restores the operator's own documents with the persona, and .env with the config", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "MANIFEST.md"), "rewritten by mistake\n");
    fs.rmSync(path.join(target.home, "BOOTSTRAP.md"));
    fs.writeFileSync(path.join(target.home, ".env"), "SCRIPT_API_KEY=\n");
    fs.writeFileSync(path.join(target.home, "MEMORY.md"), "rewritten by mistake\n");
    writeTree(target.home, { "NEW.md": "written after the backup\n" });

    const persona = await restoreHomeArchive(optionsFor(target, { only: ["persona"] }));

    expect(read(target.home, "MANIFEST.md")).toBe(HOME_CONTENT["MANIFEST.md"]);
    expect(read(target.home, "BOOTSTRAP.md")).toBe(HOME_CONTENT["BOOTSTRAP.md"]);
    expect(persona.changes.map((change) => [change.path, change.action, change.kind]).sort()).toEqual([
      ["BOOTSTRAP.md", "create", "persona"], ["MANIFEST.md", "replace", "persona"],
    ]);
    // Not persona: MEMORY.md is the memory's, .env the config's. And a document added since is left alone.
    expect(read(target.home, "MEMORY.md")).toBe("rewritten by mistake\n");
    expect(read(target.home, ".env")).toBe("SCRIPT_API_KEY=\n");
    expect(persona.untouched).toEqual(["NEW.md"]);

    const config = await restoreHomeArchive(optionsFor(target, { only: ["config"], now: new Date(NOW.getTime() + 60_000) }));

    expect(read(target.home, ".env")).toBe(HOME_CONTENT[".env"]);
    expect(config.changes.map((change) => [change.path, change.kind])).toEqual([[".env", "config"]]);
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

  it.skipIf(!POSIX_MODES_SUPPORTED)("puts a file's permissions back when they are all that changed", async () => {
    // Same bytes, so it used to count as unchanged - and a script that had
    // lost its execute bit stayed broken after a restore that reported success.
    const target = await scene();
    const script = path.join(target.home, "skills", "demo", "run.sh");
    fs.chmodSync(script, 0o644);

    const preview = await restoreHomeArchive(optionsFor(target, { dryRun: true }));

    expect(preview.changes).toEqual([{ path: "skills/demo/run.sh", type: "file", kind: "skills", action: "mode" }]);
    expectPosixMode(script, 0o644);

    const result = await restoreHomeArchive(optionsFor(target));

    expectPosixMode(script, 0o755);
    expect(read(target.home, "skills/demo/run.sh")).toBe(HOME_CONTENT["skills/demo/run.sh"]);
    expect(result.changes).toEqual(preview.changes);
    // It is a change to the home like any other, so the state before it is saved.
    expect(result.preRestore).not.toBeNull();
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

  it("still restores when the staging directory is on another filesystem than the destination", async () => {
    // rename(2) cannot cross a mount. A home whose tmp/ is its own mount gets
    // EXDEV for every staged file, and has to be served by copying instead.
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");
    fs.rmSync(path.join(target.home, "skills", "demo", "run.sh"));
    const realRename = fs.renameSync;
    const crossings: string[] = [];
    const rename = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).includes(`${path.sep}tmp${path.sep}restore-`)) {
        crossings.push(String(to));
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      }
      realRename(from, to);
    });
    try {
      await restoreHomeArchive(optionsFor(target));
    } finally {
      rename.mockRestore();
    }

    expect(crossings.map((file) => path.basename(file)).sort()).toEqual(["config.yaml", "run.sh"]);
    expect(read(target.home, "config.yaml")).toBe(HOME_CONTENT["config.yaml"]);
    expect(read(target.home, "skills/demo/run.sh")).toBe(HOME_CONTENT["skills/demo/run.sh"]);
    if (POSIX_MODES_SUPPORTED) expect(fs.statSync(path.join(target.home, "skills", "demo", "run.sh")).mode & 0o111).not.toBe(0);
    expect(fs.readdirSync(path.join(target.home, "skills", "demo")).filter((name) => name.includes(".restore-"))).toEqual([]);
  });

  it.skipIf(!POSIX_MODES_SUPPORTED || IS_ROOT)("says where the previous state is when it has to stop partway", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");
    fs.rmSync(path.join(target.home, "knowledge", "議事録", "notes.md"));
    const locked = path.join(target.home, "knowledge", "議事録");
    fs.chmodSync(locked, 0o555);
    try {
      // Not "restore that to go back": a restore deletes nothing, so the way
      // back returns what was overwritten and leaves what had been created.
      await expect(restoreHomeArchive(optionsFor(target)))
        .rejects.toThrow(/stopped partway.*saved as pre-restore-20261012T093000Z.*puts back what was overwritten.*created.*not removed/s);
    } finally {
      fs.chmodSync(locked, 0o755);
    }

    // What was reached before the failure is restored; the snapshot holds the state from before any of it.
    expect(read(target.home, "config.yaml")).toBe(HOME_CONTENT["config.yaml"]);
    const saved = await inspectHomeArchive(path.join(target.backups, "pre-restore-20261012T093000Z.tar.gz"));
    expect(saved.ok).toBe(true);
    expect(fs.readdirSync(path.join(target.home, "tmp")).filter((name) => name.startsWith("restore-"))).toEqual([]);
  });

  it("refuses when there is no room to work in, before touching anything", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");
    const before = snapshotTree(target.home);

    await expect(restoreHomeArchive(optionsFor(target, { diskSpace: () => FULL }))).rejects.toThrow(/free disk space/);

    expect(snapshotTree(target.home)).toEqual(before);
  });

  it("refuses when staging the files, or saving the current state, would leave the disk too low", async () => {
    // Not "is the disk critically low now" but "will it be once this is written".
    const root = tempDir();
    const home = makeHome(root);
    writeTree(home, { "knowledge/large.bin": "x".repeat(300_000) });
    const backups = path.join(root, "elsewhere");
    const taken = await createHomeArchive({
      home, destination: path.join(backups, "home-20261012T030000Z.tar.gz"), id: "home-20261012T030000Z", createdAt: TAKEN,
    });
    fs.rmSync(path.join(home, "knowledge", "large.bin"));
    fs.writeFileSync(path.join(home, "config.yaml"), "broken\n");
    const before = snapshotTree(home);
    const total = 100 * 1024 ** 3;
    const reserve = 256 * 1024 ** 2;
    const tight: DiskSpaceStatus = { level: "warning", freeBytes: reserve + 100_000, totalBytes: total, freePercent: 0.25 };
    const options: RestoreOptions = { archive: taken.file, home, backupDirectory: backups, now: NOW };

    // 300 KB to stage in the home, 100 KB to spare there.
    await expect(restoreHomeArchive({ ...options, diskSpace: (directory) => (directory === backups ? ROOMY : tight) }))
      .rejects.toThrow(/not enough free disk space.*nothing was restored/s);
    // Room in the home, none where the snapshot of the current state has to go.
    await expect(restoreHomeArchive({ ...options, only: ["config"], diskSpace: (directory) => (directory === backups ? { ...tight, freeBytes: reserve + 1000 } : ROOMY) }))
      .rejects.toThrow(/current state could not be saved.*not enough free disk space/s);

    expect(snapshotTree(home)).toEqual(before);
    expect(listBackups(backups).filter((item) => item.preRestore)).toEqual([]);

    await restoreHomeArchive({ ...options, diskSpace: () => ROOMY });
    expect(fs.statSync(path.join(home, "knowledge", "large.bin")).size).toBe(300_000);
  });

  it.skipIf(!POSIX_MODES_SUPPORTED || IS_ROOT)("will not replace a file it could not save first", async () => {
    // The snapshot leaves out what it cannot read and says so. The restore then
    // replaced that very file, and reported the previous state as saved.
    const target = await scene();
    const soul = path.join(target.home, "SOUL.md");
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");
    for (const rewritten of ["rewritten at length since the backup was taken\n", "# Sole\n"]) {
      // Once with a different size, once with the archived size: then it cannot even be compared.
      fs.writeFileSync(soul, rewritten);
      fs.chmodSync(soul, 0o000);
      try {
        await expect(restoreHomeArchive(optionsFor(target))).rejects.toThrow(/SOUL\.md.*could not be saved.*nothing was restored/s);
      } finally {
        fs.chmodSync(soul, 0o600);
      }

      expect(read(target.home, "SOUL.md")).toBe(rewritten);
      expect(read(target.home, "config.yaml")).toBe("broken\n");
      expect(listBackups(target.backups).filter((item) => item.preRestore)).toEqual([]);
    }

    // What it cannot save is only in the way of restoring that file. Restoring something else goes ahead.
    fs.chmodSync(soul, 0o000);
    try {
      const result = await restoreHomeArchive(optionsFor(target, { only: ["config"] }));
      expect(result.preRestore).not.toBeNull();
    } finally {
      fs.chmodSync(soul, 0o600);
    }
    expect(read(target.home, "config.yaml")).toBe(HOME_CONTENT["config.yaml"]);
    expect(read(target.home, "SOUL.md")).toBe("# Sole\n");
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

  it("refuses an archive that holds more than the limits allow, and one it would take more than the limits to save first", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");
    const tight = { maxEntries: 10, maxBytes: 1024 ** 3 };

    // The archive itself is over the entry limit: refused while it is being read.
    await expect(restoreHomeArchive(optionsFor(target, { limits: tight }))).rejects.toThrow(/failed verification.*backup\.maxEntries/s);

    // The archive is fine, but the home has since grown past the limit, so the
    // state about to be overwritten cannot be saved. Nothing is restored.
    writeTree(target.home, Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`knowledge/flood/empty-${index}`, ""])));
    const entries = (await inspectHomeArchive(target.archive)).manifest!.entries.length;
    await expect(restoreHomeArchive(optionsFor(target, { limits: { maxEntries: entries + 20, maxBytes: 1024 ** 3 } })))
      .rejects.toThrow(/current state could not be saved.*backup\.maxEntries/s);

    expect(read(target.home, "config.yaml")).toBe("broken\n");
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

  it("does not lean on the inspection alone to keep a path inside the home", async () => {
    const root = tempDir();
    const home = makeHome(root);
    const archive = writeRawArchive(path.join(root, "home-20261012T030000Z.tar.gz"), [
      rawDirectory("skills"),
      rawFile("skills/../../escaped.txt", "outside\n"),
    ]);
    // An inspector that waves everything through, as a regression in it would.
    const lenient: RestoreOptions["inspect"] = async () => ({
      ok: true,
      problems: [],
      manifest: {
        schemaVersion: 1, format: "openryoko-home-archive", id: "home-20261012T030000Z", createdAt: TAKEN.toISOString(),
        home, contentBytes: 8, skipped: [],
        entries: [
          { path: "skills", type: "directory", mode: 0o755 },
          // Size and hash are right, so nothing but the path itself can stop this.
          { path: "skills/../../escaped.txt", type: "file", mode: 0o644, size: 8, sha256: sha256("outside\n") },
        ],
      },
    });

    await expect(restoreHomeArchive({
      archive, home, backupDirectory: path.join(home, "backups"), now: NOW, diskSpace: () => ROOMY, inspect: lenient,
    })).rejects.toThrow(/unsafe path/);

    expect(fs.existsSync(path.join(root, "escaped.txt"))).toBe(false);
  });

  it("writes nothing when the archive is swapped between being verified and being read", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");
    fs.rmSync(path.join(target.home, "MEMORY.md"));
    const verified = (await inspectHomeArchive(target.archive)).manifest!;
    // What gets read afterwards is a different file under the same name.
    const swapped = writeRawArchive(path.join(target.root, "swapped.tar.gz"), [
      rawFile("config.yaml", "attacker: true\n"),
    ]);
    const stale: RestoreOptions["inspect"] = async () => ({ ok: true, problems: [], manifest: verified });

    await expect(restoreHomeArchive(optionsFor(target, { archive: swapped, inspect: stale, only: ["config"] })))
      .rejects.toThrow(/config\.yaml no longer matches the manifest that was verified/);
    await expect(restoreHomeArchive(optionsFor(target, { archive: swapped, inspect: stale, only: ["memory"], now: new Date(NOW.getTime() + 60_000) })))
      .rejects.toThrow(/no longer holds MEMORY\.md/);

    expect(read(target.home, "config.yaml")).toBe("broken\n");
    expect(fs.existsSync(path.join(target.home, "MEMORY.md"))).toBe(false);
    expect(fs.readdirSync(path.join(target.home, "tmp")).filter((name) => name.startsWith("restore-"))).toEqual([]);
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

  it("does not write through a directory that became a symlink after the plan was made", async () => {
    // The plan is worked out, then the current state is saved - seconds, in a
    // large home - and only then is anything written. A directory two levels
    // above a file can be swapped for a symlink in that time. Looking only at
    // the file's own parent does not see it: through the link, the parent is a
    // perfectly real directory, somewhere else.
    const target = await scene();
    const outside = path.join(target.root, "outside");
    writeTree(outside, { "demo/keep.txt": "not the instance's to touch\n" });
    fs.rmSync(path.join(target.home, "skills", "demo", "run.sh"));
    let swapped = false;
    const swapOnce = (): DiskSpaceStatus => {
      if (!swapped) {
        swapped = true;
        fs.renameSync(path.join(target.home, "skills"), path.join(target.root, "skills-moved-aside"));
        fs.symlinkSync(outside, path.join(target.home, "skills"));
      }
      return ROOMY;
    };

    const outcome = await restoreHomeArchive(optionsFor(target, { diskSpace: swapOnce }))
      .then(() => "restored", (error: Error) => error.message);

    expect(swapped).toBe(true);
    // The thing that matters first: nothing landed on the far side of the link.
    expect(snapshotTree(outside)).toEqual({ "demo/keep.txt": "not the instance's to touch\n" });
    expect(outcome).toMatch(/skills is no longer a directory/);
  });

  it("replaces a symlink standing where a file belongs, rather than writing to what it points at", async () => {
    const target = await scene();
    const outside = path.join(target.root, "outside");
    writeTree(outside, { "victim.txt": "not the instance's to overwrite\n" });
    fs.rmSync(path.join(target.home, "config.yaml"));
    fs.symlinkSync(path.join(outside, "victim.txt"), path.join(target.home, "config.yaml"));

    const result = await restoreHomeArchive(optionsFor(target, { only: ["config"] }));

    expect(read(outside, "victim.txt")).toBe("not the instance's to overwrite\n");
    expect(fs.lstatSync(path.join(target.home, "config.yaml")).isFile()).toBe(true);
    expect(read(target.home, "config.yaml")).toBe(HOME_CONTENT["config.yaml"]);
    expect(result.changes).toEqual([{ path: "config.yaml", type: "file", kind: "config", action: "replace" }]);
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

  it("does not ask permission for an outside symlink that is still in the home, unchanged", async () => {
    // The operator's own links into skills/ are in every archive of this home.
    // A restore that leaves them exactly as they are introduces nothing.
    const root = tempDir();
    const home = makeHome(root);
    const outside = path.join(root, "shared-skill");
    writeTree(outside, { "SKILL.md": "kept outside the home\n" });
    fs.symlinkSync(outside, path.join(home, "skills", "shared"));
    const backups = path.join(home, "backups");
    const taken = await createHomeArchive({
      home, destination: path.join(backups, "home-20261012T030000Z.tar.gz"), id: "home-20261012T030000Z", createdAt: TAKEN,
    });
    fs.writeFileSync(path.join(home, "config.yaml"), "broken\n");
    const options: RestoreOptions = { archive: taken.file, home, backupDirectory: backups, now: NOW, diskSpace: () => ROOMY };

    const result = await restoreHomeArchive(options);

    expect(read(home, "config.yaml")).toBe(HOME_CONTENT["config.yaml"]);
    expect(fs.readlinkSync(path.join(home, "skills", "shared"))).toBe(outside);
    expect(result.changes.map((change) => change.path)).toEqual(["config.yaml"]);

    // Pointed somewhere else since the backup, putting it back is a write, and that does need the flag.
    fs.rmSync(path.join(home, "skills", "shared"));
    fs.symlinkSync(path.join(root, "somewhere-else"), path.join(home, "skills", "shared"));
    await expect(restoreHomeArchive({ ...options, now: new Date(NOW.getTime() + 60_000) })).rejects.toThrow(/--allow-external-symlinks/);
    expect(fs.readlinkSync(path.join(home, "skills", "shared"))).toBe(path.join(root, "somewhere-else"));
  });

  it("will not stage what it extracts outside the home because tmp/ has been made a symlink", async () => {
    // Files are extracted under <home>/tmp before they are moved into place.
    // A link there would put the contents of config.yaml wherever it points.
    const target = await scene();
    const outside = path.join(target.root, "outside-tmp");
    fs.mkdirSync(outside);
    const scratch = path.join(target.home, "tmp");
    fs.rmSync(scratch, { recursive: true });
    fs.symlinkSync(outside, scratch);
    fs.writeFileSync(path.join(target.home, "config.yaml"), "broken\n");

    await expect(restoreHomeArchive(optionsFor(target))).rejects.toThrow(/tmp is a symlink.*nothing was restored/s);

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(read(target.home, "config.yaml")).toBe("broken\n");
    // Refused before the snapshot was taken, not after.
    expect(listBackups(target.backups).filter((item) => item.preRestore)).toEqual([]);

    fs.rmSync(scratch);
    fs.writeFileSync(scratch, "a file where the directory should be\n");
    await expect(restoreHomeArchive(optionsFor(target))).rejects.toThrow(/tmp is not a directory.*nothing was restored/s);
    expect(read(target.home, "config.yaml")).toBe("broken\n");

    // A dry run stages nothing, so it has nothing to object to.
    await expect(restoreHomeArchive(optionsFor(target, { dryRun: true }))).resolves.toMatchObject({ dryRun: true });
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
