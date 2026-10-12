import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";
import type { DiskSpaceStatus } from "../../shared/storage-health.js";
import { createDailyDatabaseBackup } from "../../sessions/backup.js";
import { listBackups } from "../catalog.js";
import { inspectDatabaseBackup, restoreDatabase, type DatabaseRestoreOptions } from "../database-restore.js";
import { databaseFingerprint, leaveMidFlight, makeHome, removeTempDirs, rowCount, setDatabaseModified, sha256, tempDir } from "./fixture.js";

const TAKEN = new Date("2026-10-11T03:00:00.000Z");
const NOW = new Date("2026-10-12T09:30:00.000Z");
/** Long enough before NOW that nothing reads as "just written". File times come from the wall clock otherwise. */
const QUIET_SINCE = new Date(NOW.getTime() - 60 * 60 * 1000);
/** Below this much free, the gateway refuses to write to its database (shared/storage-health). */
const RESERVE_BYTES = 256 * 1024 ** 2;

interface Scene {
  home: string;
  backups: string;
  live: string;
  backup: string;
}

/** A home whose registry was copied at five rows and has grown to eight since, idle for the last hour. */
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
    setDatabaseModified(live, QUIET_SINCE);
  }
}

/**
 * The same home, with its registry the way a process that cannot see its locks
 * finds a live one: eight rows, most of them only in the WAL, nobody visibly
 * holding it. Opening it read-write would checkpoint that WAL and delete it.
 */
async function sceneMidFlight(): Promise<Scene> {
  const target = await scene();
  fs.rmSync(target.live);
  leaveMidFlight(target.live, "sessions", 8);
  setDatabaseModified(target.live, QUIET_SINCE);
  return target;
}

/** Counts rows, then puts the file times back: reading a WAL database leaves sidecars stamped "now". */
function liveRows(target: Scene, table = "sessions"): number {
  const count = rowCount(target.live, table);
  setDatabaseModified(target.live, QUIET_SINCE);
  return count;
}

/** Options for an operator who has stopped the gateway and said so, unless a test takes that back. */
function optionsFor(target: Scene, extra: Partial<DatabaseRestoreOptions> = {}): DatabaseRestoreOptions {
  return {
    backup: target.backup, name: "sessions", home: target.home, backupDirectory: target.backups, now: NOW,
    gatewayStopped: true, ...extra,
  };
}

const refusalOf = (options: DatabaseRestoreOptions): Promise<string | null> =>
  restoreDatabase(options).then(() => null, (error: Error) => error.message);

afterEach(removeTempDirs);

