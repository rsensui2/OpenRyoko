import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveStamp, findBackup, listBackups, pruneBackups, reserveArchiveName, reserveDatabaseSnapshotName } from "../catalog.js";
import { removeTempDirs, tempDir } from "./fixture.js";

const NOW = new Date("2026-10-12T03:00:00.000Z");
const DAY_MS = 86_400_000;

function seed(directory: string, name: string, bytes = 8, ageDays = 0): string {
  const file = path.join(directory, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, "x".repeat(bytes));
  const when = new Date(NOW.getTime() - ageDays * DAY_MS);
  fs.utimesSync(file, when, when);
  return file;
}

const archiveName = (prefix: string, daysAgo: number, suffix = ""): string =>
  `${prefix}-${archiveStamp(new Date(NOW.getTime() - daysAgo * DAY_MS))}${suffix}.tar.gz`;

afterEach(removeTempDirs);

describe("archiveStamp", () => {
  it("is a compact UTC timestamp that sorts chronologically", () => {
    expect(archiveStamp(NOW)).toBe("20261012T030000Z");
    expect(archiveStamp(new Date("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
  });
});

describe("listBackups", () => {
  it("names every kind of backup and ignores everything else", () => {
    const directory = tempDir();
    seed(directory, "home-20261012T030000Z.tar.gz", 100);
    seed(directory, "home-20261011T030000Z-2.tar.gz", 90);
    seed(directory, "pre-restore-20261012T040000Z.tar.gz", 80);
    seed(directory, "sessions-2026-10-12.db", 70);
    seed(directory, "workflows-2026-10-12.db", 60);
    seed(directory, "pre-restore-20261012T040000Z-sessions.db", 50);
    for (const ignored of [
      "sessions-2026-10-12.db-wal", "sessions-2026-10-12.db-shm", "sessions-2026-10-12.db.tmp-123",
      ".home-20261012T030000Z.tar.gz.tmp-123-abcd", "backup-state.json", "notes.txt", "home-latest.tar.gz",
      "home-20261012T030000Z.tar", "sessions-2026-10-12.sqlite",
    ]) seed(directory, ignored);
    fs.mkdirSync(path.join(directory, "home-20261010T030000Z.tar.gz"));
    fs.symlinkSync(path.join(directory, "notes.txt"), path.join(directory, "home-20261009T030000Z.tar.gz"));

    const items = listBackups(directory);

    expect(items.map(({ id, kind, preRestore, bytes }) => ({ id, kind, preRestore, bytes }))).toEqual(expect.arrayContaining([
      { id: "home-20261012T030000Z", kind: "home", preRestore: false, bytes: 100 },
      { id: "home-20261011T030000Z-2", kind: "home", preRestore: false, bytes: 90 },
      { id: "pre-restore-20261012T040000Z", kind: "home", preRestore: true, bytes: 80 },
      { id: "sessions-2026-10-12", kind: "sessions", preRestore: false, bytes: 70 },
      { id: "workflows-2026-10-12", kind: "workflows", preRestore: false, bytes: 60 },
      { id: "pre-restore-20261012T040000Z-sessions", kind: "sessions", preRestore: true, bytes: 50 },
    ]));
    expect(items).toHaveLength(6);
    expect(items.find((item) => item.id === "home-20261012T030000Z")).toMatchObject({
      file: path.join(directory, "home-20261012T030000Z.tar.gz"), createdAt: "2026-10-12T03:00:00.000Z",
    });
  });

  it("lists the newest first", () => {
    const directory = tempDir();
    seed(directory, archiveName("home", 2));
    seed(directory, archiveName("home", 0));
    seed(directory, archiveName("home", 1));
    seed(directory, archiveName("home", 1, "-2"));

    expect(listBackups(directory).map((item) => item.id)).toEqual([
      `home-${archiveStamp(NOW)}`,
      `home-${archiveStamp(new Date(NOW.getTime() - DAY_MS))}-2`,
      `home-${archiveStamp(new Date(NOW.getTime() - DAY_MS))}`,
      `home-${archiveStamp(new Date(NOW.getTime() - 2 * DAY_MS))}`,
    ]);
  });

  it("is empty for a directory that does not exist yet", () => {
    expect(listBackups(path.join(tempDir(), "never-created"))).toEqual([]);
  });
});

describe("reserveArchiveName", () => {
  it("names an archive after the moment it was taken", () => {
    const directory = tempDir();

    expect(reserveArchiveName(directory, "home", NOW)).toEqual({
      id: "home-20261012T030000Z", file: path.join(directory, "home-20261012T030000Z.tar.gz"),
    });
  });

  it("never reuses a name, so a second snapshot in the same second cannot replace the first", () => {
    const directory = tempDir();
    seed(directory, "pre-restore-20261012T030000Z.tar.gz");
    seed(directory, "pre-restore-20261012T030000Z-2.tar.gz");

    expect(reserveArchiveName(directory, "pre-restore", NOW).id).toBe("pre-restore-20261012T030000Z-3");
    expect(reserveDatabaseSnapshotName(directory, "sessions", NOW)).toEqual({
      id: "pre-restore-20261012T030000Z-sessions", file: path.join(directory, "pre-restore-20261012T030000Z-sessions.db"),
    });
  });
});

describe("findBackup", () => {
  it("finds a backup by id, by file name and by path", () => {
    const directory = tempDir();
    const elsewhere = tempDir();
    seed(directory, "home-20261012T030000Z.tar.gz");
    seed(directory, "sessions-2026-10-12.db");
    const copied = seed(elsewhere, "home-20261001T000000Z.tar.gz");

    expect(findBackup(directory, "home-20261012T030000Z").file).toBe(path.join(directory, "home-20261012T030000Z.tar.gz"));
    expect(findBackup(directory, "home-20261012T030000Z.tar.gz").id).toBe("home-20261012T030000Z");
    expect(findBackup(directory, "sessions-2026-10-12")).toMatchObject({ kind: "sessions", preRestore: false });
    expect(findBackup(directory, copied)).toMatchObject({ id: "home-20261001T000000Z", kind: "home", file: copied });
  });

  it("says where to look when nothing matches", () => {
    const directory = tempDir();
    const stray = seed(directory, "notes.txt");

    expect(() => findBackup(directory, "home-20991231T000000Z")).toThrow(/no backup.*home-20991231T000000Z.*ryoko backup list/s);
    expect(() => findBackup(directory, stray)).toThrow(/not a backup/);
    expect(() => findBackup(directory, path.join(directory, "home-20991231T000000Z.tar.gz"))).toThrow(/no backup/);
  });
});

describe("pruneBackups", () => {
  it("keeps the configured number of archives and removes the oldest beyond it", () => {
    const directory = tempDir();
    for (let daysAgo = 0; daysAgo < 6; daysAgo += 1) seed(directory, archiveName("home", daysAgo));

    const removed = pruneBackups(directory, { retention: 4, now: NOW });

    expect(removed.map((file) => path.basename(file)).sort()).toEqual([archiveName("home", 4), archiveName("home", 5)].sort());
    expect(fs.readdirSync(directory).sort()).toEqual([0, 1, 2, 3].map((daysAgo) => archiveName("home", daysAgo)).sort());
  });

  it("counts pre-restore snapshots apart from the daily archives", () => {
    const directory = tempDir();
    for (let daysAgo = 0; daysAgo < 3; daysAgo += 1) {
      seed(directory, archiveName("home", daysAgo));
      seed(directory, archiveName("pre-restore", daysAgo));
    }

    pruneBackups(directory, { retention: 2, now: NOW });

    expect(fs.readdirSync(directory).sort()).toEqual([
      archiveName("home", 0), archiveName("home", 1), archiveName("pre-restore", 0), archiveName("pre-restore", 1),
    ].sort());
  });

  it("keeps seven pre-restore database copies and takes their sidecars with the ones it drops", () => {
    const directory = tempDir();
    const stamps = Array.from({ length: 9 }, (_, daysAgo) => archiveStamp(new Date(NOW.getTime() - daysAgo * DAY_MS)));
    for (const stamp of stamps) seed(directory, `pre-restore-${stamp}-sessions.db`);
    seed(directory, `pre-restore-${stamps[8]}-sessions.db-wal`);
    seed(directory, `pre-restore-${stamps[0]}-workflows.db`);

    pruneBackups(directory, { retention: 14, now: NOW });

    expect(fs.readdirSync(directory).sort()).toEqual([
      ...stamps.slice(0, 7).map((stamp) => `pre-restore-${stamp}-sessions.db`),
      `pre-restore-${stamps[0]}-workflows.db`,
    ].sort());
  });

  it("leaves the daily database backups and anything it does not recognise alone", () => {
    const directory = tempDir();
    const kept = ["sessions-2026-10-01.db", "workflows-2026-10-01.db", "notes.txt", "backup-state.json", "home-latest.tar.gz"];
    for (const name of kept) seed(directory, name, 8, 30);
    for (let daysAgo = 0; daysAgo < 3; daysAgo += 1) seed(directory, archiveName("home", daysAgo));

    pruneBackups(directory, { retention: 1, now: NOW });

    expect(fs.readdirSync(directory).sort()).toEqual([...kept, archiveName("home", 0)].sort());
  });

  it("sweeps temporary files a killed run left behind, once they are a day old", () => {
    const directory = tempDir();
    seed(directory, ".home-20261010T030000Z.tar.gz.tmp-4242-deadbeef", 8, 2);
    seed(directory, "sessions-2026-10-10.db.tmp-4242", 8, 2);
    seed(directory, ".home-20261012T030000Z.tar.gz.tmp-4243-cafef00d", 8, 0);
    seed(directory, "important.tmp-notes", 8, 9);

    const removed = pruneBackups(directory, { retention: 14, now: NOW });

    expect(removed.map((file) => path.basename(file)).sort()).toEqual(
      [".home-20261010T030000Z.tar.gz.tmp-4242-deadbeef", "sessions-2026-10-10.db.tmp-4242"].sort(),
    );
    expect(fs.readdirSync(directory).sort()).toEqual([".home-20261012T030000Z.tar.gz.tmp-4243-cafef00d", "important.tmp-notes"].sort());
  });

  it("does nothing when the directory does not exist", () => {
    expect(pruneBackups(path.join(tempDir(), "never-created"), { retention: 14, now: NOW })).toEqual([]);
  });
});
