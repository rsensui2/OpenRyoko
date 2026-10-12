import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectPosixMode, POSIX_MODES_SUPPORTED } from "../../shared/test-support/posix-mode.js";
import type { DiskSpaceStatus } from "../../shared/storage-health.js";
import { inspectHomeArchive } from "../archive.js";
import { archiveStamp, listBackups } from "../catalog.js";
import { runBackup, type BackupRunOptions } from "../run.js";
import { resolveBackupSettings } from "../settings.js";
import { makeHome, removeTempDirs, rowCount, tempDir, writeTree } from "./fixture.js";

const NOW = new Date("2026-10-12T03:00:00.000Z");
const DAY_MS = 86_400_000;
const ROOMY: DiskSpaceStatus = { level: "ok", freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, freePercent: 50 };
const FULL: DiskSpaceStatus = { level: "critical", freeBytes: 12 * 1024 ** 2, totalBytes: 100 * 1024 ** 3, freePercent: 0.01 };

function optionsFor(home: string, config: Parameters<typeof resolveBackupSettings>[0] = {}, extra: Partial<BackupRunOptions> = {}): BackupRunOptions {
  return { home, settings: resolveBackupSettings(config, home), now: NOW, diskSpace: () => ROOMY, ...extra };
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
