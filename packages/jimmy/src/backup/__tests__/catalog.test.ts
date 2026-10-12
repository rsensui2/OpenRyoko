import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveStamp,
  findBackup,
  listBackups,
  pruneBackups,
  reserveArchiveName,
  reserveDatabaseSnapshotName,
  SAME_DAY_BACKUPS_KEPT,
} from "../catalog.js";
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

  it("looks through a crowded directory without taking every name into memory at once", () => {
    // The gateway lists this directory after every backup. Whatever else has
    // been dropped into it must not be read in as one array of names.
    const directory = tempDir();
    seed(directory, "home-20261012T030000Z.tar.gz");
    // A few dozen are enough to show how it reads; how many there are is not what is being tested.
    for (let index = 0; index < 40; index += 1) fs.writeFileSync(path.join(directory, `dropped-here-${index}.bin`), "x");
    const wholeListing = vi.spyOn(fs, "readdirSync");

    const items = listBackups(directory);
    const removed = pruneBackups(directory, { retention: 14, now: NOW });
    const calls = wholeListing.mock.calls.length;
    wholeListing.mockRestore();

    expect(items.map((item) => item.id)).toEqual(["home-20261012T030000Z"]);
    expect(removed).toEqual([]);
    expect(calls).toBe(0);
  });

  it("stops collecting once a directory holds more backups than could be real, and still trims them", () => {
    const directory = tempDir();
    const stamps = Array.from({ length: 60 }, (_, index) => archiveStamp(new Date(NOW.getTime() - index * DAY_MS)));
    for (const stamp of stamps) seed(directory, `home-${stamp}.tar.gz`, 1);

    expect(listBackups(directory, { maxItems: 25 })).toHaveLength(25);
    expect(listBackups(directory)).toHaveLength(60);
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

/** An archive name for a moment `hoursAgo` hours before NOW (03:00 UTC), so several can share a day. */
const archiveAt = (prefix: string, hoursAgo: number): string =>
  `${prefix}-${archiveStamp(new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000))}.tar.gz`;

describe("pruneBackups", () => {
  it("keeps as many days of archives as retention says, and removes the days before them", () => {
    const directory = tempDir();
    for (let daysAgo = 0; daysAgo < 6; daysAgo += 1) seed(directory, archiveName("home", daysAgo));

    const removed = pruneBackups(directory, { retention: 4, now: NOW });

    expect(removed.map((file) => path.basename(file)).sort()).toEqual([archiveName("home", 4), archiveName("home", 5)].sort());
    expect(fs.readdirSync(directory).sort()).toEqual([0, 1, 2, 3].map((daysAgo) => archiveName("home", daysAgo)).sort());
  });

  it("does not let a burst of backups in one day push out the days before it", () => {
    // Retention used to be a count. Fourteen `ryoko backup run` in an afternoon
    // - an agent being careful before each change - and yesterday's archive was
    // gone, along with every day before it.
    const directory = tempDir();
    seed(directory, archiveName("home", 2));
    seed(directory, archiveName("home", 1));
    const today = Array.from({ length: 14 }, (_, index) => archiveAt("home", index * 0.2));
    for (const name of today) seed(directory, name);

    const removed = pruneBackups(directory, { retention: 14, now: NOW });

    // Both earlier days are still there, and of today only the three most recent.
    expect(fs.readdirSync(directory).sort()).toEqual([archiveName("home", 2), archiveName("home", 1), ...today.slice(0, 3)].sort());
    expect(removed).toHaveLength(11);
    expect(SAME_DAY_BACKUPS_KEPT).toBe(3);
  });

  it("counts days that have a backup, so a gap in the dates costs nothing", () => {
    const directory = tempDir();
    for (const daysAgo of [0, 1, 20, 21, 40]) seed(directory, archiveName("home", daysAgo));

    pruneBackups(directory, { retention: 3, now: NOW });

    // Three days of history, however long ago the third one was.
    expect(fs.readdirSync(directory).sort()).toEqual([0, 1, 20].map((daysAgo) => archiveName("home", daysAgo)).sort());
  });

  it("keeps the latest of every day it keeps, whatever else it trims from that day", () => {
    const directory = tempDir();
    const yesterday = Array.from({ length: 5 }, (_, index) => archiveAt("home", 24 + index * 0.5));
    for (const name of [archiveAt("home", 0), archiveAt("home", 1), ...yesterday, archiveAt("home", 72)]) seed(directory, name);

    pruneBackups(directory, { retention: 2, now: NOW });

    expect(fs.readdirSync(directory).sort()).toEqual([archiveAt("home", 0), archiveAt("home", 1), ...yesterday.slice(0, 3)].sort());
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

  it("keeps seven days of pre-restore database copies and takes their sidecars with the ones it drops", () => {
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

  it("holds pre-restore snapshots to the same rule: three of a day, however many restores there were", () => {
    const directory = tempDir();
    const archives = Array.from({ length: 6 }, (_, index) => archiveAt("pre-restore", index * 0.1));
    const copies = Array.from({ length: 5 }, (_, index) => `pre-restore-${archiveStamp(new Date(NOW.getTime() - index * 60_000))}-sessions.db`);
    for (const name of [...archives, ...copies, archiveName("pre-restore", 1)]) seed(directory, name);

    pruneBackups(directory, { retention: 14, now: NOW });

    expect(fs.readdirSync(directory).sort()).toEqual([...archives.slice(0, 3), ...copies.slice(0, 3), archiveName("pre-restore", 1)].sort());
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
    seed(directory, "backup-state.json.4242.deadbeef.tmp", 8, 2);
    seed(directory, ".home-20261012T030000Z.tar.gz.tmp-4243-cafef00d", 8, 0);
    seed(directory, "important.tmp-notes", 8, 9);

    const removed = pruneBackups(directory, { retention: 14, now: NOW });

    expect(removed.map((file) => path.basename(file)).sort()).toEqual([
      ".home-20261010T030000Z.tar.gz.tmp-4242-deadbeef", "backup-state.json.4242.deadbeef.tmp", "sessions-2026-10-10.db.tmp-4242",
    ].sort());
    expect(fs.readdirSync(directory).sort()).toEqual([".home-20261012T030000Z.tar.gz.tmp-4243-cafef00d", "important.tmp-notes"].sort());
  });

  it("does nothing when the directory does not exist", () => {
    expect(pruneBackups(path.join(tempDir(), "never-created"), { retention: 14, now: NOW })).toEqual([]);
  });
});
