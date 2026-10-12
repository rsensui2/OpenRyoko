import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { damageDatabase } from "../../backup/__tests__/fixture.js";
import { createDailyDatabaseBackup, DatabaseCopyDamagedError } from "../backup.js";
import { findDatabaseProblems } from "../backup-integrity.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("daily database backup", () => {
  it("creates a consistent owner-only SQLite backup once per day", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-"));
    roots.push(root);
    const database = new Database(":memory:");
    database.exec("CREATE TABLE values_table (value TEXT); INSERT INTO values_table VALUES ('safe')");
    const now = new Date("2026-08-17T12:00:00.000Z");
    const first = await createDailyDatabaseBackup(database, { directory: root, now });
    const second = await createDailyDatabaseBackup(database, { directory: root, now });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const restored = new Database(first.file, { readonly: true });
    expect(restored.prepare("SELECT value FROM values_table").pluck().get()).toBe("safe");
    restored.close();
    database.close();
    if (process.platform !== "win32") expect(fs.statSync(first.file).mode & 0o777).toBe(0o600);
  });

  it("retains only the configured number of daily backups", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-retention-"));
    roots.push(root);
    const database = new Database(":memory:");
    database.exec("CREATE TABLE t (id INTEGER)");
    for (const day of ["2026-08-15", "2026-08-16", "2026-08-17"]) {
      await createDailyDatabaseBackup(database, { directory: root, now: new Date(`${day}T00:00:00Z`), retention: 2 });
    }
    expect(fs.readdirSync(root).sort()).toEqual(["sessions-2026-08-16.db", "sessions-2026-08-17.db"]);
    database.close();
  });

  it("backs up the workflows database under its own name", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-workflows-"));
    roots.push(root);
    const database = new Database(":memory:");
    database.exec("CREATE TABLE workflow_runs (id TEXT); INSERT INTO workflow_runs VALUES ('run-1')");
    const now = new Date("2026-08-17T12:00:00.000Z");

    const result = await createDailyDatabaseBackup(database, { directory: root, now, name: "workflows" });

    expect(result).toEqual({ created: true, file: path.join(root, "workflows-2026-08-17.db") });
    const copy = new Database(result.file, { readonly: true });
    expect(copy.prepare("SELECT id FROM workflow_runs").pluck().get()).toBe("run-1");
    copy.close();
    database.close();
    if (process.platform !== "win32") expect(fs.statSync(result.file).mode & 0o777).toBe(0o600);
  });

  it("keeps each database's generations apart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-names-"));
    roots.push(root);
    const database = new Database(":memory:");
    database.exec("CREATE TABLE t (id INTEGER)");
    for (const day of ["2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17"]) {
      const now = new Date(`${day}T00:00:00Z`);
      await createDailyDatabaseBackup(database, { directory: root, now, retention: 3 });
      await createDailyDatabaseBackup(database, { directory: root, now, retention: 2, name: "workflows" });
    }
    database.close();

    expect(fs.readdirSync(root).sort()).toEqual([
      "sessions-2026-08-15.db", "sessions-2026-08-16.db", "sessions-2026-08-17.db",
      "workflows-2026-08-16.db", "workflows-2026-08-17.db",
    ]);
  });

  it("lets the caller call the copy off just before it starts, and only when there is one to make", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-hook-"));
    roots.push(root);
    const database = new Database(":memory:");
    database.exec("CREATE TABLE t (id INTEGER)");
    const now = new Date("2026-08-17T12:00:00.000Z");
    let asked = 0;

    await expect(createDailyDatabaseBackup(database, {
      directory: root, now, beforeWrite: () => { asked += 1; throw new Error("no room for it"); },
    })).rejects.toThrow("no room for it");
    expect(fs.readdirSync(root)).toEqual([]);

    await createDailyDatabaseBackup(database, { directory: root, now, beforeWrite: () => { asked += 1; } });
    // Today's copy exists now, so there is nothing to write and nothing to ask about.
    const again = await createDailyDatabaseBackup(database, { directory: root, now, beforeWrite: () => { asked += 1; throw new Error("unreachable"); } });
    database.close();

    expect(again.created).toBe(false);
    expect(asked).toBe(2);
    expect(fs.readdirSync(root)).toEqual(["sessions-2026-08-17.db"]);
  });

  it("does not write through something planted where its temporary file used to go", async () => {
    // The temporary name was the final name plus the process id: predictable.
    // A symlink left there made SQLite write the copy into whatever it pointed at.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-planted-"));
    roots.push(root);
    const victim = path.join(root, "victim.txt");
    fs.writeFileSync(victim, "not the backup's to overwrite\n");
    fs.symlinkSync(victim, path.join(root, `sessions-2026-08-17.db.tmp-${process.pid}`));
    const database = new Database(":memory:");
    database.exec("CREATE TABLE values_table (value TEXT); INSERT INTO values_table VALUES ('safe')");

    const result = await createDailyDatabaseBackup(database, { directory: root, now: new Date("2026-08-17T12:00:00.000Z") });
    database.close();

    expect(fs.readFileSync(victim, "utf8")).toBe("not the backup's to overwrite\n");
    expect(fs.lstatSync(result.file).isFile()).toBe(true);
    const copy = new Database(result.file, { readonly: true });
    expect(copy.prepare("SELECT value FROM values_table").pluck().get()).toBe("safe");
    copy.close();
  });

  /** A registry of several pages on disk. Damaged, it still opens and still copies page for page - and is not sound. */
  function registryOnDisk(root: string, options: { damaged?: boolean } = {}): Database.Database {
    const file = path.join(root, "home", "registry.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const writer = new Database(file);
    writer.pragma("journal_mode = WAL");
    writer.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
    const insert = writer.prepare("INSERT INTO sessions (label) VALUES (?)");
    writer.transaction(() => { for (let index = 0; index < 2000; index += 1) insert.run(`session-${index}`); })();
    writer.close();
    if (options.damaged) damageDatabase(file);
    return new Database(file, { readonly: true });
  }

  const DAY = new Date("2026-08-17T12:00:00.000Z");

  it("does not keep a copy that fails SQLite's integrity check, and leaves the day's place free for one that passes", async () => {
    // A copy is made once a day and never remade that day. One that is broken
    // must not be the one that holds the day's name.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-damaged-"));
    roots.push(root);
    const backups = path.join(root, "backups");
    const damaged = registryOnDisk(root, { damaged: true });

    await expect(createDailyDatabaseBackup(damaged, { directory: backups, now: DAY })).rejects.toThrow(/integrity check/);
    damaged.close();

    // Nothing under the day's name, no temporary file, none of the sidecars reading it left.
    expect(fs.readdirSync(backups)).toEqual([]);

    const sound = new Database(":memory:");
    sound.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO sessions (label) VALUES ('safe')");
    const result = await createDailyDatabaseBackup(sound, { directory: backups, now: DAY });
    sound.close();
    expect(result.created).toBe(true);
    expect(fs.readdirSync(backups)).toEqual(["sessions-2026-08-17.db"]);
  });

  it("says what SQLite found, and that the database itself may be the damaged one", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-damaged-"));
    roots.push(root);
    const damaged = registryOnDisk(root, { damaged: true });

    const failure = await createDailyDatabaseBackup(damaged, { directory: path.join(root, "backups"), now: DAY }).then(() => null, (error: Error) => error);
    damaged.close();

    expect(failure).toBeInstanceOf(DatabaseCopyDamagedError);
    expect(failure!.message).toMatch(/discarded/);
    expect(failure!.message).toMatch(/database itself may be damaged/);
    expect((failure as DatabaseCopyDamagedError).problems.length).toBeGreaterThan(0);
    expect(failure!.message).toContain((failure as DatabaseCopyDamagedError).problems[0]);
  });

  it("checks the copy before it has its name, and nowhere but in the backup directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-checked-"));
    roots.push(root);
    const backups = path.join(root, "backups");
    const source = registryOnDisk(root);
    const final = path.join(backups, "sessions-2026-08-17.db");
    const asked: { file: string; named: boolean }[] = [];

    await createDailyDatabaseBackup(source, {
      directory: backups, now: DAY,
      check: async (file) => { asked.push({ file, named: fs.existsSync(final) }); return []; },
    });
    source.close();

    expect(asked).toEqual([{ file: expect.stringContaining(`${final}.tmp-`), named: false }]);
    expect(fs.readdirSync(backups)).toEqual(["sessions-2026-08-17.db"]);
  });

  it("leaves no trace of the check beside the copy it keeps", async () => {
    // The copy of a WAL-mode registry is WAL-mode too, and reading one creates a -wal and a -shm beside it.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-checked-"));
    roots.push(root);
    const backups = path.join(root, "backups");
    const source = registryOnDisk(root);

    const result = await createDailyDatabaseBackup(source, { directory: backups, now: DAY });
    source.close();

    expect(result).toEqual({ created: true, file: path.join(backups, "sessions-2026-08-17.db") });
    expect(fs.readdirSync(backups)).toEqual(["sessions-2026-08-17.db"]);
  });

  it("does not run the check on the caller's thread", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-damaged-"));
    roots.push(root);
    const damaged = registryOnDisk(root, { damaged: true });
    const pragma = vi.spyOn(Database.prototype, "pragma");

    await expect(createDailyDatabaseBackup(damaged, { directory: path.join(root, "backups"), now: DAY })).rejects.toThrow(/integrity check/);
    damaged.close();

    // It was checked - it was refused - and this thread's driver was never asked to do it.
    expect(pragma.mock.calls.filter(([source]) => /integrity_check/.test(String(source)))).toEqual([]);
  });

  it("keeps the copy, and says it went unchecked, when the check itself cannot be run", async () => {
    // No worker threads, a driver that will not load in one: the copy is no
    // worse than every copy made before there was a check, and a day without
    // one is worse than a day with one that nobody vouched for.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-unchecked-"));
    roots.push(root);
    const backups = path.join(root, "backups");
    const source = registryOnDisk(root);

    const result = await createDailyDatabaseBackup(source, {
      directory: backups, now: DAY,
      check: () => Promise.reject(new Error("the integrity check could not be run: worker threads are not available")),
    });
    source.close();

    expect(result).toEqual({
      created: true, file: path.join(backups, "sessions-2026-08-17.db"),
      unchecked: expect.stringContaining("worker threads are not available"),
    });
    expect(fs.readdirSync(backups)).toEqual(["sessions-2026-08-17.db"]);
  });

  it("keeps the copy, unchecked and said to be, when the check does not answer in time", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-hung-"));
    roots.push(root);
    const backups = path.join(root, "backups");
    const source = registryOnDisk(root);
    const driver = path.join(root, "hung-driver.cjs");
    fs.writeFileSync(driver, "module.exports = class Hung { constructor() {} pragma() { for (;;) {} } close() {} };\n");

    const result = await createDailyDatabaseBackup(source, {
      directory: backups, now: DAY,
      check: (file) => findDatabaseProblems(file, { driver, timeoutMs: 300 }),
    });
    source.close();

    expect(result).toEqual({
      created: true, file: path.join(backups, "sessions-2026-08-17.db"),
      unchecked: expect.stringMatching(/could not be run.*did not answer within/s),
    });
    expect(fs.readdirSync(backups)).toEqual(["sessions-2026-08-17.db"]);
  });

  it("does not remove the copy it has just made because the clock is behind the copies already there", async () => {
    // Seven copies dated after "today": by its name the new one is the eighth and oldest.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-clock-"));
    roots.push(root);
    for (let day = 10; day <= 16; day += 1) fs.writeFileSync(path.join(root, `sessions-2026-08-${day}.db`), "a copy from before the clock moved");
    const database = new Database(":memory:");
    database.exec("CREATE TABLE t (id INTEGER)");

    const result = await createDailyDatabaseBackup(database, { directory: root, now: new Date("2026-07-01T00:00:00Z") });
    database.close();

    expect(result.created).toBe(true);
    expect(fs.existsSync(result.file)).toBe(true);
    expect(fs.readdirSync(root)).toHaveLength(8);
  });

  it("removes an expired backup together with the sidecars reading it left behind", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-backup-sidecars-"));
    roots.push(root);
    const database = new Database(":memory:");
    database.exec("CREATE TABLE t (id INTEGER)");
    await createDailyDatabaseBackup(database, { directory: root, now: new Date("2026-08-16T00:00:00Z"), retention: 1 });
    // Opening a WAL-mode copy read-only leaves these beside it.
    for (const suffix of ["-wal", "-shm"]) fs.writeFileSync(path.join(root, `sessions-2026-08-16.db${suffix}`), "");
    fs.writeFileSync(path.join(root, "unrelated.txt"), "not ours to delete\n");

    await createDailyDatabaseBackup(database, { directory: root, now: new Date("2026-08-17T00:00:00Z"), retention: 1 });
    database.close();

    expect(fs.readdirSync(root).sort()).toEqual(["sessions-2026-08-17.db", "unrelated.txt"]);
  });
});
