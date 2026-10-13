import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateSessionsSchema } from "../registry.js";

describe("migrateSessionsSchema", () => {
  it("upgrades an old sessions table before session_key usage", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        engine TEXT NOT NULL,
        engine_session_id TEXT,
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        employee TEXT,
        model TEXT,
        status TEXT DEFAULT 'idle',
        created_at TEXT NOT NULL,
        last_activity TEXT NOT NULL,
        last_error TEXT
      )
    `);
    db.exec(`
      INSERT INTO sessions (
        id, engine, engine_session_id, source, source_ref, employee, model, status, created_at, last_activity, last_error
      ) VALUES (
        's1', 'claude', NULL, 'slack', 'slack:C123', NULL, NULL, 'idle', '2026-03-10T00:00:00.000Z', '2026-03-10T00:00:00.000Z', NULL
      )
    `);

    migrateSessionsSchema(db);

    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const names = new Set(cols.map((col) => col.name));
    expect(names.has("session_key")).toBe(true);
    expect(names.has("connector")).toBe(true);
    expect(names.has("reply_context")).toBe(true);
    expect(names.has("message_id")).toBe(true);
    expect(names.has("transport_meta")).toBe(true);

    const row = db.prepare("SELECT session_key, connector FROM sessions WHERE id = 's1'").get() as {
      session_key: string | null;
      connector: string | null;
    };
    expect(row.session_key).toBe("slack:C123");
    expect(row.connector).toBe("slack");
  });
});
