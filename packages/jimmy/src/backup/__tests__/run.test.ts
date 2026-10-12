import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectPosixMode, POSIX_MODES_SUPPORTED } from "../../shared/test-support/posix-mode.js";
import type { DiskSpaceStatus } from "../../shared/storage-health.js";
import { inspectHomeArchive } from "../archive.js";
import { archiveStamp, listBackups } from "../catalog.js";
import { readOnlyDatabaseSource } from "../database-source.js";
import { databasePath } from "../layout.js";
import { runBackup, type BackupRunOptions } from "../run.js";
import { resolveBackupSettings } from "../settings.js";
import { damageDatabase, databaseFingerprint, leaveMidFlight, makeHome, removeTempDirs, rowCount, tempDir, writeTree } from "./fixture.js";

const NOW = new Date("2026-10-12T03:00:00.000Z");
const DAY_MS = 86_400_000;
const ROOMY: DiskSpaceStatus = { level: "ok", freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, freePercent: 50 };
const FULL: DiskSpaceStatus = { level: "critical", freeBytes: 12 * 1024 ** 2, totalBytes: 100 * 1024 ** 3, freePercent: 0.01 };
/** Below this much free, the gateway refuses to write to its database (shared/storage-health). */
const RESERVE_BYTES = 256 * 1024 ** 2;

/** A disk with `spare` bytes free above the reserve: not low now, but low after writing more than that. */
function freeAbove(reserve: number, spare: number): DiskSpaceStatus {
  const totalBytes = 100 * 1024 ** 3;
  const freeBytes = reserve + spare;
  return { level: "warning", freeBytes, totalBytes, freePercent: (freeBytes / totalBytes) * 100 };
}

/** A run that is handed both of the home's databases, the way the gateway hands them over. Nothing is opened by default. */
function optionsFor(home: string, config: Parameters<typeof resolveBackupSettings>[0] = {}, extra: Partial<BackupRunOptions> = {}): BackupRunOptions {
  return {
    home,
    settings: resolveBackupSettings(config, home),
    now: NOW,
    diskSpace: () => ROOMY,
    databases: {
      sessions: readOnlyDatabaseSource(databasePath(home, "sessions")),
      workflows: readOnlyDatabaseSource(databasePath(home, "workflows")),
    },
    ...extra,
  };
}

/** The same run with no database handed over at all: what a command gets that was not asked for them. */
function withoutDatabases(home: string, extra: Partial<BackupRunOptions> = {}): BackupRunOptions {
  return { home, settings: resolveBackupSettings({}, home), now: NOW, diskSpace: () => ROOMY, ...extra };
}

const byName = (report: Awaited<ReturnType<typeof runBackup>>) =>
  Object.fromEntries(report.targets.map((target) => [target.name, target]));

afterEach(removeTempDirs);

