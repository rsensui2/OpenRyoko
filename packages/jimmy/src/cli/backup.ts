/**
 * `ryoko backup run | list | verify <id> | restore <id>`.
 *
 * Works on the home the command resolves to and on nothing else, with the
 * gateway up or down: a backup reads files and copies databases through a
 * read-only connection, and a restore of files is safe under a running gateway
 * (its watchers reload what changed). Only a database restore needs the gateway
 * stopped, and it checks.
 *
 * Every command takes `--json`, and reports failure through the exit code.
 */
import { inspectHomeArchive } from "../backup/archive.js";
import { findBackup, listBackups, pruneBackups, type BackupItem } from "../backup/catalog.js";
import { inspectDatabaseBackup, restoreDatabase, type DatabaseRestoreResult } from "../backup/database-restore.js";
import { errorMessage, formatBytes } from "../backup/format.js";
import { restoreHomeArchive, type RestoreResult } from "../backup/restore.js";
import { runBackup, type BackupRunReport, type BackupTargetReport } from "../backup/run.js";
import { resolveBackupSettings, type BackupSettings } from "../backup/settings.js";
import { applyRunReport, readBackupState, writeBackupState } from "../backup/state.js";
import { BACKUP_KINDS, type BackupKind } from "../backup/targets.js";
import { loadConfig } from "../shared/config.js";
import { JINN_HOME } from "../shared/paths.js";
import type { JinnConfig } from "../shared/types.js";

const MAX_LISTED_CHANGES = 40;
const MAX_LISTED_PATHS = 10;

export interface BackupCliIo {
  out(text: string): void;
  err(text: string): void;
}

/** What the handlers reach outside themselves for. All of it replaceable, so they can be driven on a throwaway home. */
export interface BackupCliDeps {
  home?: string;
  io?: BackupCliIo;
  now?: () => Date;
  loadConfig?: () => Pick<JinnConfig, "backup">;
}

interface Context {
  home: string;
  io: BackupCliIo;
  now: Date;
  settings: BackupSettings;
  json: boolean;
}

const STANDARD_IO: BackupCliIo = {
  out: (text) => { process.stdout.write(`${text}\n`); },
  err: (text) => { process.stderr.write(`${text}\n`); },
};

/**
 * Resolves the settings the way the gateway does, except that an unreadable
 * config.yaml is not fatal here. It is the very thing a restore may have been
 * asked to fix, so the defaults are used and the operator is told.
 */
function contextFor(deps: BackupCliDeps, json: boolean | undefined): Context {
  const home = deps.home ?? JINN_HOME;
  const io = deps.io ?? STANDARD_IO;
  let section: JinnConfig["backup"];
  try {
    section = (deps.loadConfig ?? loadConfig)()?.backup;
  } catch (error) {
    // A YAML error carries a multi-line excerpt of the file; its first line says what and where.
    io.err(`config.yaml を読めないため、既定のバックアップ設定で続けます（${errorMessage(error).split("\n")[0]}）`);
  }
  const settings = resolveBackupSettings(section, home);
  for (const warning of settings.warnings) io.err(`設定の警告: ${warning}`);
  return { home, io, now: (deps.now ?? (() => new Date()))(), settings, json: json === true };
}