describe("restoreDatabase", () => {
  it("puts the registry back as it was copied, and keeps what it replaced", async () => {
    const target = await scene();
    expect(liveRows(target)).toBe(8);

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

  it("restores the workflows store to its own place", async () => {
    const target = await scene("workflows");

    const result = await restoreDatabase(optionsFor(target, { name: "workflows" }));

    expect(result.destination).toBe(path.join(target.home, "workflows", "workflows.db"));
    expect(rowCount(target.live, "workflows")).toBe(5);
    expect(result.preRestore!.id).toBe("pre-restore-20261012T093000Z-workflows");
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
    expect(liveRows(target)).toBe(5);

    await restoreDatabase(optionsFor(target, { backup: first.preRestore!.file, now: new Date(NOW.getTime() + 60_000) }));

    expect(rowCount(target.live, "sessions")).toBe(8);
  });

  it("refuses a backup that is not a readable database, with the live one untouched", async () => {
    const target = await sceneMidFlight();
    const whole = fs.readFileSync(target.backup);
    const truncated = path.join(target.backups, "sessions-2026-10-09.db");
    fs.writeFileSync(truncated, whole.subarray(0, Math.floor(whole.length / 2)));
    const junk = path.join(target.backups, "sessions-2026-10-08.db");
    fs.writeFileSync(junk, "this is not a database");
    const before = databaseFingerprint(target.live);

    for (const broken of [truncated, junk]) {
      await expect(restoreDatabase(optionsFor(target, { backup: broken })), broken).rejects.toThrow(/failed its integrity check/);
    }

    expect(databaseFingerprint(target.live)).toEqual(before);
    expect(listBackups(target.backups).filter((item) => item.preRestore)).toEqual([]);
  });

  it("drops the sidecars of the database it replaces, so none of its tail is read into the new one", async () => {
    const target = await scene();
    for (const suffix of ["-wal", "-shm"]) fs.writeFileSync(`${target.live}${suffix}`, "left by a gateway that was killed\n");
    setDatabaseModified(target.live, QUIET_SINCE);

    const result = await restoreDatabase(optionsFor(target));

    expect(fs.existsSync(`${target.live}-wal`)).toBe(false);
    expect(fs.existsSync(`${target.live}-shm`)).toBe(false);
    expect(rowCount(target.live, "sessions")).toBe(5);
    // What was beside the old database went with it into the copy, untouched.
    expect(fs.readFileSync(`${result.preRestore!.file}-wal`, "utf8")).toBe("left by a gateway that was killed\n");
  });

  it("keeps the raw files of a live database too damaged to read", async () => {
    const target = await scene();
    fs.writeFileSync(target.live, "the registry was overwritten with garbage");
    setDatabaseModified(target.live, QUIET_SINCE);

    const result = await restoreDatabase(optionsFor(target));

    expect(rowCount(target.live, "sessions")).toBe(5);
    expect(fs.readFileSync(result.preRestore!.file, "utf8")).toBe("the registry was overwritten with garbage");
  });

  it("keeps a database that was mid-flight whole, WAL and all, before replacing it", async () => {
    const target = await sceneMidFlight();

    const result = await restoreDatabase(optionsFor(target));

    expect(rowCount(target.live, "sessions")).toBe(5);
    // The eight rows lived mostly in the WAL; the copy has to carry it to have them.
    expect(rowCount(result.preRestore!.file, "sessions")).toBe(8);
  });

  it("leaves no sidecars beside the backup it read", async () => {
    const target = await scene();

    await restoreDatabase(optionsFor(target));

    expect(fs.readdirSync(target.backups).filter((name) => /^sessions-.*-(wal|shm)$/.test(name))).toEqual([]);
  });
});

describe("restoreDatabase, before it will replace anything", () => {
  it("wants the operator's word that the gateway is stopped, and says why and what to do", async () => {
    // Nothing is detected here, and that is the point: a gateway in a container
    // is invisible to a command run on the host against the same bind-mounted
    // home, so "nothing detected" cannot be what lets a database be replaced.
    const target = await scene();

    for (const gatewayStopped of [false, undefined]) {
      const refusal = await refusalOf(optionsFor(target, { gatewayStopped }));

      expect(refusal).toContain("--gateway-stopped");
      expect(refusal).toMatch(/container/);
      expect(refusal).toContain("ryoko stop");
    }
    expect(liveRows(target)).toBe(8);
    expect(listBackups(target.backups).filter((item) => item.preRestore)).toEqual([]);
  });

  it("asks for that word before it looks at anything else", async () => {
    const target = await scene();

    // A backup that does not exist would be the first thing to fail, if it were looked at first.
    const refusal = await refusalOf(optionsFor(target, { gatewayStopped: false, backup: path.join(target.backups, "sessions-2026-01-01.db") }));

    expect(refusal).toContain("--gateway-stopped");
    expect(refusal).not.toMatch(/integrity/);
  });

  it("refuses while a gateway's pid is alive, whatever the operator says, and tells them to stop it", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));

    const refusal = await refusalOf(optionsFor(target, { gatewayStopped: true }));

    expect(refusal).toMatch(/gateway appears to be running/);
    expect(refusal).toContain(`pid ${process.pid}`);
    // One message carries the whole procedure, so stopping it is the only round trip.
    expect(refusal).toContain("ryoko stop");
    expect(refusal).toContain("--gateway-stopped");
    expect(liveRows(target)).toBe(8);
    expect(listBackups(target.backups).filter((item) => item.preRestore)).toEqual([]);
  });

  it("refuses when the registry was written moments ago, the one sign that crosses a container boundary", async () => {
    const target = await sceneMidFlight();
    const justNow = new Date(NOW.getTime() - 12_000);
    fs.utimesSync(`${target.live}-wal`, justNow, justNow);

    const refusal = await refusalOf(optionsFor(target, { gatewayStopped: true }));

    expect(refusal).toMatch(/gateway appears to be running/);
    expect(refusal).toContain("registry.db-wal");
    expect(refusal).toMatch(/12 seconds ago/);
    expect(listBackups(target.backups).filter((item) => item.preRestore)).toEqual([]);
  });

  it("refuses when the workflows store it is about to replace was written moments ago", async () => {
    const target = await scene("workflows");
    const justNow = new Date(NOW.getTime() - 5_000);
    fs.utimesSync(target.live, justNow, justNow);

    const refusal = await refusalOf(optionsFor(target, { name: "workflows" }));

    expect(refusal).toMatch(/gateway appears to be running/);
    expect(refusal).toContain("workflows.db");
    expect(rowCount(target.live, "workflows")).toBe(8);
  });

  it("refuses when writing the copy and the new database would leave the disk too low, on a dry run as well", async () => {
    const target = await sceneMidFlight();
    const before = databaseFingerprint(target.live);
    const total = 100 * 1024 ** 3;
    // Just above what the gateway needs free to keep writing: fine now, not after two database files more.
    const tight = (): DiskSpaceStatus => ({ level: "warning", freeBytes: RESERVE_BYTES + 4096, totalBytes: total, freePercent: 0.25 });
    const roomy = (): DiskSpaceStatus => ({ level: "ok", freeBytes: 50 * 1024 ** 3, totalBytes: total, freePercent: 50 });

    for (const dryRun of [true, false]) {
      const refusal = await refusalOf(optionsFor(target, { dryRun, diskSpace: tight }));
      expect(refusal).toMatch(/not enough free disk space/);
      expect(refusal).toContain("Nothing was changed.");
    }
    expect(databaseFingerprint(target.live)).toEqual(before);
    expect(listBackups(target.backups).filter((item) => item.preRestore)).toEqual([]);

    await restoreDatabase(optionsFor(target, { diskSpace: roomy }));
    expect(rowCount(target.live, "sessions")).toBe(5);
  });

  it("refuses on a dry run too, rather than promising a restore that would be refused", async () => {
    const target = await scene();
    fs.writeFileSync(path.join(target.home, "gateway.pid"), String(process.pid));

    await expect(restoreDatabase(optionsFor(target, { dryRun: true }))).rejects.toThrow(/appears to be running/);
  });

  it("changes nothing on a dry run, which needs no confirmation because it replaces nothing", async () => {
    const target = await scene();
    const before = fs.readdirSync(target.backups).sort();

    const result = await restoreDatabase(optionsFor(target, { dryRun: true, gatewayStopped: false }));

    expect(result).toMatchObject({ dryRun: true, preRestore: null, destination: target.live });
    expect(liveRows(target)).toBe(8);
    expect(fs.readdirSync(target.backups).sort()).toEqual(before);
  });
});

