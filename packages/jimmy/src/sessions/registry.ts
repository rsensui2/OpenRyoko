import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { SESSIONS_DB } from '../shared/paths.js';
import { logger } from '../shared/logger.js';
import { assertDiskSpaceForWrite } from '../shared/storage-health.js';
import type {
  JsonObject,
  ReplyContext,
  Session,
  SessionAttemptOutcome,
  WorkflowAttemptInterruptionCause,
  WorkflowSessionProvenance,
} from '../shared/types.js';

let db: Database.Database;
let ftsAvailable = true;
const FTS_BACKFILL_CHUNK = 500;

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  engine_session_id TEXT,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  connector TEXT,
  session_key TEXT,
  reply_context TEXT,
  message_id TEXT,
  transport_meta TEXT,
  employee TEXT,
  model TEXT,
  title TEXT,
  parent_session_id TEXT,
  status TEXT DEFAULT 'idle',
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  last_error TEXT
)`;

const CREATE_MESSAGES_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
)`;

const CREATE_MESSAGES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, timestamp)
`;

// The cross-session digest scans recent assistant replies across sessions.
// A session-leading index would scan all historical messages on every turn.
const CREATE_RECENT_REPLIES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_role_timestamp ON messages (role, timestamp)
`;

const CREATE_SESSION_KEY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_session_key ON sessions (session_key, last_activity)
`;

const CREATE_SESSION_ACTIVITY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_activity_id ON sessions (last_activity DESC, id DESC)
`;

const CREATE_SESSION_PARENT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions (parent_session_id, last_activity DESC)
`;

const CREATE_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mimetype TEXT,
  path TEXT,
  created_at TEXT NOT NULL
)
`;

