import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { WORKFLOWS_DB_PATH } from '../shared/paths.js';

export const WORKFLOW_DB_SCHEMA_VERSION = 4;
export const WORKFLOW_DB_PHYSICAL_SCHEMA_VERSIONS = [1, 2, 3, 4] as const;
export const WORKFLOW_DB_MIGRATION_SOURCE_VERSIONS = [0, 1, 2, 3] as const;

const UNSUPPORTED_SCHEMA_ERROR = 'Unsupported workflow database schema version.';
const MALFORMED_SCHEMA_ERROR = 'Malformed workflow database schema version.';
const SYMLINK_ERROR = 'Workflow database default store must not contain symbolic links.';
const NO_FOLLOW_ERROR = 'Workflow database no-follow protection is unavailable.';

const CREATE_SCHEMA_TABLE_SQL = `
CREATE TABLE workflow_schema (
  version INTEGER NOT NULL
);
`;

const CREATE_DOMAIN_SCHEMA_V1_SQL = `
CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  revision INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  retired_at TEXT,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow_definitions(id),
  workflow_title TEXT NOT NULL,
  definition_revision INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  input_json TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  idempotency_key TEXT,
  invocation_session_id TEXT,
  cancel_requested_at TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_json TEXT,
  UNIQUE(workflow_id, idempotency_key)
);

CREATE TABLE workflow_node_runs (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL,
  activated INTEGER NOT NULL DEFAULT 0,
  resolved_config_json TEXT,
  input_json TEXT,
  output_json TEXT,
  error_json TEXT,
  resume_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  PRIMARY KEY(run_id, node_id)
);

CREATE TABLE workflow_attempts (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  resolved_config_json TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY(run_id, node_id, attempt),
  FOREIGN KEY(run_id, node_id) REFERENCES workflow_node_runs(run_id, node_id) ON DELETE CASCADE
);

CREATE TABLE workflow_approvals (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  approver_ref TEXT,
  decided_at TEXT,
  decided_by TEXT,
  decision TEXT,
  reason TEXT,
  PRIMARY KEY(run_id, node_id),
  FOREIGN KEY(run_id, node_id) REFERENCES workflow_node_runs(run_id, node_id) ON DELETE CASCADE
);

CREATE INDEX workflow_runs_by_workflow_started ON workflow_runs(workflow_id, started_at DESC, id DESC);
CREATE INDEX workflow_runs_by_status_started ON workflow_runs(status, started_at DESC, id DESC);
CREATE INDEX workflow_attempts_by_session ON workflow_attempts(session_id);
CREATE INDEX workflow_approvals_pending ON workflow_approvals(status, requested_at);
CREATE INDEX workflow_node_runs_due ON workflow_node_runs(status, resume_at);
`;

const MIGRATE_V1_TO_V2_SQL = `
ALTER TABLE workflow_attempts ADD COLUMN retry_idempotency_key TEXT;
CREATE UNIQUE INDEX workflow_attempts_retry_key
  ON workflow_attempts(run_id, retry_idempotency_key)
  WHERE retry_idempotency_key IS NOT NULL;
`;

const MIGRATE_V2_TO_V3_SQL = `
ALTER TABLE workflow_attempts ADD COLUMN reminders_sent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_attempts ADD COLUMN next_reminder_at TEXT;
ALTER TABLE workflow_attempts ADD COLUMN extensions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_attempts ADD COLUMN last_extension_reason TEXT;
ALTER TABLE workflow_attempts ADD COLUMN pending_output_error TEXT;
ALTER TABLE workflow_attempts ADD COLUMN last_processed_turn INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_attempts ADD COLUMN prompt_text TEXT;
CREATE INDEX workflow_attempts_due_reminder ON workflow_attempts(status, next_reminder_at);
`;

