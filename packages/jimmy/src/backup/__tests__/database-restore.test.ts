import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";
import { createDailyDatabaseBackup } from "../../sessions/backup.js";
import { listBackups } from "../catalog.js";
import { inspectDatabaseBackup, restoreDatabase, type DatabaseRestoreOptions } from "../database-restore.js";
import { makeHome, removeTempDirs, rowCount, tempDir } from "./fixture.js";

const TAKEN = new Date("2026-10-11T03:00:00.000Z");
const NOW = new Date("2026-10-12T09:30:00.000Z");

interface Scene {
  home: string;
  backups: string;
  live: string;
  backup: string;
}

/** A home whose registry was copied at five rows and has grown to eight since. */
async function scene(name: "sessions" | "workflows" = "sessions"): Promise<Scene> {
  const home = makeHome(tempDir(), "home", name === "sessions" ? { sessionRows: 5 } : { workflowRows: 5 });
  const backups = path.join(home, "backups");
  const live = name === "sessions" ? path.join(home, "sessions", "registry.db") : path.join(home, "workflows", "workflows.db");
  const source = new Database(live);
  try {
    const { file } = await createDailyDatabaseBackup(source, { directory: backups, now: TAKEN, name });
    const insert = source.prepare(`INSERT INTO ${name} (label) VALUES (?)`);
    for (let index = 0; index < 3; index += 1) insert.run(`after-the-backup-${index}`);
    return { home, backups, live, backup: file };
  } finally {
    source.close();
  }
}

function optionsFor(target: Scene, extra: Partial<DatabaseRestoreOptions> = {}): DatabaseRestoreOptions {
  return { backup: target.backup, name: "sessions", home: target.home, backupDirectory: target.backups, now: NOW, ...extra };
}

const held: Database.Database[] = [];

afterEach(() => {
  for (const database of held.splice(0)) database.close();
  removeTempDirs();
});