function getMeta(database: Database.Database, key: string): string | undefined {
  return (database.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

function setMeta(database: Database.Database, key: string, value: string): void {
  database.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

function initializeFts(database: Database.Database): void {
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content);
      CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
      WHEN new.role IN ('user', 'assistant') BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
      WHEN old.role IN ('user', 'assistant') BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.rowid;
        INSERT INTO messages_fts(rowid, content)
          SELECT new.rowid, new.content WHERE new.role IN ('user', 'assistant');
      END;
    `);
    if (getMeta(database, 'fts_backfill_max') === undefined) {
      const max = database.prepare('SELECT COALESCE(MAX(rowid), 0) AS max FROM messages').get() as { max: number };
      setMeta(database, 'fts_backfill_max', String(max.max));
      setMeta(database, 'fts_backfill_rowid', '0');
      if (max.max === 0) setMeta(database, 'fts_backfill_done', '1');
    }
  } catch (err) {
    ftsAvailable = false;
    logger.warn(`FTS5 unavailable; message search disabled: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ftsBackfillStep(database: Database.Database, chunkSize = FTS_BACKFILL_CHUNK): boolean {
  if (!ftsAvailable || getMeta(database, 'fts_backfill_done') === '1') return true;
  const max = Number(getMeta(database, 'fts_backfill_max') ?? '0');
  const progress = Number(getMeta(database, 'fts_backfill_rowid') ?? '0');
  const rows = database.prepare(`
    SELECT rowid, content FROM messages
    WHERE role IN ('user', 'assistant') AND rowid > ? AND rowid <= ?
    ORDER BY rowid ASC LIMIT ?
  `).all(progress, max, Math.max(1, chunkSize)) as Array<{ rowid: number; content: string }>;
  if (rows.length === 0) {
    setMeta(database, 'fts_backfill_done', '1');
    return true;
  }
  const insert = database.prepare('INSERT OR REPLACE INTO messages_fts(rowid, content) VALUES (?, ?)');
  database.transaction((items: typeof rows) => {
    for (const row of items) insert.run(row.rowid, row.content);
    setMeta(database, 'fts_backfill_rowid', String(items.at(-1)!.rowid));
  })(rows);
  if (rows.at(-1)!.rowid >= max) {
    setMeta(database, 'fts_backfill_done', '1');
    return true;
  }
  return false;
}

export function backfillFtsSync(database: Database.Database = initDb(), chunkSize = FTS_BACKFILL_CHUNK): void {
  while (!ftsBackfillStep(database, chunkSize)) { /* drain */ }
}

const ftsBackfills = new WeakMap<Database.Database, Promise<void>>();

export function scheduleFtsBackfill(database: Database.Database = initDb(), chunkSize = FTS_BACKFILL_CHUNK): Promise<void> {
  if (!ftsAvailable || getMeta(database, 'fts_backfill_done') === '1') return Promise.resolve();
  const current = ftsBackfills.get(database);
  if (current) return current;
  const promise = new Promise<void>((resolve) => {
    const pump = () => {
      try {
        if (ftsBackfillStep(database, chunkSize)) {
          ftsBackfills.delete(database);
          resolve();
        } else {
          setImmediate(pump);
        }
      } catch (err) {
        ftsAvailable = false;
        ftsBackfills.delete(database);
        logger.warn(`FTS5 backfill failed; message search disabled until restart: ${err instanceof Error ? err.message : String(err)}`);
        resolve();
      }
    };
    setImmediate(pump);
  });
  ftsBackfills.set(database, promise);
  return promise;
}

export function isFtsBackfillPending(database: Database.Database = initDb()): boolean {
  return ftsAvailable && getMeta(database, 'fts_backfill_done') !== '1';
}

function parseJsonObject(value: unknown): JsonObject | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as JsonObject;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rowToSession(row: Record<string, unknown>): Session {
  const replyContext = parseJsonObject(row.reply_context);
  const transportMeta = parseJsonObject(row.transport_meta);
  const sessionKey = ((row.session_key as string) || (row.source_ref as string));
  const connector = (row.connector as string) ?? (row.source as string) ?? null;
  return {
    id: row.id as string,
    engine: row.engine as string,
    engineSessionId: (row.engine_session_id as string) ?? null,
    source: row.source as string,
    sourceRef: row.source_ref as string,
    connector,
    sessionKey,
    replyContext: replyContext as ReplyContext | null,
    messageId: (row.message_id as string) ?? null,
    transportMeta,
    employee: (row.employee as string) ?? null,
    model: (row.model as string) ?? null,
    title: (row.title as string) ?? null,
    parentSessionId: (row.parent_session_id as string) ?? null,
    workflowProvenance: row.workflow_provenance
      ? (parseJsonObject(row.workflow_provenance) as unknown as WorkflowSessionProvenance | null)
      : null,
    effortLevel: (row.effort_level as string) ?? null,
    status: row.status as Session['status'],
    attemptOutcome: (row.attempt_outcome as SessionAttemptOutcome) ?? null,
    attemptTerminalVersion: (row.attempt_terminal_version as number) ?? 0,
    attemptTurn: (row.attempt_turn as number) ?? 0,
    attemptInterruptionCause: (row.attempt_interruption_cause as WorkflowAttemptInterruptionCause) ?? null,
    attemptInterruptionTurn: (row.attempt_interruption_turn as number) ?? null,
    totalCost: (row.total_cost as number) ?? 0,
    totalTurns: (row.total_turns as number) ?? 0,
    lastContextTokens: (row.last_context_tokens as number) ?? null,
    createdAt: row.created_at as string,
    lastActivity: row.last_activity as string,
    lastError: (row.last_error as string) ?? null,
  };
}

export function initDb(): Database.Database {
  if (db) return db;
  mkdirSync(path.dirname(SESSIONS_DB), { recursive: true });
  db = new Database(SESSIONS_DB);
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_TABLE);
  db.exec(CREATE_MESSAGES_TABLE);
  db.exec(CREATE_MESSAGES_INDEX);
  db.exec(CREATE_RECENT_REPLIES_INDEX);
  initializeFts(db);
  migrateSessionsSchema(db);
  db.exec(CREATE_SESSION_KEY_INDEX);
  db.exec(CREATE_SESSION_ACTIVITY_INDEX);
  db.exec(CREATE_SESSION_PARENT_INDEX);
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      internal INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_queue_session
      ON queue_items (session_key, status, position);
  `);
  db.exec(CREATE_FILES_TABLE);

  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'not_started',
      level TEXT NOT NULL DEFAULT 'company',
      parent_id TEXT,
      department TEXT,
      owner TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (parent_id) REFERENCES goals(id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS budget_events (
      id TEXT PRIMARY KEY,
      employee TEXT NOT NULL,
      event_type TEXT NOT NULL,
      amount REAL NOT NULL,
      limit_amount REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return db;
}

export function migrateSessionsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string, string?]> = [
    ['title', 'TEXT'],
    ['parent_session_id', 'TEXT'],
    ['connector', 'TEXT'],
    ['session_key', 'TEXT'],
    ['reply_context', 'TEXT'],
    ['message_id', 'TEXT'],
    ['transport_meta', 'TEXT'],
    ['total_cost', 'REAL', '0'],
    ['total_turns', 'INTEGER', '0'],
    ['effort_level', 'TEXT'],
    ['last_context_tokens', 'INTEGER'],
    // Workflow attempt attribution + terminal receipts (upstream port)
    ['workflow_provenance', 'TEXT'],
    ['workflow_kind', 'TEXT'],
    ['workflow_id', 'TEXT'],
    ['workflow_run_id', 'TEXT'],
    ['workflow_phase_node_id', 'TEXT'],
    ['workflow_phase_attempt', 'INTEGER'],
    ['attempt_outcome', 'TEXT'],
    ['attempt_terminal_version', 'INTEGER', '0'],
    ['attempt_turn', 'INTEGER', '0'],
    ['attempt_interruption_cause', 'TEXT'],
    ['attempt_interruption_turn', 'INTEGER'],
  ];

  for (const [name, type, defaultVal] of missingColumns) {
    if (!colNames.has(name)) {
      const defaultClause = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      try {
        database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}${defaultClause}`);
      } catch (error) {
        // Two processes racing the same migration both observe "column missing";
        // the loser's ALTER must not abort startup once the column exists.
        if (!String(error).includes('duplicate column name')) throw error;
      }
    }
  }

  const refreshedCols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const refreshedNames = new Set(refreshedCols.map((c) => c.name));
  if (refreshedNames.has('session_key')) {
    database.exec(`UPDATE sessions SET session_key = COALESCE(session_key, source_ref) WHERE session_key IS NULL OR session_key = ''`);
  }
  if (refreshedNames.has('connector')) {
    database.exec(`UPDATE sessions SET connector = COALESCE(connector, source) WHERE connector IS NULL OR connector = ''`);
  }

  // queue_items is created after this migration runs on a fresh database (its
  // CREATE TABLE already carries `internal`); only an existing table needs the
  // column added.
  const queueCols = database.prepare('PRAGMA table_info(queue_items)').all() as Array<{ name: string }>;
  if (queueCols.length > 0 && !queueCols.some((c) => c.name === 'internal')) {
    try {
      database.exec('ALTER TABLE queue_items ADD COLUMN internal INTEGER NOT NULL DEFAULT 0');
    } catch (error) {
      if (!String(error).includes('duplicate column name')) throw error;
    }
  }
}