const CREATE_DOMAIN_SCHEMA_V2_SQL = CREATE_DOMAIN_SCHEMA_V1_SQL
  .replace('  ended_at TEXT,\n  PRIMARY KEY(run_id, node_id, attempt),',
    '  ended_at TEXT,\n  retry_idempotency_key TEXT,\n  PRIMARY KEY(run_id, node_id, attempt),')
  .replace('CREATE INDEX workflow_attempts_by_session ON workflow_attempts(session_id);',
    `CREATE INDEX workflow_attempts_by_session ON workflow_attempts(session_id);
CREATE UNIQUE INDEX workflow_attempts_retry_key
  ON workflow_attempts(run_id, retry_idempotency_key)
  WHERE retry_idempotency_key IS NOT NULL;`);

const CREATE_DOMAIN_SCHEMA_V3_SQL = CREATE_DOMAIN_SCHEMA_V2_SQL
  .replace('  retry_idempotency_key TEXT,\n  PRIMARY KEY(run_id, node_id, attempt),',
    `  retry_idempotency_key TEXT,
  reminders_sent INTEGER NOT NULL DEFAULT 0,
  next_reminder_at TEXT,
  extensions INTEGER NOT NULL DEFAULT 0,
  last_extension_reason TEXT,
  pending_output_error TEXT,
  last_processed_turn INTEGER NOT NULL DEFAULT 0,
  prompt_text TEXT,
  PRIMARY KEY(run_id, node_id, attempt),`)
  .replace('CREATE INDEX workflow_approvals_pending ON workflow_approvals(status, requested_at);',
    `CREATE INDEX workflow_approvals_pending ON workflow_approvals(status, requested_at);
CREATE INDEX workflow_attempts_due_reminder ON workflow_attempts(status, next_reminder_at);`);

const MIGRATE_V3_TO_V4_SQL = 'ALTER TABLE workflow_attempts ADD COLUMN stop_nudges_sent INTEGER NOT NULL DEFAULT 0;';
const CREATE_DOMAIN_SCHEMA_V4_SQL = CREATE_DOMAIN_SCHEMA_V3_SQL.replace('  prompt_text TEXT,', '  prompt_text TEXT,\n  stop_nudges_sent INTEGER NOT NULL DEFAULT 0,');

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim().replace(/;$/, '');
}

function schemaStatements(sql: string): string[] {
  return sql.split(/;\s*(?:\n|$)/).map(normalizeSql).filter(Boolean).sort();
}

const SCHEMA_TABLE_SQL = normalizeSql(CREATE_SCHEMA_TABLE_SQL);
const VERSION_ZERO_SCHEMA = [SCHEMA_TABLE_SQL];
const SCHEMA_V1 = schemaStatements(CREATE_SCHEMA_TABLE_SQL + CREATE_DOMAIN_SCHEMA_V1_SQL);
const SCHEMA_V2 = schemaStatements(CREATE_SCHEMA_TABLE_SQL + CREATE_DOMAIN_SCHEMA_V2_SQL);
const SCHEMA_V3 = schemaStatements(CREATE_SCHEMA_TABLE_SQL + CREATE_DOMAIN_SCHEMA_V3_SQL);
const SCHEMA_V4 = schemaStatements(CREATE_SCHEMA_TABLE_SQL + CREATE_DOMAIN_SCHEMA_V4_SQL);

interface SchemaState {
  exists: boolean;
  version: number;
}

function assertSchema(db: Database.Database, expected: string[]): void {
  const actual = (db.prepare(
    'SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name',
  ).pluck().all() as string[]).map(normalizeSql).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(MALFORMED_SCHEMA_ERROR);
}

function readSchemaState(db: Database.Database): SchemaState {
  const schemaSql = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'workflow_schema' COLLATE NOCASE",
  ).pluck().get();
  if (schemaSql === undefined) {
    assertSchema(db, []);
    return { exists: false, version: 0 };
  }
  if (typeof schemaSql !== 'string' || normalizeSql(schemaSql) !== SCHEMA_TABLE_SQL) {
    throw new Error(MALFORMED_SCHEMA_ERROR);
  }

  const rows = db.prepare('SELECT version FROM workflow_schema').pluck().all();
  const version = rows[0];
  if (rows.length !== 1 || typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new Error(MALFORMED_SCHEMA_ERROR);
  }
  if (version > WORKFLOW_DB_SCHEMA_VERSION) throw new Error(UNSUPPORTED_SCHEMA_ERROR);
  const expected = [VERSION_ZERO_SCHEMA, SCHEMA_V1, SCHEMA_V2, SCHEMA_V3, SCHEMA_V4][version];
  if (!expected) throw new Error(UNSUPPORTED_SCHEMA_ERROR);
  assertSchema(db, expected);
  return { exists: true, version };
}

