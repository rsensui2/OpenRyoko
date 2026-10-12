import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { serializeManifest, type BackupManifest, type ManifestEntry } from "../manifest.js";
import { encodeTarEntry, tarPadding, TAR_TRAILER, type TarEntry } from "../tar.js";
import { MANIFEST_ENTRY_PATH } from "../targets.js";

/** Every path a home fixture writes that a home archive must carry. */
export const HOME_CONTENT: Record<string, string> = {
  "config.yaml": "gateway:\n  port: 7901\n  host: 127.0.0.1\n",
  // Keys some operators keep beside the config for their scripts.
  ".env": "SCRIPT_API_KEY=placeholder\n",
  "cron/jobs.json": '[{"id":"daily","schedule":"0 7 * * *"}]\n',
  "cron/runs/daily.jsonl": '{"status":"ok"}\n',
  "AGENTS.md": "# Agents\n",
  "CLAUDE.md": "@AGENTS.md\n",
  "SOUL.md": "# Soul\n",
  "IDENTITY.md": "# Identity\n",
  "TOOLS.md": "# Tools\n",
  "BOOTSTRAP.md": "first run\n",
  // A document the operator added: not a name the template knows.
  "MANIFEST.md": "# What lives where\n",
  "MEMORY.md": "- remembers things\n",
  "memory/2026-10-11.md": "daily note\n",
  "org/lead.yaml": "name: lead\n",
  "skills/demo/SKILL.md": "---\nname: demo\n---\n",
  "skills/demo/run.sh": "#!/bin/sh\necho demo\n",
  "skills.json": '{"skills":[]}\n',
  "docs/overview.md": "# Overview\n",
  "knowledge/議事録/notes.md": "a durable note\n",
  "workflows/legacy-v1-import-report.json": "{}\n",
};

/** What lives in a home and must stay out of the archive. */
export const HOME_JUNK: Record<string, string> = {
  "logs/gateway.log": "log line\n",
  "tmp/scratch.txt": "scratch\n",
  "files/abc/upload.bin": "binary\n",
  "backups/older-notes.txt": "kept beside the backups\n",
  ".migration-backups/config.yaml.bak": "old\n",
  "node_modules/left-pad/index.js": "module.exports = 1\n",
  "skills/demo/node_modules/dep/index.js": "module.exports = 2\n",
  "skills/demo/.git/config": "[core]\n",
  "skills/demo/.venv/pyvenv.cfg": "home = /usr\n",
  "skills/demo/__pycache__/mod.pyc": "bytecode\n",
  "cron/commands/abc/running.lock": "{}\n",
  "sessions/notes.json": "{}\n",
  "gateway-auth.json": '{"value":"placeholder"}\n',
  ".claude/settings.local.json": "{}\n",
  // Beside the documents, and not one of them: a retired copy, a plain note,
  // and a directory whose name only ends like a document's.
  "AGENTS.md.bak-20261001": "an older copy\n",
  "notes.txt": "not a document the backup knows\n",
  "drafts.md/inner.txt": "a directory, not a document\n",
};

const scratch: string[] = [];