export interface CreateSessionOpts {
  engine: string;
  source: string;
  sourceRef: string;
  connector?: string | null;
  sessionKey?: string;
  replyContext?: ReplyContext | null;
  messageId?: string;
  transportMeta?: JsonObject | null;
  employee?: string;
  model?: string;
  title?: string;
  parentSessionId?: string;
  effortLevel?: string;
  /** Durable workflow/run/phase attribution (upstream port). */
  workflowProvenance?: WorkflowSessionProvenance;
}

function getNextSessionNumber(): number {
  const db = initDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
  return row.count + 1;
}

function generateTitle(prompt?: string): string {
  const num = getNextSessionNumber();
  if (!prompt) return `#${num}`;
  const cleaned = prompt.replace(/\n/g, ' ').replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return `#${num}`;
  const summary = cleaned.slice(0, 30).trim();
  return `#${num} - ${summary}${cleaned.length > 30 ? '...' : ''}`;
}

export function createSession(opts: CreateSessionOpts & { prompt?: string; portalName?: string }): Session {
  assertDiskSpaceForWrite();
  const db = initDb();
  const now = new Date().toISOString();
  const id = uuidv4();
  const title = opts.title ?? generateTitle(opts.prompt);
  const sessionKey = opts.sessionKey ?? opts.sourceRef;
  const connector = opts.connector ?? opts.source;
  const replyContext = opts.replyContext ? JSON.stringify(opts.replyContext) : null;
  const transportMeta = opts.transportMeta ? JSON.stringify(opts.transportMeta) : null;

  const workflow = opts.workflowProvenance ?? null;
  const stmt = db.prepare(`
    INSERT INTO sessions (
      id, engine, source, source_ref, connector, session_key, reply_context, message_id, transport_meta,
      employee, model, title, parent_session_id, effort_level, status, created_at, last_activity,
      workflow_provenance, workflow_kind, workflow_id, workflow_run_id, workflow_phase_node_id, workflow_phase_attempt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    opts.engine,
    opts.source,
    opts.sourceRef,
    connector,
    sessionKey,
    replyContext,
    opts.messageId ?? null,
    transportMeta,
    opts.employee ?? null,
    opts.model ?? null,
    title,
    opts.parentSessionId ?? null,
    opts.effortLevel ?? null,
    now,
    now,
    workflow ? JSON.stringify(workflow) : null,
    workflow?.kind ?? null,
    workflow?.workflowId ?? null,
    workflow?.runId ?? null,
    workflow?.phase?.nodeId ?? null,
    workflow?.phase?.attempt ?? null,
  );

  return {
    id,
    engine: opts.engine,
    engineSessionId: null,
    source: opts.source,
    sourceRef: opts.sourceRef,
    connector,
    sessionKey,
    replyContext: opts.replyContext ?? null,
    messageId: opts.messageId ?? null,
    transportMeta: opts.transportMeta ?? null,
    employee: opts.employee ?? null,
    model: opts.model ?? null,
    title,
    parentSessionId: opts.parentSessionId ?? null,
    workflowProvenance: workflow,
    effortLevel: opts.effortLevel ?? null,
    status: 'idle',
    attemptOutcome: null,
    attemptTerminalVersion: 0,
    attemptTurn: 0,
    attemptInterruptionCause: null,
    attemptInterruptionTurn: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: now,
    lastActivity: now,
    lastError: null,
  };
}

export function getSession(id: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export function getSessionBySourceRef(sourceRef: string): Session | undefined {
  return getSessionBySessionKey(sourceRef);
}

export function getSessionBySessionKey(sessionKey: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE session_key = ? ORDER BY last_activity DESC LIMIT 1').get(sessionKey) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export interface UpdateSessionFields {
  engine?: string;
  engineSessionId?: string | null;
  status?: Session['status'];
  model?: string | null;
  replyContext?: ReplyContext | null;
  messageId?: string | null;
  transportMeta?: JsonObject | null;
  lastActivity?: string;
  lastError?: string | null;
  title?: string;
  lastContextTokens?: number | null;
  attemptOutcome?: SessionAttemptOutcome | null;
  attemptTerminalVersion?: number;
  attemptTurn?: number;
  attemptInterruptionCause?: WorkflowAttemptInterruptionCause | null;
  attemptInterruptionTurn?: number | null;
}

export function updateSession(id: string, updates: UpdateSessionFields): Session | undefined {
  const db = initDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.engine !== undefined) {
    sets.push('engine = ?');
    values.push(updates.engine);
  }
  if (updates.engineSessionId !== undefined) {
    sets.push('engine_session_id = ?');
    values.push(updates.engineSessionId);
  }
  if (updates.attemptOutcome !== undefined) {
    sets.push('attempt_outcome = ?');
    values.push(updates.attemptOutcome);
  }
  if (updates.attemptTerminalVersion !== undefined) {
    sets.push('attempt_terminal_version = ?');
    values.push(updates.attemptTerminalVersion);
  }
  if (updates.attemptTurn !== undefined) {
    sets.push('attempt_turn = ?');
    values.push(updates.attemptTurn);
  }
  if (updates.attemptInterruptionCause !== undefined) {
    sets.push('attempt_interruption_cause = ?');
    values.push(updates.attemptInterruptionCause);
  }
  if (updates.attemptInterruptionTurn !== undefined) {
    sets.push('attempt_interruption_turn = ?');
    values.push(updates.attemptInterruptionTurn);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    values.push(updates.status);
  }
  if (updates.model !== undefined) {
    sets.push('model = ?');
    values.push(updates.model);
  }
  if (updates.replyContext !== undefined) {
    sets.push('reply_context = ?');
    values.push(updates.replyContext ? JSON.stringify(updates.replyContext) : null);
  }
  if (updates.messageId !== undefined) {
    sets.push('message_id = ?');
    values.push(updates.messageId);
  }
  if (updates.transportMeta !== undefined) {
    sets.push('transport_meta = ?');
    values.push(updates.transportMeta ? JSON.stringify(updates.transportMeta) : null);
  }
  if (updates.lastActivity !== undefined) {
    sets.push('last_activity = ?');
    values.push(updates.lastActivity);
  }
  if (updates.lastError !== undefined) {
    sets.push('last_error = ?');
    values.push(updates.lastError);
  }
  if (updates.title !== undefined) {
    sets.push('title = ?');
    values.push(updates.title);
  }
  if (updates.lastContextTokens !== undefined) {
    sets.push('last_context_tokens = ?');
    values.push(updates.lastContextTokens);
  }

  if (sets.length === 0) return getSession(id);

  values.push(id);
  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getSession(id);
}

export interface ListSessionsFilter {
  status?: Session['status'];
  source?: string;
  engine?: string;
}

export interface SessionPageCursor {
  lastActivity: string;
  id: string;
}

export interface SessionPage {
  sessions: Session[];
  nextCursor: SessionPageCursor | null;
}

export function listSessionPage(limit = 100, cursor?: SessionPageCursor): SessionPage {
  const database = initDb();
  const cap = Math.max(1, Math.min(Math.floor(limit) || 100, 200));
  const rows = cursor
    ? database.prepare(`
        SELECT * FROM sessions
        WHERE last_activity < ? OR (last_activity = ? AND id < ?)
        ORDER BY last_activity DESC, id DESC LIMIT ?
      `).all(cursor.lastActivity, cursor.lastActivity, cursor.id, cap + 1)
    : database.prepare('SELECT * FROM sessions ORDER BY last_activity DESC, id DESC LIMIT ?').all(cap + 1) as Record<string, unknown>[];
  const typedRows = rows as Record<string, unknown>[];
  const hasMore = typedRows.length > cap;
  const pageRows = hasMore ? typedRows.slice(0, cap) : typedRows;
  const last = pageRows.at(-1);
  return {
    sessions: pageRows.map(rowToSession),
    nextCursor: hasMore && last ? { lastActivity: String(last.last_activity), id: String(last.id) } : null,
  };
}

export function listSessions(filter?: ListSessionsFilter): Session[] {
  const db = initDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter?.status) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter?.source) {
    conditions.push('source = ?');
    values.push(filter.source);
  }
  if (filter?.engine) {
    conditions.push('engine = ?');
    values.push(filter.engine);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY last_activity DESC`).all(...values) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * Mark any sessions stuck in "running" status as "interrupted".
 * Called on gateway startup — if the gateway is starting, no sessions can actually be running.
 * Sessions with an engine_session_id can be resumed via the Claude --resume flag.
 */
export function recoverStaleSessions(): number {
  const db = initDb();
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE sessions SET status = 'interrupted', last_activity = ?, last_error = 'Interrupted: gateway restarted while session was running' WHERE status = 'running' AND workflow_kind IS NULL",
  ).run(now);
  return result.changes;
}