function existingNonSymlink(path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(SYMLINK_ERROR);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function enforceModeNoFollow(path: string, flags: number, mode: number, error: string): void {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error(NO_FOLLOW_ERROR);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, flags | constants.O_NOFOLLOW, mode);
    fchmodSync(descriptor, mode);
    if ((fstatSync(descriptor).mode & 0o777) !== mode) throw new Error(error);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(SYMLINK_ERROR);
    throw cause;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function prepareDefaultStore(databasePath: string): void {
  const parent = dirname(databasePath);
  const files = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  existingNonSymlink(parent);
  for (const path of files) existingNonSymlink(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  enforceModeNoFollow(parent, constants.O_RDONLY, 0o700, 'Workflow database directory must have mode 0700.');
  enforceModeNoFollow(databasePath, constants.O_RDWR | constants.O_CREAT, 0o600,
    'Workflow database files must have mode 0600.');
}

function enforceDefaultStorePermissions(databasePath: string): void {
  const parent = dirname(databasePath);
  enforceModeNoFollow(parent, constants.O_RDONLY, 0o700, 'Workflow database directory must have mode 0700.');
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existingNonSymlink(path)) {
      enforceModeNoFollow(path, constants.O_RDWR, 0o600, 'Workflow database files must have mode 0600.');
    }
  }
}

function ensureDatabaseDirectory(databasePath: string, defaultStore: boolean): void {
  if (defaultStore && process.platform !== 'win32') prepareDefaultStore(databasePath);
  else mkdirSync(dirname(databasePath), { recursive: true });
}

export function migrateWorkflowDatabase(db: Database.Database): void {
  const migrate = db.transaction(() => {
    let state = readSchemaState(db);
    if (state.version === WORKFLOW_DB_SCHEMA_VERSION) return;
    if (state.version === 0) {
      if (!state.exists) db.exec(CREATE_SCHEMA_TABLE_SQL);
      db.exec(CREATE_DOMAIN_SCHEMA_V1_SQL);
      db.prepare('DELETE FROM workflow_schema').run();
      db.prepare('INSERT INTO workflow_schema (version) VALUES (1)').run();
      state = readSchemaState(db);
    }
    if (state.version === 1) {
      db.exec(MIGRATE_V1_TO_V2_SQL);
      db.prepare('UPDATE workflow_schema SET version = 2').run();
      state = readSchemaState(db);
    }
    if (state.version === 2) {
      db.exec(MIGRATE_V2_TO_V3_SQL);
      db.prepare('UPDATE workflow_schema SET version = 3').run();
      state = readSchemaState(db);
    }
    if (state.version === 3) {
      db.exec(MIGRATE_V3_TO_V4_SQL);
      db.prepare('UPDATE workflow_schema SET version = 4').run();
      state = readSchemaState(db);
    }
    if (state.version !== WORKFLOW_DB_SCHEMA_VERSION) throw new Error(UNSUPPORTED_SCHEMA_ERROR);
  });
  migrate.immediate();
}

export function openWorkflowDatabase(databasePath = WORKFLOWS_DB_PATH): Database.Database {
  const resolvedPath = resolve(databasePath);
  const defaultStore = resolvedPath === resolve(WORKFLOWS_DB_PATH);
  ensureDatabaseDirectory(resolvedPath, defaultStore);
  const db = new Database(resolvedPath);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    migrateWorkflowDatabase(db);
    db.pragma('journal_mode = WAL');
    db.prepare('SELECT version FROM workflow_schema LIMIT 1').get();
    if (defaultStore && process.platform !== 'win32') enforceDefaultStorePermissions(resolvedPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