describe("restoreDatabase and a database that may be in use", () => {
  // The live database is never opened to find out whether it is in use, and
  // not on the way to refusing either. Each of these ends without a restore;
  // after each, the main file and both sidecars are byte for byte, timestamp
  // for timestamp, what they were. Row counts would not show the difference:
  // a checkpoint moves rows from the WAL into the main file and loses none,
  // until the gateway that still thinks it owns that WAL writes again.

  it("is not touched by a dry run", async () => {
    const target = await sceneMidFlight();
    const before = databaseFingerprint(target.live);
    expect(Object.values(before)).not.toContain("absent");

    await restoreDatabase(optionsFor(target, { dryRun: true, gatewayStopped: false }));

    expect(databaseFingerprint(target.live)).toEqual(before);
  });

  it("is not touched by the refusal for want of --gateway-stopped", async () => {
    const target = await sceneMidFlight();
    const before = databaseFingerprint(target.live);

    expect(await refusalOf(optionsFor(target, { gatewayStopped: false }))).toContain("--gateway-stopped");

    expect(databaseFingerprint(target.live)).toEqual(before);
  });

  it("is not touched by the refusal because a gateway was detected", async () => {
    const byPid = await sceneMidFlight();
    fs.writeFileSync(path.join(byPid.home, "gateway.json"), JSON.stringify({ port: 7901, pid: process.pid, secret: "s" }));
    const byWrite = await sceneMidFlight();
    const justNow = new Date(NOW.getTime() - 3_000);
    fs.utimesSync(`${byWrite.live}-wal`, justNow, justNow);

    for (const target of [byPid, byWrite]) {
      const before = databaseFingerprint(target.live);

      for (const dryRun of [false, true]) {
        expect(await refusalOf(optionsFor(target, { dryRun }))).toMatch(/appears to be running/);
      }

      expect(databaseFingerprint(target.live)).toEqual(before);
    }
  });
});