function printJson(io: BackupCliIo, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

/** Runs one command, turning anything it throws into a message and a non-zero exit. */
async function guarded(deps: BackupCliDeps, json: boolean | undefined, command: (context: Context) => Promise<void>): Promise<void> {
  const io = deps.io ?? STANDARD_IO;
  try {
    await command(contextFor(deps, json));
  } catch (error) {
    io.err(json ? JSON.stringify({ error: errorMessage(error) }) : errorMessage(error));
    process.exitCode = 1;
  }
}

/** Padded by hand to ten columns: full-width characters take two, which padEnd does not know. */
const STATUS_LABELS: Record<BackupTargetReport["status"], string> = { ok: "ok        ", skipped: "スキップ  ", failed: "失敗      " };

function describeTarget(target: BackupTargetReport): string {
  if (target.status === "failed") return target.error ?? "failed";
  if (target.status === "skipped") return target.detail ?? "";
  const id = target.file ? listingId(target.file) : "";
  return `${id}  ${target.bytes === undefined ? "" : formatBytes(target.bytes)}`.trim();
}

function listingId(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  return name.replace(/\.tar\.gz$|\.db$/, "");
}

function printRun(io: BackupCliIo, report: BackupRunReport): void {
  io.out(`バックアップ先: ${report.directory}`);
  for (const target of report.targets) {
    io.out(`${STATUS_LABELS[target.status]}${target.name.padEnd(11)}${describeTarget(target)}`);
    for (const warning of target.warnings.slice(0, MAX_LISTED_PATHS)) io.out(`  警告: ${warning}`);
    if (target.warnings.length > MAX_LISTED_PATHS) io.out(`  警告: ほか ${target.warnings.length - MAX_LISTED_PATHS} 件`);
  }
  if (report.pruned.length > 0) io.out(`保持数を超えたバックアップを ${report.pruned.length} 件削除しました`);
}

/** `ryoko backup run`: back everything up now, whatever the daily schedule says. */
export async function runBackupRun(options: { json?: boolean } = {}, deps: BackupCliDeps = {}): Promise<void> {
  await guarded(deps, options.json, async ({ home, io, now, settings, json }) => {
    const report = await runBackup({ home, settings, now });
    try {
      // Shared with the gateway's scheduler: a backup taken by hand counts as today's.
      writeBackupState(settings.directory, applyRunReport(readBackupState(settings.directory), report));
    } catch { /* the report already says why this directory cannot be written */ }
    if (json) printJson(io, report);
    else printRun(io, report);
    if (report.status === "failed") process.exitCode = 1;
  });
}

/** One line of `list`. A snapshot taken before a restore is recognisable by its `pre-restore-` id. */
function describeItem(item: BackupItem): string {
  const taken = item.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
  return `${item.id.padEnd(42)}${item.kind.padEnd(11)}${formatBytes(item.bytes).padStart(10)}  ${taken}`;
}

/** `ryoko backup list`: every backup in the directory, newest first. */
export async function runBackupList(options: { json?: boolean } = {}, deps: BackupCliDeps = {}): Promise<void> {
  await guarded(deps, options.json, async ({ io, settings, json }) => {
    const backups = listBackups(settings.directory);
    if (json) return printJson(io, { directory: settings.directory, backups });
    if (backups.length === 0) return io.out(`バックアップはまだありません（保存先: ${settings.directory}）`);
    io.out(`保存先: ${settings.directory}`);
    for (const item of backups) io.out(describeItem(item));
    io.out("検証: ryoko backup verify <id>   復元: ryoko backup restore <id> [--only <種類>] [--dry-run]");
  });
}

interface Verdict {
  id: string;
  kind: BackupItem["kind"];
  file: string;
  ok: boolean;
  problems: string[];
  /** Home archives only. */
  files?: number;
  contentBytes?: number;
}

async function verify(item: BackupItem): Promise<Verdict> {
  const base = { id: item.id, kind: item.kind, file: item.file };
  if (item.kind !== "home") {
    const problems = inspectDatabaseBackup(item.file);
    return { ...base, ok: problems.length === 0, problems };
  }
  const inspection = await inspectHomeArchive(item.file);
  return {
    ...base,
    ok: inspection.ok,
    problems: inspection.problems,
    ...(inspection.manifest
      ? { files: inspection.manifest.entries.filter((entry) => entry.type === "file").length, contentBytes: inspection.manifest.contentBytes }
      : {}),
  };
}

/** `ryoko backup verify <id>`: read a backup back and check it, without restoring anything. */
export async function runBackupVerify(reference: string, options: { json?: boolean } = {}, deps: BackupCliDeps = {}): Promise<void> {
  await guarded(deps, options.json, async ({ io, settings, json }) => {
    const verdict = await verify(findBackup(settings.directory, reference));
    if (json) printJson(io, verdict);
    else if (verdict.ok) {
      const detail = verdict.files === undefined ? "" : `（ファイル ${verdict.files} 件、${formatBytes(verdict.contentBytes ?? 0)}）`;
      io.out(`ok      ${verdict.id}${detail}`);
    } else {
      io.out(`失敗    ${verdict.id}`);
      for (const problem of verdict.problems) io.out(`  ${problem}`);
    }
    if (!verdict.ok) process.exitCode = 1;
  });
}

function parseKinds(only: string | undefined): BackupKind[] | undefined {
  if (only === undefined) return undefined;
  const names = only.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !(BACKUP_KINDS as readonly string[]).includes(name));
  if (unknown.length > 0 || names.length === 0) {
    throw new Error(`--only に指定できない種類です: ${unknown.join(", ") || "(空)"}（指定できる種類: ${BACKUP_KINDS.join(", ")}）`);
  }
  return names as BackupKind[];
}