/**
 * Get sessions that were interrupted by a gateway restart and can be resumed.
 * A session is resumable if it has an engine_session_id (Claude's internal session ID).
 */
export function getInterruptedSessions(): Session[] {
  const db = initDb();
  const rows = db.prepare(
    "SELECT * FROM sessions WHERE status = 'interrupted' AND engine_session_id IS NOT NULL ORDER BY last_activity DESC",
  ).all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/**
 * Accumulate cost and turns for a session (called after each engine run).
 */
export function accumulateSessionCost(id: string, cost: number, turns: number): void {
  const db = initDb();
  db.prepare(
    'UPDATE sessions SET total_cost = total_cost + ?, total_turns = total_turns + ? WHERE id = ?',
  ).run(cost, turns, id);
}

/**
 * Duplicate a session and all its messages, returning a new session with a fresh ID.
 * Does NOT fork the engine session — the caller handles that separately.
 */
export function duplicateSession(sourceId: string, newTitle?: string): { session: Session; messageCount: number } {
  const db = initDb();
  const source = getSession(sourceId);
  if (!source) throw new Error(`Session ${sourceId} not found`);
  if (!source.engineSessionId) throw new Error(`Session ${sourceId} has no engine session ID — cannot duplicate`);

  const now = new Date().toISOString();
  const newId = uuidv4();
  const title = newTitle ?? `Copy of ${source.title || sourceId.slice(0, 8)}`;
  const newSessionKey = `web:${Date.now()}`;

  // Copy session + messages in a single transaction for consistency
  const messages = db.prepare(
    'SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
  ).all(sourceId) as Array<{ role: string; content: string; timestamp: number }>;

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO sessions (
        id, engine, engine_session_id, source, source_ref, connector, session_key,
        reply_context, message_id, transport_meta,
        employee, model, title, parent_session_id, effort_level, status,
        total_cost, total_turns, created_at, last_activity
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'idle', 0, 0, ?, ?)
    `).run(
      newId,
      source.engine,
      source.source,
      source.sourceRef,
      source.connector,
      newSessionKey,
      source.replyContext ? JSON.stringify(source.replyContext) : null,
      source.messageId,
      source.transportMeta ? JSON.stringify(source.transportMeta) : null,
      source.employee,
      source.model,
      title,
      source.effortLevel,
      now,
      now,
    );

    const insertMsg = db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)',
    );
    for (const msg of messages) {
      insertMsg.run(uuidv4(), newId, msg.role, msg.content, msg.timestamp);
    }
  });
  txn();

  const newSession = getSession(newId)!;
  return { session: newSession, messageCount: messages.length };
}

export function deleteSession(id: string): boolean {
  const db = initDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteSessions(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = initDb();
  const placeholders = ids.map(() => '?').join(',');
  const txn = db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids);
    const result = db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
    return result.changes;
  });
  return txn();
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
}

export interface MessagePage {
  messages: SessionMessage[];
  hasOlder: boolean;
}

export interface MessageWindow extends MessagePage {
  hasNewer: boolean;
  anchorFound: boolean;
}

export function insertMessage(sessionId: string, role: string, content: string): void {
  assertDiskSpaceForWrite();
  const db = initDb();
  const id = uuidv4();
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)').run(id, sessionId, role, content, Date.now());
}

export function getMessages(sessionId: string): SessionMessage[] {
  const db = initDb();
  return db.prepare('SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as SessionMessage[];
}

export interface RecentReply {
  sessionId: string;
  sourceRef: string;
  transportMeta: string | null;
  content: string;
  timestamp: number;
}

/** Recent portal replies; cron and employee sessions never count as its work. */
export function getRecentRepliesAcrossSessions(opts: {
  sinceMs: number;
  limit: number;
  excludeSessionId?: string;
  /** Defaults to excluding DMs. Only the privacy gate may opt in. */
  excludeDirectMessages?: boolean;
  /** Restrict shared-thread context to this exact Slack channel. */
  channelId?: string;
}): RecentReply[] {
  if (!Number.isFinite(opts.sinceMs) || !Number.isFinite(opts.limit) || opts.limit < 1) return [];
  if (opts.channelId !== undefined && !/^[CG][A-Z0-9]+$/.test(opts.channelId)) return [];
  const database = initDb();
  const rows = database.prepare(`
    SELECT m.session_id AS sessionId,
           s.source_ref AS sourceRef,
           s.transport_meta AS transportMeta,
           m.content AS content,
           m.timestamp AS timestamp
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.role = 'assistant'
      AND m.timestamp >= ?
      AND s.source = 'slack'
      AND s.source_ref LIKE 'slack:%'
      AND s.employee IS NULL
      AND (? = 0 OR s.source_ref NOT LIKE 'slack:dm:%')
      AND (? IS NULL OR s.source_ref LIKE ?)
      AND (? IS NULL OR m.session_id != ?)
    ORDER BY m.timestamp DESC, m.rowid DESC
    LIMIT ?
  `).all(
    opts.sinceMs,
    opts.excludeDirectMessages !== false ? 1 : 0,
    opts.channelId ?? null,
    opts.channelId ? `slack:${opts.channelId}:%` : null,
    opts.excludeSessionId ?? null,
    opts.excludeSessionId ?? null,
    Math.min(Math.floor(opts.limit), 100),
  ) as RecentReply[];
  return rows.reverse();
}

export function getMessagePage(sessionId: string, options: { before?: string; limit?: number } = {}): MessagePage {
  const database = initDb();
  const cap = Math.max(1, Math.min(Math.floor(options.limit ?? 100) || 100, 200));
  let rows: Array<SessionMessage & { rowid: number }>;
  if (options.before) {
    const cursor = database.prepare('SELECT rowid, timestamp FROM messages WHERE session_id = ? AND id = ?')
      .get(sessionId, options.before) as { rowid: number; timestamp: number } | undefined;
    if (!cursor) return { messages: [], hasOlder: false };
    rows = database.prepare(`
      SELECT rowid, id, role, content, timestamp FROM messages
      WHERE session_id = ? AND (timestamp < ? OR (timestamp = ? AND rowid < ?))
      ORDER BY timestamp DESC, rowid DESC LIMIT ?
    `).all(sessionId, cursor.timestamp, cursor.timestamp, cursor.rowid, cap + 1) as typeof rows;
  } else {
    rows = database.prepare(`
      SELECT rowid, id, role, content, timestamp FROM messages
      WHERE session_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?
    `).all(sessionId, cap + 1) as typeof rows;
  }
  const hasOlder = rows.length > cap;
  const pageRows = (hasOlder ? rows.slice(0, cap) : rows).reverse();
  return { messages: pageRows.map(({ rowid: _rowid, ...message }) => message), hasOlder };
}

export function getMessageWindow(sessionId: string, anchorId: string, radius = 50): MessageWindow {
  const database = initDb();
  const cap = Math.max(1, Math.min(Math.floor(radius) || 50, 100));
  const anchor = database.prepare('SELECT rowid, timestamp FROM messages WHERE session_id = ? AND id = ?')
    .get(sessionId, anchorId) as { rowid: number; timestamp: number } | undefined;
  if (!anchor) return { messages: [], hasOlder: false, hasNewer: false, anchorFound: false };

  const olderAndAnchor = database.prepare(`
    SELECT rowid, id, role, content, timestamp FROM messages
    WHERE session_id = ? AND (timestamp < ? OR (timestamp = ? AND rowid <= ?))
    ORDER BY timestamp DESC, rowid DESC LIMIT ?
  `).all(sessionId, anchor.timestamp, anchor.timestamp, anchor.rowid, cap + 2) as Array<SessionMessage & { rowid: number }>;
  const newer = database.prepare(`
    SELECT rowid, id, role, content, timestamp FROM messages
    WHERE session_id = ? AND (timestamp > ? OR (timestamp = ? AND rowid > ?))
    ORDER BY timestamp ASC, rowid ASC LIMIT ?
  `).all(sessionId, anchor.timestamp, anchor.timestamp, anchor.rowid, cap + 1) as Array<SessionMessage & { rowid: number }>;

  const hasOlder = olderAndAnchor.length > cap + 1;
  const hasNewer = newer.length > cap;
  const before = (hasOlder ? olderAndAnchor.slice(0, cap + 1) : olderAndAnchor).reverse();
  const after = hasNewer ? newer.slice(0, cap) : newer;
  return {
    messages: [...before, ...after].map(({ rowid: _rowid, ...message }) => message),
    hasOlder,
    hasNewer,
    anchorFound: true,
  };
}

export interface MessageSearchResult {
  messageId: string;
  sessionId: string;
  snippet: string;
  role: string;
  timestamp: number;
  employee: string | null;
  engine: string | null;
}

function sanitizeFtsQuery(query: string): string {
  return query
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/"/g, ''))
    .filter(Boolean)
    .map((token) => `"${token}"`)
    .join(' ');
}

export function searchMessages(
  query: string,
  limit = 20,
  filter: { sessionId?: string; employee?: string; engine?: string; role?: 'user' | 'assistant' } = {},
): MessageSearchResult[] {
  const database = initDb();
  if (!ftsAvailable) return [];
  void scheduleFtsBackfill(database);
  const match = sanitizeFtsQuery(query);
  if (!match) return [];
  const cap = Math.max(1, Math.min(Math.floor(limit) || 20, 200));
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter.sessionId) { conditions.push('m.session_id = ?'); values.push(filter.sessionId); }
  if (filter.employee) { conditions.push('LOWER(s.employee) = ?'); values.push(filter.employee.toLowerCase()); }
  if (filter.engine) { conditions.push('LOWER(s.engine) = ?'); values.push(filter.engine.toLowerCase()); }
  if (filter.role) { conditions.push('m.role = ?'); values.push(filter.role); }
  const extra = conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
  try {
    return database.prepare(`
      SELECT m.id AS messageId, m.session_id AS sessionId,
             snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet,
             m.role AS role, m.timestamp AS timestamp,
             s.employee AS employee, s.engine AS engine
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      LEFT JOIN sessions s ON s.id = m.session_id
      WHERE messages_fts MATCH ?${extra}
      ORDER BY messages_fts.rank, m.timestamp DESC, m.rowid DESC LIMIT ?
    `).all(match, ...values, cap) as MessageSearchResult[];
  } catch (err) {
    if (String(err).includes('no such table')) return [];
    throw err;
  }
}

export interface QueueItem {
  id: string;
  sessionId: string;
  sessionKey: string;
  prompt: string;
  status: "pending" | "running" | "cancelled" | "completed";
  position: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function enqueueQueueItem(sessionId: string, sessionKey: string, prompt: string, opts: { internal?: boolean } = {}): string {
  const db = initDb();
  const id = randomUUID();
  const position = (db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status = 'pending'"
  ).get(sessionKey) as { pos: number }).pos;
  db.prepare(
    "INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at, internal) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)"
  ).run(id, sessionId, sessionKey, prompt, position, new Date().toISOString(), opts.internal ? 1 : 0);
  return id;
}

/**
 * Persist a notification message AND its queue item in one transaction.
 * Deduped wake-ups (detached job monitors) rely on "message exists ⇒ its
 * turn is queued or already ran": a crash between the two writes would make
 * every retry a false duplicate and strand the wake-up forever.
 */
export function insertNotificationWithQueueItem(sessionId: string, sessionKey: string, content: string): string {
  const db = initDb();
  const tx = db.transaction(() => {
    insertMessage(sessionId, "notification", content);
    return enqueueQueueItem(sessionId, sessionKey, content);
  });
  return tx();
}

/** pending→running の CAS。勝者のみ true — 敗者はそのプロンプトを実行してはならない。 */
export function markQueueItemRunning(itemId: string): boolean {
  const db = initDb();
  return db.prepare("UPDATE queue_items SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'")
    .run(new Date().toISOString(), itemId).changes === 1;
}

export function getQueueItem(itemId: string): QueueItem | undefined {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE id = ?"
  ).get(itemId) as QueueItem | undefined;
}

export function markQueueItemCompleted(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function cancelQueueItem(itemId: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(itemId);
  return result.changes > 0;
}

export function getQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE session_key = ? AND status IN ('pending', 'running') ORDER BY position ASC"
  ).all(sessionKey) as QueueItem[];
}

export function cancelAllPendingQueueItems(sessionKey: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE session_key = ? AND status = 'pending'"
  ).run(sessionKey);
  return result.changes;
}

export function recoverStaleQueueItems(): number {
  const db = initDb();
  // If the gateway restarts mid-run, move any "running" items back to "pending"
  // so they can be replayed. Do NOT cancel pending work.
  const result = db.prepare(
    "UPDATE queue_items SET status = 'pending', started_at = NULL WHERE status = 'running'"
  ).run();
  return result.changes;
}

export function listAllPendingQueueItems(): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE status = 'pending' ORDER BY created_at ASC, position ASC"
  ).all() as QueueItem[];
}

// ── File management ──────────────────────────────────────────────────

export interface FileMeta {
  id: string;
  filename: string;
  size: number;
  mimetype: string | null;
  path: string | null;
  createdAt: string;
}

function rowToFileMeta(row: Record<string, unknown>): FileMeta {
  return {
    id: row.id as string,
    filename: row.filename as string,
    size: row.size as number,
    mimetype: (row.mimetype as string) ?? null,
    path: (row.path as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export function insertFile(meta: { id: string; filename: string; size: number; mimetype: string | null; path: string | null }): FileMeta {
  const db = initDb();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO files (id, filename, size, mimetype, path, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    meta.id, meta.filename, meta.size, meta.mimetype, meta.path, now,
  );
  return { ...meta, createdAt: now };
}

export function getFile(id: string): FileMeta | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToFileMeta(row) : undefined;
}

export function listFiles(): FileMeta[] {
  const db = initDb();
  const rows = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToFileMeta);
}

export function deleteFile(id: string): boolean {
  const db = initDb();
  const result = db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- Workflow attempt sessions (upstream port, adapted to the jimmy schema) ---

const QUEUE_ITEM_WIRE_SELECT =
  "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items";

type WorkflowAttemptSessionOpts = CreateSessionOpts & { prompt?: string; workflowProvenance: WorkflowSessionProvenance };

function assertWorkflowAttemptSession(session: Session, opts: WorkflowAttemptSessionOpts, key: string): void {
  const expected = opts.workflowProvenance;
  const actual = session.workflowProvenance;
  const sameOwner = expected.kind === 'phase' && expected.phase && actual?.kind === 'phase' && actual.phase
    && actual.workflowId === expected.workflowId && actual.runId === expected.runId
    && actual.phase.nodeId === expected.phase.nodeId && actual.phase.attempt === expected.phase.attempt;
  if (!sameOwner) throw new Error(`Workflow attempt session key collision for ${key}.`);
  if (session.sessionKey !== key || session.sourceRef !== key) throw new Error(`Workflow attempt session key mismatch for ${key}.`);
  const expectedConfig = [opts.engine, opts.employee ?? null, opts.model ?? null, opts.effortLevel ?? null];
  if ([session.engine, session.employee, session.model, session.effortLevel].some((value, index) => value !== expectedConfig[index])) {
    throw new Error(`Workflow attempt session configuration mismatch for ${key}.`);
  }
}

/** One session row per workflow attempt, found again after a crash by its
 *  provenance rather than created twice. */
export function getOrCreateWorkflowAttemptSession(opts: WorkflowAttemptSessionOpts): Session {
  const database = initDb();
  const workflow = opts.workflowProvenance;
  const phase = workflow.kind === 'phase' ? workflow.phase : undefined;
  if (!phase) throw new Error('Workflow attempt sessions require phase provenance.');
  const key = opts.sessionKey ?? opts.sourceRef;
  const getOrCreate = database.transaction(() => {
    const rows = database.prepare(
      `SELECT * FROM sessions WHERE session_key = ? OR (workflow_kind = 'phase' AND workflow_id = ? AND workflow_run_id = ? AND workflow_phase_node_id = ? AND workflow_phase_attempt = ?)`
    ).all(key, workflow.workflowId, workflow.runId, phase.nodeId, phase.attempt) as Record<string, unknown>[];
    if (rows.length > 1) throw new Error(`Workflow attempt session key collision for ${key}.`);
    const existing = rows[0] ? rowToSession(rows[0]) : undefined;
    if (!existing) return createSession(opts);
    assertWorkflowAttemptSession(existing, opts, key);
    return existing;
  });
  return getOrCreate.immediate();
}

/** Terminal interruption receipt. Only a live, unsettled attempt row takes it,
 *  so a stop that raced a completion never rewrites what already settled. */
export function interruptSessionAttempt(id: string, reason: string, completedAt: string): Session | undefined {
  const result = initDb().prepare(`UPDATE sessions SET status = 'interrupted', attempt_outcome = 'interrupted',
    attempt_terminal_version = 1, attempt_turn = attempt_turn + 1, last_activity = ?, last_error = ?,
    attempt_interruption_cause = NULL, attempt_interruption_turn = NULL
    WHERE id = ? AND workflow_kind = 'phase' AND attempt_outcome IS NULL AND attempt_terminal_version = 0`)
    .run(completedAt, reason, id);
  return result.changes === 1 ? getSession(id) : undefined;
}

export function listChildSessions(parentSessionId: string): Session[] {
  const rows = initDb().prepare('SELECT * FROM sessions WHERE parent_session_id = ?')
    .all(parentSessionId) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

/** Claim the one internal dispatch slot of an idle workflow attempt session.
 *  Returns the queue item id to run under, or null when the slot is taken. */
export function claimWorkflowAttemptDispatch(sessionId: string, sessionKey: string, prompt: string): string | null {
  const db = initDb();
  return db.transaction(() => {
    const session = db.prepare(`SELECT id FROM sessions WHERE id = ? AND session_key = ?
      AND workflow_kind = 'phase' AND status = 'idle'
      AND (attempt_outcome IS NULL OR attempt_outcome = 'succeeded')`).get(sessionId, sessionKey);
    if (!session) return null;
    const existing = db.prepare(
      `${QUEUE_ITEM_WIRE_SELECT} WHERE session_id = ? AND internal = 1 AND status IN ('pending', 'running') ORDER BY created_at, position LIMIT 1`
    ).get(sessionId) as (QueueItem & { sessionKey: string }) | undefined;
    if (existing && (existing.sessionKey !== sessionKey || existing.prompt !== prompt)) {
      throw new Error(`Workflow session ${sessionId} dispatch claim does not match its immutable command.`);
    }
    if (existing?.status === 'running') return null;
    const itemId = existing?.id ?? enqueueQueueItem(sessionId, sessionKey, prompt, { internal: true });
    // 新しい dispatch generation の開始を claim と同じ transaction で durable に:
    // 前ターンの terminal receipt をここでクリアするので、pending row が存在する間は
    // 「outcome が刻まれていれば settle 済み」という不変式が成り立つ。
    db.prepare("UPDATE sessions SET attempt_outcome = NULL, attempt_terminal_version = 0 WHERE id = ?").run(sessionId);
    return itemId;
  }).immediate();
}

export function cancelWorkflowAttemptDispatch(sessionId: string): number {
  return initDb().prepare(
    `UPDATE queue_items SET status = 'cancelled' WHERE session_id = ? AND internal = 1 AND status IN ('pending', 'running')`
  ).run(sessionId).changes;
}

/** Pending internal dispatches whose attempt session can still run them —
 *  what a restarting gateway replays. */
export function listPendingWorkflowAttemptDispatches(): QueueItem[] {
  return initDb().prepare(`${QUEUE_ITEM_WIRE_SELECT} WHERE status = 'pending' AND internal = 1
    AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = queue_items.session_id
      AND sessions.workflow_kind = 'phase' AND sessions.status = 'idle'
      AND (sessions.attempt_outcome IS NULL OR sessions.attempt_outcome = 'succeeded'))
    ORDER BY created_at, position`).all() as QueueItem[];
}

/** Record the engine-native session id an attempt should resume from. The
 *  fork tracks one engineSessionId per session, so the record only lands when
 *  the engine matches the session's own. */
export function recordEngineSessionId(sessionId: string, engine: string, nativeId: string): Session | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  if (session.engine !== engine) return session;
  return updateSession(sessionId, { engineSessionId: nativeId }) ?? session;
}

/** Settle workflow attempts whose engine process was lost with the old gateway.
 *  The `gateway-restart` cause is what lets the runtime replace the attempt
 *  rather than spend its retry budget (see workflows/restart-redispatch.ts). */
export function recoverStaleWorkflowAttemptSessions(): number {
  const database = initDb();
  const now = new Date().toISOString();
  return database.transaction(() => {
    database.prepare(`
      UPDATE queue_items
      SET status = 'cancelled'
      WHERE internal = 1
        AND status IN ('pending', 'running')
        AND EXISTS (
          SELECT 1
          FROM sessions
          WHERE sessions.id = queue_items.session_id
            AND sessions.status = 'running'
            AND sessions.workflow_kind = 'phase'
            AND sessions.attempt_outcome IS NULL
            AND sessions.attempt_terminal_version = 0
        )
    `).run();
    return database.prepare(`
      UPDATE sessions
      SET status = 'interrupted',
        attempt_outcome = 'interrupted',
        attempt_terminal_version = 1,
        attempt_turn = MAX(attempt_turn, 1),
        attempt_interruption_cause = 'gateway-restart',
        attempt_interruption_turn = MAX(attempt_turn, 1),
        last_activity = ?,
        last_error = 'Interrupted: gateway restarted while workflow attempt was running'
      WHERE status = 'running'
        AND workflow_kind = 'phase'
        AND attempt_outcome IS NULL
        AND attempt_terminal_version = 0
    `).run(now).changes;
  }).immediate();
}

/** Terminal receipt for the turn a workflow dispatch just ran, written in the
 *  same transaction that closes the internal queue row — so a crash can never
 *  leave "receipt says succeeded, queue row still pending" for a restart to
 *  re-execute. A stop that already stamped `interrupted` keeps its receipt
 *  (only a null outcome is filled), but the queue row is closed either way. */
export function settleWorkflowAttemptDispatch(
  sessionId: string,
  outcome: SessionAttemptOutcome | null,
  opts: { error?: string } = {},
): Session | undefined {
  const database = initDb();
  return database.transaction(() => {
    const current = getSession(sessionId);
    if (!current || current.workflowProvenance?.kind !== 'phase') return current ?? undefined;
    database.prepare(
      "UPDATE queue_items SET status = 'completed', completed_at = ? WHERE session_id = ? AND internal = 1 AND status IN ('pending', 'running')"
    ).run(new Date().toISOString(), sessionId);
    if (current.attemptOutcome) return current;
    if (outcome === null) return current;
    return updateSession(sessionId, {
      attemptOutcome: outcome,
      attemptTerminalVersion: 1,
      attemptTurn: (current.attemptTurn ?? 0) + 1,
      ...(opts.error !== undefined ? { status: 'error' as const, lastError: opts.error, lastActivity: new Date().toISOString() } : {}),
    }) ?? current;
  }).immediate();
}