describe("runBackup", () => {
  it("archives the home and copies both databases into <home>/backups", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 12, workflowRows: 3 });

    const report = await runBackup(optionsFor(home));

    expect(report.status).toBe("ok");
    expect(report.directory).toBe(path.join(home, "backups"));
    expect(report.targets.map((target) => [target.name, target.status])).toEqual([["home", "ok"], ["sessions", "ok"], ["workflows", "ok"]]);
    const targets = byName(report);
    expect(targets.home!.file).toBe(path.join(home, "backups", `home-${archiveStamp(NOW)}.tar.gz`));
    expect((await inspectHomeArchive(targets.home!.file!)).ok).toBe(true);
    expect(rowCount(targets.sessions!.file!, "sessions")).toBe(12);
    expect(rowCount(targets.workflows!.file!, "workflows")).toBe(3);
    for (const target of report.targets) {
      expect(target.bytes, target.name).toBe(fs.statSync(target.file!).size);
      expectPosixMode(target.file!, 0o600);
    }
  });

  it("skips a database the home does not have, without calling that a failure", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 2 });

    const report = await runBackup(optionsFor(home));

    expect(report.status).toBe("ok");
    expect(byName(report).workflows).toMatchObject({ status: "skipped", detail: expect.stringMatching(/no database/) });
    expect(fs.readdirSync(path.join(home, "backups")).filter((name) => name.startsWith("workflows-"))).toEqual([]);
  });

  it("copies each database once a day but archives the home every time it is asked", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 2, workflowRows: 1 });
    await runBackup(optionsFor(home));

    const again = await runBackup(optionsFor(home, {}, { now: new Date(NOW.getTime() + 60_000) }));

    expect(again.status).toBe("ok");
    expect(byName(again).home!.status).toBe("ok");
    expect(byName(again).sessions).toMatchObject({ status: "skipped", detail: expect.stringMatching(/already/) });
    // It says when the copy it found was made, so that is what gets remembered as the last one.
    expect(byName(again).sessions!.copiedAt).toBe(fs.statSync(byName(again).sessions!.file!).mtime.toISOString());
    expect(byName(again).workflows!.status).toBe("skipped");
    expect(listBackups(path.join(home, "backups")).filter((item) => item.kind === "home")).toHaveLength(2);
  });

  it("carries on past a database that fails, and reports the run as failed", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 4 });
    writeTree(home, { "workflows/workflows.db": "this is not a database" });

    const report = await runBackup(optionsFor(home));

    expect(report.status).toBe("failed");
    const targets = byName(report);
    expect(targets.workflows).toMatchObject({ status: "failed", error: expect.any(String) });
    expect(targets.home!.status).toBe("ok");
    expect(targets.sessions!.status).toBe("ok");
    expect(rowCount(targets.sessions!.file!, "sessions")).toBe(4);
    expect(fs.readdirSync(path.join(home, "backups")).filter((name) => name.includes("workflows"))).toEqual([]);
  });

  it("carries on past a home that is too large to archive, the first target in line", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 4, workflowRows: 2 });
    writeTree(home, { "knowledge/dump.bin": "x".repeat(3 * 1024 * 1024) });

    const report = await runBackup(optionsFor(home, { maxArchiveMb: 1 }));

    expect(report.status).toBe("failed");
    expect(report.targets.map((target) => [target.name, target.status])).toEqual([["home", "failed"], ["sessions", "ok"], ["workflows", "ok"]]);
    expect(byName(report).home!.error).toMatch(/over the 1\.0 MB limit/);
    expect(listBackups(path.join(home, "backups")).map((item) => item.kind).sort()).toEqual(["sessions", "workflows"]);
  });

  it("marks a failure that trying again cannot change, and only that kind", async () => {
    const root = tempDir();
    const tooLarge = makeHome(root, "too-large", { sessionRows: 1 });
    writeTree(tooLarge, { "knowledge/dump.bin": "x".repeat(3 * 1024 * 1024), "workflows/workflows.db": "this is not a database" });
    const empty = path.join(root, "empty");
    writeTree(empty, { "logs/gateway.log": "nothing here is an archive target\n" });

    const overCap = byName(await runBackup(optionsFor(tooLarge, { maxArchiveMb: 1 })));
    const nothing = byName(await runBackup(optionsFor(empty)));
    const diskFull = byName(await runBackup(optionsFor(makeHome(root, "full"), {}, { diskSpace: () => FULL })));

    const crowded = makeHome(root, "crowded", { sessionRows: 1 });
    writeTree(crowded, Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`skills/flood/empty-${index}`, ""])));
    const overCount = byName(await runBackup(optionsFor(crowded, { maxEntries: 100 })));

    // The home will be just as large an hour from now, and just as empty.
    expect(overCap.home).toMatchObject({ status: "failed", persistent: true });
    // Three hundred empty files weigh nothing, so only the entry limit can stop them.
    expect(overCount.home).toMatchObject({ status: "failed", persistent: true, error: expect.stringMatching(/backup\.maxEntries/) });
    expect(overCount.sessions!.status).toBe("ok");
    expect(nothing.home).toMatchObject({ status: "failed", persistent: true, error: expect.stringMatching(/nothing to archive/) });
    // A database that cannot be read, or a disk that is full, may well be fine by then.
    expect(overCap.workflows!.status).toBe("failed");
    expect(overCap.workflows!.persistent).toBeUndefined();
    expect(diskFull.home!.status).toBe("failed");
    expect(diskFull.home!.persistent).toBeUndefined();
    expect(overCap.sessions!.persistent).toBeUndefined();
  });

  it("writes nothing when the disk is nearly full, and still trims what has expired", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 4 });
    const directory = path.join(home, "backups");
    const expired = [3, 2, 1].map((daysAgo) => `home-${archiveStamp(new Date(NOW.getTime() - daysAgo * DAY_MS))}.tar.gz`);
    writeTree(directory, Object.fromEntries(expired.map((name) => [name, "older archive"])));
    const probed: string[] = [];

    const report = await runBackup(optionsFor(home, { retention: 2 }, {
      diskSpace: (target) => { probed.push(target); return FULL; },
    }));

    expect(probed).toEqual([directory]);
    expect(report.status).toBe("failed");
    for (const target of report.targets) {
      expect(target, target.name).toMatchObject({ status: "failed", error: expect.stringMatching(/free disk space.*12 MiB/s) });
    }
    // The two newest archives stay, and so does the file that is not a backup.
    expect(fs.readdirSync(directory).sort()).toEqual([...expired.slice(1), "older-notes.txt"].sort());
    expect(report.pruned).toEqual([path.join(directory, expired[0]!)]);
  });

  it("does not start a copy that would leave the disk too low for the gateway to keep writing", async () => {
    // 300 MiB free and a 400 MB registry: "more than 256 MiB free" was true
    // when the copy started and false long before it finished, and for as long
    // as it ran the gateway refused to create sessions or store messages.
    const home = makeHome(tempDir(), "home", { sessionRows: 6000, workflowRows: 5 });
    const directory = path.join(home, "backups");
    const spare = 96 * 1024;
    expect(fs.statSync(path.join(home, "sessions", "registry.db")).size).toBeGreaterThan(spare);

    const report = await runBackup(optionsFor(home, {}, { diskSpace: () => freeAbove(RESERVE_BYTES, spare) }));

    const targets = byName(report);
    // The home and the small workflows store fit in the 96 KB to spare; the registry does not.
    expect(targets.home!.status).toBe("ok");
    expect(targets.sessions).toMatchObject({ status: "failed", error: expect.stringMatching(/not enough free disk space/) });
    expect(targets.sessions!.error).toContain(directory);
    expect(targets.sessions!.persistent).toBeUndefined();
    expect(targets.workflows!.status).toBe("ok");
    expect(fs.readdirSync(directory).filter((name) => name.startsWith("sessions-"))).toEqual([]);
  });

  it("counts what the run has already written against the space the next target needs", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 6000, workflowRows: 6000 });
    const each = fs.statSync(path.join(home, "sessions", "registry.db")).size;

    // Room for the home and one database with a little over, but not for two.
    const report = await runBackup(optionsFor(home, {}, { diskSpace: () => freeAbove(RESERVE_BYTES, Math.floor(each * 1.6)) }));

    expect(report.targets.map((target) => [target.name, target.status])).toEqual([["home", "ok"], ["sessions", "ok"], ["workflows", "failed"]]);
    expect(byName(report).workflows!.error).toMatch(/not enough free disk space/);
  });

  it("does not ask for space when there is nothing to write", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 6000 });
    await runBackup(optionsFor(home));

    // The same day again: the registry copy exists, so the registry's size is beside the point.
    const again = await runBackup(optionsFor(home, {}, {
      now: new Date(NOW.getTime() + 60_000), diskSpace: () => freeAbove(RESERVE_BYTES, 96 * 1024),
    }));

    expect(byName(again).sessions).toMatchObject({ status: "skipped", detail: expect.stringMatching(/already/) });
    expect(byName(again).home!.status).toBe("ok");
  });

  it("fails every target, without throwing, when the directory cannot be created", async () => {
    const root = tempDir();
    const home = makeHome(root, "home", { sessionRows: 1 });
    const blocked = path.join(root, "not-a-directory");
    fs.writeFileSync(blocked, "a file sits where the backups should go\n");

    const report = await runBackup(optionsFor(home, { directory: blocked }));

    expect(report.status).toBe("failed");
    expect(report.targets.map((target) => target.status)).toEqual(["failed", "failed", "failed"]);
    expect(report.targets[0]!.error).toMatch(/not-a-directory/);
    expect(fs.readFileSync(blocked, "utf8")).toBe("a file sits where the backups should go\n");
  });

  it("keeps the configured number of archives, counting the one it just wrote", async () => {
    const home = makeHome(tempDir(), "home");
    const directory = path.join(home, "backups");
    const older = [3, 2, 1].map((daysAgo) => `home-${archiveStamp(new Date(NOW.getTime() - daysAgo * DAY_MS))}.tar.gz`);
    writeTree(directory, Object.fromEntries(older.map((name) => [name, "older archive"])));

    const report = await runBackup(optionsFor(home, { retention: 2 }));

    expect(listBackups(directory).filter((item) => item.kind === "home").map((item) => path.basename(item.file))).toEqual([
      `home-${archiveStamp(NOW)}.tar.gz`, older[2],
    ]);
    expect(report.pruned.map((file) => path.basename(file)).sort()).toEqual(older.slice(0, 2).sort());
  });

  it("keeps the archive it has just written when the clock is behind the archives already there", async () => {
    // A fortnight of archives, and then a clock that has jumped back a month.
    // By its name the new archive is the oldest there and past its keep; it
    // was written, reported as ok, counted as today's - and deleted.
    const home = makeHome(tempDir(), "home", { sessionRows: 2 });
    const directory = path.join(home, "backups");
    const existing = Array.from({ length: 14 }, (_, daysAgo) => `home-${archiveStamp(new Date(NOW.getTime() - daysAgo * DAY_MS))}.tar.gz`);
    writeTree(directory, Object.fromEntries(existing.map((name) => [name, "an archive from before the clock moved"])));

    const report = await runBackup(optionsFor(home, {}, { now: new Date(NOW.getTime() - 30 * DAY_MS) }));

    const written = byName(report).home!;
    expect(written.status).toBe("ok");
    expect(fs.existsSync(written.file!)).toBe(true);
    expect((await inspectHomeArchive(written.file!)).ok).toBe(true);
    expect(fs.existsSync(byName(report).sessions!.file!)).toBe(true);
    expect(report.pruned).toEqual([]);
    expect(listBackups(directory).filter((item) => item.kind === "home")).toHaveLength(15);
  });

  it("leaves each of five backups taken in the same second in place when its own run ends", async () => {
    const home = makeHome(tempDir(), "home");
    const directory = path.join(home, "backups");
    const written: string[] = [];

    for (let round = 1; round <= 5; round += 1) {
      const report = await runBackup(optionsFor(home));
      const file = byName(report).home!.file!;
      expect(fs.existsSync(file), `the archive of round ${round}`).toBe(true);
      expect(report.pruned).not.toContain(file);
      written.push(file);
    }

    // No name handed out twice, and of the five the three most recent are what is left.
    expect(new Set(written).size).toBe(5);
    expect(listBackups(directory).filter((item) => item.kind === "home").map((item) => item.file)).toEqual(written.slice(2).reverse());
  });

  it("runs only the targets it is asked for", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 1, workflowRows: 1 });

    const report = await runBackup(optionsFor(home, {}, { targets: ["workflows"] }));

    expect(report.targets.map((target) => target.name)).toEqual(["workflows"]);
    expect(listBackups(path.join(home, "backups")).map((item) => item.kind)).toEqual(["workflows"]);
  });

  it("copies through a connection it is handed and gives it back afterwards", async () => {
    const home = makeHome(tempDir(), "home");
    const live = new Database(":memory:");
    live.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO sessions (label) VALUES ('held by the gateway')");
    let released = 0;
    try {
      const report = await runBackup(optionsFor(home, {}, {
        targets: ["sessions"],
        databases: { sessions: () => ({ database: live, release: () => { released += 1; } }) },
      }));

      expect(byName(report).sessions!.status).toBe("ok");
      expect(rowCount(byName(report).sessions!.file!, "sessions")).toBe(1);
      expect(released).toBe(1);
      expect(live.open).toBe(true);
    } finally {
      live.close();
    }
  });

  it("writes to a directory outside the home when the config names one", async () => {
    const root = tempDir();
    const home = makeHome(root, "home", { sessionRows: 1 });
    const outside = path.join(root, "external-disk", "ryoko");
    fs.rmSync(path.join(home, "backups"), { recursive: true });

    const report = await runBackup(optionsFor(home, { directory: outside }));

    expect(report.status).toBe("ok");
    expect(report.directory).toBe(outside);
    expect(listBackups(outside).map((item) => item.kind).sort()).toEqual(["home", "sessions"]);
    expect(fs.existsSync(path.join(home, "backups"))).toBe(false);
  });

  it("does not archive its own output when the directory sits inside an archived target", async () => {
    const home = makeHome(tempDir(), "home");
    const nested = path.join(home, "knowledge", "backups");
    await runBackup(optionsFor(home, { directory: nested }));

    const second = await runBackup(optionsFor(home, { directory: nested }, { now: new Date(NOW.getTime() + 60_000) }));
    const inspection = await inspectHomeArchive(byName(second).home!.file!);

    expect(inspection.ok).toBe(true);
    expect(inspection.manifest!.entries.filter((entry) => entry.path.startsWith("knowledge/backups"))).toEqual([]);
  });

  it("throws away a database copy that fails SQLite's integrity check, and leaves the target for the next daily run", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 4, workflowRows: 2000 });
    damageDatabase(path.join(home, "workflows", "workflows.db"));

    const report = await runBackup(optionsFor(home));

    expect(report.status).toBe("failed");
    const targets = byName(report);
    // The store is damaged now and will be in an hour: copying it again every hour changes nothing.
    expect(targets.workflows).toMatchObject({ status: "failed", persistent: true, error: expect.stringMatching(/integrity check.*discarded/s) });
    expect(targets.home!.status).toBe("ok");
    expect(targets.sessions!.status).toBe("ok");
    expect(fs.readdirSync(path.join(home, "backups")).filter((name) => name.includes("workflows"))).toEqual([]);
  });

  it("does not trim the earlier copies of a database on the day its copy fails the check", async () => {
    const home = makeHome(tempDir(), "home", { workflowRows: 2000 });
    const directory = path.join(home, "backups");
    const earlier = Array.from({ length: 9 }, (_, index) => `workflows-2026-10-${String(index + 1).padStart(2, "0")}.db`);
    writeTree(directory, Object.fromEntries(earlier.map((name) => [name, `the copy named ${name}`])));
    damageDatabase(path.join(home, "workflows", "workflows.db"));

    const report = await runBackup(optionsFor(home));

    expect(byName(report).workflows).toMatchObject({ status: "failed", persistent: true });
    // Nine, where seven are kept: more than a run that succeeded would leave, and all of them still here.
    expect(fs.readdirSync(directory).filter((name) => name.startsWith("workflows-")).sort()).toEqual(earlier);
    expect(report.pruned.filter((file) => path.basename(file).startsWith("workflows-"))).toEqual([]);
  });

  it("keeps a copy it could not check, and says so as a warning rather than a failure", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 4 });

    const report = await runBackup(optionsFor(home, {}, {
      checkDatabaseCopy: () => Promise.reject(new Error("the integrity check could not be run: no worker threads")),
    }));

    expect(report.status).toBe("ok");
    expect(byName(report).sessions).toMatchObject({
      status: "ok", warnings: [expect.stringMatching(/kept without being checked.*no worker threads/)],
    });
    expect(rowCount(byName(report).sessions!.file!, "sessions")).toBe(4);
  });

  it("opens no database it was handed no source for, and does not call that a copy", async () => {
    // Opening a database file is the caller's decision, never this function's
    // default: read-only or not, a connection writes beside a database in use.
    const home = makeHome(tempDir());
    const live = [path.join(home, "sessions", "registry.db"), path.join(home, "workflows", "workflows.db")];
    leaveMidFlight(live[0]!, "sessions", 5);
    leaveMidFlight(live[1]!, "workflows", 3);
    const before = live.map(databaseFingerprint);

    const report = await runBackup(withoutDatabases(home));

    expect(report.status).toBe("ok");
    expect(report.targets.map((target) => [target.name, target.status])).toEqual([["home", "ok"], ["sessions", "withheld"], ["workflows", "withheld"]]);
    expect(byName(report).sessions).toMatchObject({ reason: "not-requested", detail: expect.any(String) });
    expect(live.map(databaseFingerprint)).toEqual(before);
    expect(listBackups(path.join(home, "backups")).map((item) => item.kind)).toEqual(["home"]);
  });

  it("says a database is absent, not withheld, when the home has none", async () => {
    const report = await runBackup(withoutDatabases(makeHome(tempDir())));

    for (const name of ["sessions", "workflows"] as const) {
      expect(byName(report)[name], name).toMatchObject({ status: "skipped", detail: expect.stringMatching(/no database/) });
    }
  });

  it("reports today's copy without opening the database a second time", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 2, workflowRows: 1 });
    await runBackup(optionsFor(home));
    let opened = 0;
    const counting = (): never => {
      opened += 1;
      throw new Error("the database was opened although there was nothing left to copy");
    };

    const again = await runBackup(optionsFor(home, {}, {
      now: new Date(NOW.getTime() + 60_000), databases: { sessions: counting, workflows: counting },
    }));

    expect(opened).toBe(0);
    expect(byName(again).sessions).toMatchObject({ status: "skipped", detail: expect.stringMatching(/already/) });
    expect(byName(again).sessions!.copiedAt).toBe(fs.statSync(byName(again).sessions!.file!).mtime.toISOString());
    // With no source at all it is still today's copy that gets reported, not "withheld".
    const unasked = await runBackup(withoutDatabases(home, { now: new Date(NOW.getTime() + 120_000) }));
    expect(byName(unasked).sessions).toMatchObject({ status: "skipped", detail: expect.stringMatching(/already/) });
  });

  it("passes on a source's refusal, and calls the run incomplete rather than ok or failed", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 2, workflowRows: 1 });
    const refusal = { withheld: "gateway-running" as const, detail: "a gateway appears to be running on this home" };

    const report = await runBackup(optionsFor(home, {}, { databases: { sessions: () => refusal, workflows: () => refusal } }));

    expect(report.status).toBe("incomplete");
    expect(byName(report).home!.status).toBe("ok");
    expect(byName(report).sessions).toEqual({
      name: "sessions", status: "withheld", reason: "gateway-running", detail: "a gateway appears to be running on this home", warnings: [],
    });
    expect(listBackups(path.join(home, "backups")).map((item) => item.kind)).toEqual(["home"]);
  });

  it("is failed, not incomplete, when something failed beside what was withheld", async () => {
    const home = makeHome(tempDir(), "home", { sessionRows: 2 });
    writeTree(home, { "knowledge/dump.bin": "x".repeat(3 * 1024 * 1024) });
    const refusal = { withheld: "gateway-running" as const, detail: "a gateway appears to be running on this home" };

    const report = await runBackup(optionsFor(home, { maxArchiveMb: 1 }, { databases: { sessions: () => refusal } }));

    expect(report.status).toBe("failed");
    expect(report.targets.map((target) => target.status)).toEqual(["failed", "withheld", "skipped"]);
  });

  it.skipIf(!POSIX_MODES_SUPPORTED)("tightens its own backups directory but leaves one the operator chose as it is", async () => {
    const root = tempDir();
    const home = makeHome(root, "home");
    const shared = path.join(root, "shared");
    fs.mkdirSync(shared);
    const previousUmask = process.umask(0);
    try {
      fs.chmodSync(path.join(home, "backups"), 0o755);
      fs.chmodSync(shared, 0o755);

      await runBackup(optionsFor(home));
      const elsewhere = await runBackup(optionsFor(home, { directory: shared }));

      expectPosixMode(path.join(home, "backups"), 0o700);
      expectPosixMode(shared, 0o755);
      expectPosixMode(byName(elsewhere).home!.file!, 0o600);
    } finally {
      process.umask(previousUmask);
    }
  });
});