export function tempDir(prefix = "ryoko-backup-test-"): string {
  // realpath: macOS hands out /var/... which is a symlink into /private/var/...
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of scratch.splice(0)) {
    try { fs.chmodSync(dir, 0o700); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function writeTree(root: string, entries: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(entries)) {
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
}

function seedDatabase(file: string, table: string, rows: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`);
    const insert = db.prepare(`INSERT INTO ${table} (label) VALUES (?)`);
    for (let index = 0; index < rows; index += 1) insert.run(`${table}-${index}`);
  } finally {
    db.close();
  }
}

export interface HomeOptions {
  /** Rows in sessions/registry.db. Omit for a home with no registry. */
  sessionRows?: number;
  /** Rows in workflows/workflows.db. Omit for a home with no workflow store. */
  workflowRows?: number;
}

/** A synthetic instance home: the content worth keeping, the bulk that is not. */
export function makeHome(root: string, name = "home", options: HomeOptions = {}): string {
  const home = path.join(root, name);
  writeTree(home, HOME_CONTENT);
  writeTree(home, HOME_JUNK);
  fs.chmodSync(path.join(home, "skills", "demo", "run.sh"), 0o755);
  if (options.sessionRows !== undefined) seedDatabase(path.join(home, "sessions", "registry.db"), "sessions", options.sessionRows);
  if (options.workflowRows !== undefined) seedDatabase(path.join(home, "workflows", "workflows.db"), "workflows", options.workflowRows);
  return home;
}

const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * Puts a database at `file` the way a process that cannot see its locks finds
 * one mid-flight: committed rows that live only in the WAL, and nobody visibly
 * holding it. This is what a gateway in a container looks like from the host
 * across a bind mount, and what a killed gateway leaves behind. Anything that
 * opens it read-write, believing itself alone, checkpoints the WAL into the
 * main file and deletes it.
 */
export function leaveMidFlight(file: string, table: string, rows: number): void {
  const source = `${file}.source`;
  seedDatabase(source, table, 1);
  const writer = new Database(source);
  try {
    writer.pragma("wal_autocheckpoint = 0");
    const insert = writer.prepare(`INSERT INTO ${table} (label) VALUES (?)`);
    for (let index = 1; index < rows; index += 1) insert.run(`${table}-${index}`);
    for (const suffix of DATABASE_FILE_SUFFIXES) fs.copyFileSync(`${source}${suffix}`, `${file}${suffix}`);
  } finally {
    writer.close();
    for (const suffix of DATABASE_FILE_SUFFIXES) fs.rmSync(`${source}${suffix}`, { force: true });
  }
}

/** Stamps a database and whatever sidecars it has as last written at `when`. */
export function setDatabaseModified(file: string, when: Date): void {
  for (const suffix of DATABASE_FILE_SUFFIXES) {
    if (fs.existsSync(`${file}${suffix}`)) fs.utimesSync(`${file}${suffix}`, when, when);
  }
}

/**
 * Everything about a database's files that reading must not disturb: which of
 * the three exist, their bytes, and when they were last written.
 */
export function databaseFingerprint(file: string): Record<string, string> {
  return Object.fromEntries(DATABASE_FILE_SUFFIXES.map((suffix) => {
    const target = `${file}${suffix}`;
    if (!fs.existsSync(target)) return [`database${suffix}`, "absent"];
    const stat = fs.statSync(target);
    return [`database${suffix}`, `${stat.size} bytes, sha256 ${sha256(fs.readFileSync(target))}, mtime ${stat.mtimeMs}`];
  }));
}

export function rowCount(file: string, table: string): number {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

export const sha256 = (data: Buffer | string): string => crypto.createHash("sha256").update(data).digest("hex");

export interface RawArchiveEntry {
  entry: TarEntry;
  data?: Buffer;
  /** Leave this entry out of the generated manifest. */
  unlisted?: boolean;
}

export function rawFile(entryPath: string, contents: string, mode = 0o644): RawArchiveEntry {
  const data = Buffer.from(contents, "utf8");
  return { entry: { path: entryPath, type: "file", mode, size: data.length, mtimeSeconds: 1_760_000_000 }, data };
}

export function rawDirectory(entryPath: string): RawArchiveEntry {
  return { entry: { path: entryPath, type: "directory", mode: 0o755, size: 0, mtimeSeconds: 1_760_000_000 } };
}

export function rawSymlink(entryPath: string, linkTarget: string): RawArchiveEntry {
  return { entry: { path: entryPath, type: "symlink", mode: 0o777, size: 0, mtimeSeconds: 1_760_000_000, linkTarget } };
}

function manifestEntryFor({ entry, data }: RawArchiveEntry): ManifestEntry {
  if (entry.type === "file") return { path: entry.path, type: "file", mode: entry.mode, size: entry.size, sha256: sha256(data ?? Buffer.alloc(0)) };
  if (entry.type === "symlink") return { path: entry.path, type: "symlink", mode: entry.mode, target: entry.linkTarget ?? "" };
  return { path: entry.path, type: "directory", mode: entry.mode };
}

const byPath = <T extends { path: string }>(a: T, b: T): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Writes an archive by hand, entry by entry, so tests can produce the ones the
 * real writer never would: paths that climb out of the home, entries the
 * manifest does not vouch for, contents that disagree with their recorded hash.
 *
 * Entries and manifest are put in path order, as the real writer leaves them,
 * unless `preserveOrder` asks for exactly what was given.
 */
export function writeRawArchive(
  file: string,
  given: RawArchiveEntry[],
  manifestOverride?: (manifest: BackupManifest) => BackupManifest | null,
  options: { preserveOrder?: boolean } = {},
): string {
  const entries = options.preserveOrder ? given : [...given].sort((a, b) => byPath(a.entry, b.entry));
  const generated: BackupManifest = {
    schemaVersion: 1,
    format: "openryoko-home-archive",
    id: path.basename(file).replace(/\.tar\.gz$/, ""),
    createdAt: "2026-10-12T03:00:00.000Z",
    home: "/synthetic/home",
    contentBytes: entries.reduce((total, { entry }) => total + entry.size, 0),
    entries: entries.filter((item) => !item.unlisted).map(manifestEntryFor),
    skipped: [],
  };
  const overridden = manifestOverride ? manifestOverride(generated) : generated;
  const manifest = overridden && !options.preserveOrder ? { ...overridden, entries: [...overridden.entries].sort(byPath) } : overridden;
  const blocks: Buffer[] = [];
  for (const { entry, data } of entries) {
    const body = data ?? Buffer.alloc(0);
    blocks.push(encodeTarEntry(entry), body, tarPadding(body.length));
  }
  if (manifest) {
    const body = serializeManifest(manifest);
    blocks.push(
      encodeTarEntry({ path: MANIFEST_ENTRY_PATH, type: "file", mode: 0o600, size: body.length, mtimeSeconds: 1_760_000_000 }),
      body,
      tarPadding(body.length),
    );
  }
  blocks.push(TAR_TRAILER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(blocks)), { mode: 0o600 });
  return file;
}