describe("restoreDatabase", () => {
  it("puts the registry back as it was copied, and keeps what it replaced", async () => {
    const target = await scene();
    expect(rowCount(target.live, "sessions")).toBe(8);

    const result = await restoreDatabase(optionsFor(target));

    expect(result).toMatchObject({ name: "sessions", destination: target.live, dryRun: false });
    expect(rowCount(target.live, "sessions")).toBe(5);
    expectPosixMode(target.live, 0o600);
    expect(result.preRestore).toEqual({
      id: "pre-restore-20261012T093000Z-sessions",
      file: path.join(target.backups, "pre-restore-20261012T093000Z-sessions.db"),
    });
    expect(rowCount(result.preRestore!.file, "sessions")).toBe(8);
    expectPosixMode(result.preRestore!.file, 0o600);
  });

  it("refuses while the gateway is running, and tells the operator to stop it", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));

    await expect(restoreDatabase(optionsFor(target))).rejects.toThrow(/gateway.*is running.*ryoko stop/s);

    expect(rowCount(target.live, "sessions")).toBe(8);
    expect(listBackups(target.backups).filter((item) => item.preRestore)).toEqual([]);
  });

  it("refuses while another process has the registry open, even with no pid file to go by", async () => {
    const target = await scene();
    const owner = new Database(target.live);
    held.push(owner);
    owner.prepare("SELECT count(*) FROM sessions").get();

    await expect(restoreDatabase(optionsFor(target))).rejects.toThrow(/is running/);

    owner.prepare("INSERT INTO sessions (label) VALUES (?)").run("still writable");
    expect((owner.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n).toBe(9);
  });

  it("refuses on a dry run too, rather than promising a restore that would be refused", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "gateway.pid"), String(process.pid));

    await expect(restoreDatabase(optionsFor(target, { dryRun: true }))).rejects.toThrow(/is running/);
  });

  it("changes nothing on a dry run", async () => {
    const target = await scene();
    const before = fs.readdirSync(target.backups).sort();

    const result = await restoreDatabase(optionsFor(target, { dryRun: true }));

    expect(result).toMatchObject({ dryRun: true, preRestore: null, destination: target.live });
    expect(rowCount(target.live, "sessions")).toBe(8);
    expect(fs.readdirSync(target.backups).sort()).toEqual(before);
  });

  it("refuses a backup that is not a readable database, with the live one untouched", async () => {
    const target = await scene();
    const whole = fs.readFileSync(target.backup);
    const truncated = path.join(target.backups, "sessions-2026-10-09.db");
    fs.writeFileSync(truncated, whole.subarray(0, Math.floor(whole.length / 2)));
    const junk = path.join(target.backups, "sessions-2026-10-08.db");
    fs.writeFileSync(junk, "this is not a database");

    for (const broken of [truncated, junk]) {
      await expect(restoreDatabase(optionsFor(target, { backup: broken })), broken).rejects.toThrow(/failed its integrity check/);
    }

    expect(rowCount(target.live, "sessions")).toBe(8);
    expect(listBackups(target.backups).filter((item) => item.preRestore)).toEqual([]);
  });

  it("drops the sidecars of the database it replaces, so none of its tail is read into the new one", async () => {
    const target = await scene();
    for (const suffix of ["-wal", "-shm"]) fs.writeFileSync(`${target.live}${suffix}`, "left by a gateway that was killed\n");
    // The liveness check is replaced, because the real one opens the registry
    // and SQLite would tidy these files away before the restore ever saw them.
    await restoreDatabase(optionsFor(target, { detectGateway: () => ({ running: false }) }));

    expect(fs.existsSync(`${target.live}-wal`)).toBe(false);
    expect(fs.existsSync(`${target.live}-shm`)).toBe(false);
    expect(rowCount(target.live, "sessions")).toBe(5);
  });

  it("keeps the raw files of a live database too damaged to read", async () => {
    const target = await scene();
    fs.writeFileSync(target.live, "the registry was overwritten with garbage");

    const result = await restoreDatabase(optionsFor(target));

    expect(rowCount(target.live, "sessions")).toBe(5);
    expect(fs.readFileSync(result.preRestore!.file, "utf8")).toBe("the registry was overwritten with garbage");
  });

  it("restores the workflows store to its own place", async () => {
    const target = await scene("workflows");

    const result = await restoreDatabase(optionsFor(target, { name: "workflows" }));

    expect(result.destination).toBe(path.join(target.home, "workflows", "workflows.db"));
    expect(rowCount(target.live, "workflows")).toBe(5);
    expect(result.preRestore!.id).toBe("pre-restore-20261012T093000Z-workflows");
  });

  it("refuses while the workflows store itself is open, in a home whose registry gives nothing away", async () => {
    const target = await scene("workflows");
    const owner = new Database(target.live);
    held.push(owner);
    owner.prepare("SELECT count(*) FROM workflows").get();

    await expect(restoreDatabase(optionsFor(target, { name: "workflows" })))
      .rejects.toThrow(/is running.*workflows\.db is open in another process/s);

    expect((owner.prepare("SELECT count(*) AS n FROM workflows").get() as { n: number }).n).toBe(8);
  });

  it("restores into a home that has no database yet", async () => {
    const target = await scene();
    const fresh = path.join(path.dirname(target.home), "fresh");

    const result = await restoreDatabase(optionsFor(target, { home: fresh, backupDirectory: path.join(fresh, "backups") }));

    expect(result.preRestore).toBeNull();
    expect(rowCount(path.join(fresh, "sessions", "registry.db"), "sessions")).toBe(5);
  });

  it("can go back again from the copy it took first", async () => {
    const target = await scene();
    const first = await restoreDatabase(optionsFor(target));
    expect(rowCount(target.live, "sessions")).toBe(5);

    await restoreDatabase(optionsFor(target, { backup: first.preRestore!.file, now: new Date(NOW.getTime() + 60_000) }));

    expect(rowCount(target.live, "sessions")).toBe(8);
  });

  it("leaves no sidecars beside the backup it read", async () => {
    const target = await scene();

    await restoreDatabase(optionsFor(target));

    expect(fs.readdirSync(target.backups).filter((name) => /-(wal|shm)$/.test(name))).toEqual([]);
  });
});

describe("inspectDatabaseBackup", () => {
  it("passes a sound copy and leaves nothing behind", async () => {
    const target = await scene();

    expect(inspectDatabaseBackup(target.backup)).toEqual([]);
    expect(fs.readdirSync(target.backups).filter((name) => /-(wal|shm)$/.test(name))).toEqual([]);
  });

  it("reports a file that is not a database, a truncated one and a missing one", async () => {
    const target = await scene();
    const whole = fs.readFileSync(target.backup);
    const truncated = path.join(target.backups, "sessions-2026-10-09.db");
    fs.writeFileSync(truncated, whole.subarray(0, Math.floor(whole.length / 2)));
    const junk = path.join(target.backups, "sessions-2026-10-08.db");
    fs.writeFileSync(junk, "this is not a database");

    for (const broken of [truncated, junk, path.join(target.backups, "sessions-2026-10-07.db")]) {
      expect(inspectDatabaseBackup(broken), broken).not.toEqual([]);
    }
  });
});