function printPaths(io: BackupCliIo, label: string, paths: string[]): void {
  if (paths.length === 0) return;
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(", ");
  io.out(`${label}: ${paths.length} 件（${shown}${paths.length > MAX_LISTED_PATHS ? " ほか" : ""}）`);
}

function printFileRestore(io: BackupCliIo, result: RestoreResult): void {
  io.out(`${result.dryRun ? "[dry-run] " : ""}${result.id} から復元${result.dryRun ? "する場合" : "しました"}（種類: ${result.kinds.join(", ")}）`);
  for (const change of result.changes.slice(0, MAX_LISTED_CHANGES)) {
    io.out(`${change.action === "create" ? "作成" : "置換"}    ${change.path}${change.type === "file" ? "" : `（${change.type}）`}`);
  }
  if (result.changes.length > MAX_LISTED_CHANGES) io.out(`...ほか ${result.changes.length - MAX_LISTED_CHANGES} 件`);
  if (result.changes.length === 0) io.out("ホームはすでにこのバックアップと一致しています。何も書き込みません。");
  io.out(`変更なし: ${result.unchanged} 件`);
  printPaths(io, "バックアップに無いので手を付けないファイル", result.untouched);
  printPaths(io, "アーカイブ対象外のため無視したエントリ", result.ignored);
  if (result.preRestore) {
    io.out(`復元前の状態は ${result.preRestore.id} に退避しました。元に戻すには: ryoko backup restore ${result.preRestore.id}`);
  }
}

function printDatabaseRestore(io: BackupCliIo, result: DatabaseRestoreResult): void {
  io.out(`${result.dryRun ? "[dry-run] " : ""}${result.name} の DB を ${result.destination} へ復元${result.dryRun ? "できます" : "しました"}`);
  if (result.preRestore) {
    io.out(`置き換え前の DB は ${result.preRestore.id} に退避しました。元に戻すには: ryoko backup restore ${result.preRestore.id}`);
  }
  if (!result.dryRun) io.out("gateway を起動してください: ryoko start");
}

export interface BackupRestoreCliOptions {
  /** Comma-separated kinds. Home archives only. */
  only?: string;
  dryRun?: boolean;
  allowExternalSymlinks?: boolean;
  json?: boolean;
}

/**
 * `ryoko backup restore <id>`: files from a home archive, or a database from a
 * copy of it. Either way the state being replaced is saved first.
 */
export async function runBackupRestore(reference: string, options: BackupRestoreCliOptions = {}, deps: BackupCliDeps = {}): Promise<void> {
  await guarded(deps, options.json, async ({ home, io, now, settings, json }) => {
    const item = findBackup(settings.directory, reference);
    const kinds = parseKinds(options.only);
    if (item.kind !== "home") {
      if (kinds) throw new Error("--only はホームのアーカイブにだけ使えます。DB のバックアップは丸ごと復元します。");
      const result = await restoreDatabase({
        backup: item.file, name: item.kind, home, backupDirectory: settings.directory, now, dryRun: options.dryRun,
      });
      if (json) printJson(io, result);
      else printDatabaseRestore(io, result);
    } else {
      const result = await restoreHomeArchive({
        archive: item.file, home, only: kinds, dryRun: options.dryRun,
        allowExternalSymlinks: options.allowExternalSymlinks, backupDirectory: settings.directory, now,
      });
      if (json) printJson(io, result);
      else printFileRestore(io, result);
    }
    if (options.dryRun) return;
    try {
      pruneBackups(settings.directory, { retention: settings.retention, now });
    } catch { /* the restore is done; trimming old snapshots can wait for the next run */ }
  });
}
