import path from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { SESSIONS_DB } from "../shared/paths.js";
import type { Session } from "../shared/types.js";

let db: Database.Database;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
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
)`;

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    engine: row.engine as string,
    engineSessionId: (row.engine_session_id as string) ?? null,
    source: row.source as string,
    sourceRef: (row.source_ref as string),
    employee: (row.employee as string) ?? null,
    model: (row.model as string) ?? null,
    status: row.status as Session["status"],
    createdAt: row.created_at as string,
    lastActivity: row.last_activity as string,
    lastError: (row.last_error as string) ?? null,
  };
}

export function initDb(): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(SESSIONS_DB), { recursive: true });
  db = new Database(SESSIONS_DB);
  db.pragma("journal_mode = WAL");
  db.exec(CREATE_TABLE);
  return db;
}

export interface CreateSessionOpts {
  engine: string;
  source: string;
  sourceRef: string;
  employee?: string;
  model?: string;
}

export function createSession(opts: CreateSessionOpts): Session {
  const db = initDb();
  const now = new Date().toISOString();
  const id = uuidv4();

  const stmt = db.prepare(`
    INSERT INTO sessions (id, engine, source, source_ref, employee, model, status, created_at, last_activity)
    VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)
  `);
  stmt.run(id, opts.engine, opts.source, opts.sourceRef, opts.employee ?? null, opts.model ?? null, now, now);

  return {
    id,
    engine: opts.engine,
    engineSessionId: null,
    source: opts.source,
    sourceRef: opts.sourceRef,
    employee: opts.employee ?? null,
    model: opts.model ?? null,
    status: "idle",
    createdAt: now,
    lastActivity: now,
    lastError: null,
  };
}

export function getSession(id: string): Session | undefined {
  const db = initDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export function getSessionBySourceRef(sourceRef: string): Session | undefined {
  const db = initDb();
  const row = db.prepare("SELECT * FROM sessions WHERE source_ref = ? ORDER BY last_activity DESC LIMIT 1").get(sourceRef) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export interface UpdateSessionFields {
  engineSessionId?: string;
  status?: Session["status"];
  lastActivity?: string;
  lastError?: string | null;
}

export function updateSession(id: string, updates: UpdateSessionFields): Session | undefined {
  const db = initDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.engineSessionId !== undefined) {
    sets.push("engine_session_id = ?");
    values.push(updates.engineSessionId);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    values.push(updates.status);
  }
  if (updates.lastActivity !== undefined) {
    sets.push("last_activity = ?");
    values.push(updates.lastActivity);
  }
  if (updates.lastError !== undefined) {
    sets.push("last_error = ?");
    values.push(updates.lastError);
  }

  if (sets.length === 0) return getSession(id);

  values.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return getSession(id);
}

export interface ListSessionsFilter {
  status?: Session["status"];
  source?: string;
  engine?: string;
}

export function listSessions(filter?: ListSessionsFilter): Session[] {
  const db = initDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter?.status) {
    conditions.push("status = ?");
    values.push(filter.status);
  }
  if (filter?.source) {
    conditions.push("source = ?");
    values.push(filter.source);
  }
  if (filter?.engine) {
    conditions.push("engine = ?");
    values.push(filter.engine);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY last_activity DESC`).all(...values) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function deleteSession(id: string): boolean {
  const db = initDb();
  const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  return result.changes > 0;
}
