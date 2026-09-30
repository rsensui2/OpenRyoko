// Run after pnpm build. Uses synthetic data in an isolated home; no engine or
// connector is started. Allocation-driven GC is intentional: explicit gc()
// alone does not reproduce nodejs/node#65446.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const home = mkdtempSync(path.join(os.tmpdir(), 'ryoko-sqlite-smoke-'));
process.env.RYOKO_HOME = home;
process.env.JINN_HOME = home;
let database;
try {
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/bin/jimmy.js', import.meta.url)), '--version'], {
    env: process.env, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(cli.status, 0, cli.stderr || String(cli.error));
  assert.match(cli.stdout, /\d+\.\d+\.\d+/);
  const registry = await import('../dist/src/sessions/registry.js');
  const { createDailyDatabaseBackup } = await import('../dist/src/sessions/backup.js');
  database = registry.initDb();
  const session = registry.createSession({ engine: 'claude', source: 'slack', sourceRef: 'smoke:recovery' });
  registry.insertMessage(session.id, 'user', 'sqlite compatibility smoke');
  assert.equal(registry.searchMessages('compatibility')[0]?.sessionId, session.id);
  registry.updateSession(session.id, { status: 'running', engineSessionId: 'synthetic-engine-id' });
  assert.equal(registry.recoverStaleSessions(), 1);
  assert.equal(registry.getInterruptedSessions()[0]?.id, session.id);

  const start = Date.now();
  let sessions = 1;
  let statements = 0;
  do {
    // Real registry operations plus the reporter's short-lived statement and
    // allocation pattern exercise collection while the DB remains open.
    const next = registry.createSession({ engine: 'claude', source: 'slack', sourceRef: `smoke:${sessions}` });
    registry.insertMessage(next.id, 'assistant', 'synthetic reply');
    assert.equal(registry.getSession(next.id)?.id, next.id);
    sessions++;
    for (let k = 0; k < 2000; k++) {
      assert.equal(database.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, sessions);
      globalThis.sqliteSmokeJunk = new Array(5000).fill(0).map((_, j) => ({ j, s: 'x'.repeat(50) }));
      statements++;
    }
    await yieldTurn();
  } while (Date.now() - start < 90_000);

  const backup = await createDailyDatabaseBackup(database, { directory: path.join(home, 'backups') });
  const restored = new Database(backup.file);
  try {
    assert.equal(restored.prepare('SELECT COUNT(*) AS c FROM sessions').get().c, sessions);
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(restored.prepare("SELECT COUNT(*) AS c FROM messages_fts WHERE messages_fts MATCH 'compatibility'").get().c, 1);
    restored.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('reopened', session.id);
    assert.equal(restored.prepare('SELECT title FROM sessions WHERE id = ?').get(session.id).title, 'reopened');
  } finally { restored.close(); }
  console.log(JSON.stringify({ node: process.version, sqlite: require('better-sqlite3/package.json').version,
    cli: cli.stdout.trim(), sessions, statements, elapsedMs: Date.now() - start, result: 'passed' }));
} finally {
  delete globalThis.sqliteSmokeJunk;
  database?.close();
  rmSync(home, { recursive: true, force: true });
}