describe("restoreDatabase in a home whose directories have been turned into symlinks", () => {
  /** Moves one of the home's directories outside it and leaves a symlink in its place. */
  function relocate(target: Scene, name: string): string {
    const outside = path.join(path.dirname(target.home), `outside-${name}`);
    fs.renameSync(path.join(target.home, name), outside);
    fs.symlinkSync(outside, path.join(target.home, name));
    return outside;
  }

  /** Every file in a directory with a hash of its bytes: what must come out of a refusal exactly as it went in. */
  const contents = (directory: string): Record<string, string> =>
    Object.fromEntries(fs.readdirSync(directory).sort().map((name) => [name, sha256(fs.readFileSync(path.join(directory, name)))]));

  it.each(["sessions", "workflows"] as const)("will not replace the %s database through a directory that leads out of the home", async (name) => {
    // Restoring files never writes through a symlink. Restoring a database
    // did: the new registry was written wherever sessions/ pointed, and the
    // gateway went on to use it there.
    const target = await scene(name);
    const outside = relocate(target, name);
    const before = contents(outside);

    for (const dryRun of [true, false]) {
      const refusal = await refusalOf(optionsFor(target, { name, dryRun }));

      expect(refusal, `dry run: ${dryRun}`).toMatch(new RegExp(`^${name} is a symlink \\(to .*outside-${name}\\)`));
      expect(refusal).toContain("Nothing was changed.");
    }

    expect(contents(outside)).toEqual(before);
    expect(listBackups(target.backups).filter((item) => item.preRestore)).toEqual([]);
  });

  it("will not put the copy of the database it replaces through a backups/ that leads out of the home", async () => {
    const target = await scene();
    const outside = relocate(target, "backups");
    const before = contents(outside);
    const live = databaseFingerprint(target.live);

    const refusal = await refusalOf(optionsFor(target));

    expect(refusal).toMatch(/^backups is a symlink \(to .*outside-backups\)/);
    // What to do about it: a place outside the home is named in the config, not reached through a link.
    expect(refusal).toContain("backup.directory");
    expect(refusal).toContain("Nothing was changed.");
    expect(contents(outside)).toEqual(before);
    expect(databaseFingerprint(target.live)).toEqual(live);
  });

  it("refuses a file standing where one of those directories belongs, too", async () => {
    const target = await scene();
    fs.rmSync(target.backups, { recursive: true });
    const elsewhere = path.join(path.dirname(target.home), "copied-out.db");
    const source = new Database(target.live, { readonly: true });
    await source.backup(elsewhere);
    source.close();
    setDatabaseModified(target.live, QUIET_SINCE);
    fs.writeFileSync(target.backups, "a file sits where the backups should go\n");

    expect(await refusalOf(optionsFor(target, { backup: elsewhere }))).toMatch(/^backups is not a directory/);
    expect(fs.readFileSync(target.backups, "utf8")).toBe("a file sits where the backups should go\n");
  });

  it("uses a backup directory outside the home as it finds it, reached through a link or not", async () => {
    // The operator named it. Only inside the home does this command insist on real directories.
    const target = await scene();
    const root = path.dirname(target.home);
    const real = path.join(root, "external-disk");
    const link = path.join(root, "external-link");
    fs.renameSync(target.backups, real);
    fs.symlinkSync(real, link);

    const result = await restoreDatabase(optionsFor(target, { backup: path.join(link, path.basename(target.backup)), backupDirectory: link }));

    expect(rowCount(target.live, "sessions")).toBe(5);
    expect(result.preRestore!.file).toBe(path.join(link, "pre-restore-20261012T093000Z-sessions.db"));
    expect(rowCount(path.join(real, "pre-restore-20261012T093000Z-sessions.db"), "sessions")).toBe(8);
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
