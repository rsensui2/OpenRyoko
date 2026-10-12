import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDailyDatabaseBackup } from "../backup.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

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
