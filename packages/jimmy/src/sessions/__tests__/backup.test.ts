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
});
