/**
 * `ryoko backup run | list | verify <id> | restore <id>`.
 *
 * Works on the home the command resolves to and on nothing else. By default no
 * command here opens a database in that home. `run` archives the files and
 * leaves the registry and the workflow store to the gateway, which copies them
 * itself once a day through connections of its own. `list`, `verify` and
 * `restore` open only files in the backup directory, and a database that is
 * being replaced is replaced without being opened.
 *
 * The reason is the same throughout. A connection to a database a gateway has
 * open is not harmless even read-only (see `readOnlyDatabaseSource`), and from
 * the host side of a bind mount into a container this command cannot tell that
 * the gateway is there. So `run --include-databases` copies the databases only
 * while nothing suggests a gateway is running, and a database restore also
 * asks the operator to say that none is, with `--gateway-stopped`. Restoring
 * files is safe under a running gateway: its watchers reload what changed.
 *
 * Every command takes `--json`, and reports failure through the exit code.
 */
import { inspectHomeArchive } from "../backup/archive.js";
import { findBackup, listBackups, pruneBackups, type BackupItem } from "../backup/catalog.js";
import { GATEWAY_STOPPED_FLAG, inspectDatabaseBackup, restoreDatabase, type DatabaseRestoreResult } from "../backup/database-restore.js";
import { INCLUDE_DATABASES_FLAG, standaloneDatabaseSources, type WithheldReason } from "../backup/database-source.js";
import { errorMessage, formatBytes } from "../backup/format.js";
import { restoreHomeArchive, type RestoreResult } from "../backup/restore.js";
import { runBackup, type BackupRunReport, type BackupTargetReport } from "../backup/run.js";
import { archiveLimits, resolveBackupSettings, type BackupSettings } from "../backup/settings.js";
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
  /** When the command started. */
  now: Date;
  /** The time as it is when asked, for a judgement made later in the command. */
  clock: () => Date;
  settings: BackupSettings;
  json: boolean;
}

const STANDARD_IO: BackupCliIo = {
  out: (text) => { process.stdout.write(`${text}\n`); },
  err: (text) => { process.stderr.write(`${text}\n`); },
};

/**
 * Why config.yaml could not be read, in words that carry none of it.
 *
 * A YAML parse error is the dangerous one. Its message quotes the lines around
 * the fault, and its one-line reason can name the very thing it tripped over -
 * `unidentified alias "..."` repeats whatever followed a `*`. In this file the
 * lines are the ones that hold tokens, and this goes to a terminal, a log or an
 * agent's transcript. So only the position is passed on: enough to open the
 * file at the right place.
 */
function describeConfigError(error: unknown): string {
  const parse = error as { name?: unknown; mark?: { line?: unknown; column?: unknown } } | null;
  if (parse?.name === "YAMLException") {
    const { line, column } = parse.mark ?? {};
    return typeof line === "number" && typeof column === "number"
      ? `YAML の構文エラー: ${line + 1} 行目 ${column + 1} 桁目`
      : "YAML の構文エラー";
  }
  // Anything else is about the file as a whole - missing, unreadable - and names at most its path.
  return errorMessage(error).split("\n")[0]!;
}

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
    io.err(`config.yaml を読めないため、既定のバックアップ設定で続けます（${describeConfigError(error)}）`);
  }
  const settings = resolveBackupSettings(section, home);
  for (const warning of settings.warnings) io.err(`設定の警告: ${warning}`);
  const clock = deps.now ?? (() => new Date());
  return { home, io, now: clock(), clock, settings, json: json === true };
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
const STATUS_LABELS: Record<Exclude<BackupTargetReport["status"], "withheld">, string> = {
  ok: "ok        ", skipped: "スキップ  ", failed: "失敗      ",
};

/** A database left unopened: 対象外 when nobody asked for it, 見送り when it was asked for and a gateway seems to be there. */
const WITHHELD: Record<WithheldReason, { label: string; why: string }> = {
  "not-requested": { label: "対象外    ", why: "このコマンドでは開きません" },
  "gateway-running": { label: "見送り    ", why: "gateway が動いているようなので開いていません" },
};

const withheldAs = (target: BackupTargetReport): (typeof WITHHELD)[WithheldReason] => WITHHELD[target.reason ?? "not-requested"];

function describeTarget(target: BackupTargetReport): string {
  if (target.status === "failed") return target.error ?? "failed";
  if (target.status === "withheld") return withheldAs(target).why;
  if (target.status === "skipped") return target.detail ?? "";
  const id = target.file ? listingId(target.file) : "";
  return `${id}  ${target.bytes === undefined ? "" : formatBytes(target.bytes)}`.trim();
}

function listingId(file: string): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  return name.replace(/\.tar\.gz$|\.db$/, "");
}

/**
 * What a person is owed when a database was left unopened: who does copy it,
 * and how to get it from here. Somebody running this before a risky change
 * should not walk away believing the registry is in the backup they just took.
 */
function databaseNotes(report: BackupRunReport, settings: BackupSettings): string[] {
  const withheld = report.targets.filter((target) => target.status === "withheld");
  if (withheld.length === 0) return [];
  const daily = settings.enabled
    ? "DB は、gateway が動いている間、1日1回、自分でコピーします。"
    : "日次のバックアップは無効（backup.enabled: false）なので、DB はいまどこからもコピーされていません。";
  const held = withheld.find((target) => target.reason === "gateway-running");
  if (held) return [held.detail ?? "", `${daily}ファイルのアーカイブは取りました。`];
  return [
    `${daily}このコマンドが取るのは、設定・cron・人格・記憶などのファイルです。`,
    `DB もここで取るのは、gateway を止めているときだけです: ryoko backup run ${INCLUDE_DATABASES_FLAG}`,
  ];
}

function printRun(io: BackupCliIo, report: BackupRunReport, settings: BackupSettings): void {
  io.out(`バックアップ先: ${report.directory}`);
  for (const target of report.targets) {
    const label = target.status === "withheld" ? withheldAs(target).label : STATUS_LABELS[target.status];
    io.out(`${label}${target.name.padEnd(11)}${describeTarget(target)}`);
    for (const warning of target.warnings.slice(0, MAX_LISTED_PATHS)) io.out(`  警告: ${warning}`);
    if (target.warnings.length > MAX_LISTED_PATHS) io.out(`  警告: ほか ${target.warnings.length - MAX_LISTED_PATHS} 件`);
  }
  for (const note of databaseNotes(report, settings)) io.out(note);
  if (report.pruned.length > 0) io.out(`保持の範囲を外れたバックアップを ${report.pruned.length} 件削除しました`);
}

/**
 * `ryoko backup run`: archive the home's files now, whatever the daily schedule
 * says. The databases are copied as well only on request, and then only while
 * nothing suggests a gateway is running; left alone after being asked for, they
 * make the exit code non-zero.
 */
export async function runBackupRun(options: { json?: boolean; includeDatabases?: boolean } = {}, deps: BackupCliDeps = {}): Promise<void> {
  await guarded(deps, options.json, async ({ home, io, now, clock, settings, json }) => {
    const databases = options.includeDatabases ? { databases: standaloneDatabaseSources(home, clock) } : {};
    const report = await runBackup({ home, settings, now, ...databases });
    try {
      // Shared with the gateway's scheduler: what was copied by hand counts as today's, and what was left alone does not.
      writeBackupState(settings.directory, applyRunReport(readBackupState(settings.directory), report));
    } catch { /* the report already says why this directory cannot be written */ }
    if (json) printJson(io, report);
    else printRun(io, report, settings);
    if (report.status !== "ok") process.exitCode = 1;
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

async function verify(item: BackupItem, settings: BackupSettings): Promise<Verdict> {
  const base = { id: item.id, kind: item.kind, file: item.file };
  if (item.kind !== "home") {
    const problems = inspectDatabaseBackup(item.file);
    return { ...base, ok: problems.length === 0, problems };
  }
  // Under the instance's limits: a file planted in the backup directory is read only as far as they reach.
  const inspection = await inspectHomeArchive(item.file, { limits: archiveLimits(settings) });
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
    const verdict = await verify(findBackup(settings.directory, reference), settings);
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

/** 権限: the content already matches and only the permissions are put back. */
const ACTION_LABELS: Record<RestoreResult["changes"][number]["action"], string> = { create: "作成", replace: "置換", mode: "権限" };

function printPaths(io: BackupCliIo, label: string, paths: string[]): void {
  if (paths.length === 0) return;
  const shown = paths.slice(0, MAX_LISTED_PATHS).join(", ");
  io.out(`${label}: ${paths.length} 件（${shown}${paths.length > MAX_LISTED_PATHS ? " ほか" : ""}）`);
}

/**
 * Where the previous state went, and what going back to it does and does not
 * do. Going back is itself a restore, and a restore only ever writes: what was
 * overwritten returns, and what this restore created - which was not there to
 * be saved - stays. Said here, at the moment someone might count on it.
 */
function printWayBack(io: BackupCliIo, result: RestoreResult): void {
  if (!result.preRestore) return;
  const { id } = result.preRestore;
  io.out(`復元前の状態は ${id} に退避しました。上書きした内容を戻すには: ryoko backup restore ${id}`);
  const created = result.changes.filter((change) => change.action === "create").length;
  if (created === 0) return;
  io.out(
    `この復元で新しく作成した ${created} 件は、${id} へ戻しても消えません（復元は上書きだけで、削除はしません）。`
    + "不要なものは、上の「作成」の行を見て手で消してください。",
  );
}

function printFileRestore(io: BackupCliIo, result: RestoreResult): void {
  io.out(`${result.dryRun ? "[dry-run] " : ""}${result.id} から復元${result.dryRun ? "する場合" : "しました"}（種類: ${result.kinds.join(", ")}）`);
  for (const change of result.changes.slice(0, MAX_LISTED_CHANGES)) {
    io.out(`${ACTION_LABELS[change.action]}    ${change.path}${change.type === "file" ? "" : `（${change.type}）`}`);
  }
  if (result.changes.length > MAX_LISTED_CHANGES) io.out(`...ほか ${result.changes.length - MAX_LISTED_CHANGES} 件`);
  if (result.changes.length === 0) io.out("ホームはすでにこのバックアップと一致しています。何も書き込みません。");
  io.out(`変更なし: ${result.unchanged} 件`);
  printPaths(io, "バックアップに無いので手を付けないファイル", result.untouched);
  printPaths(io, "アーカイブ対象外のため無視したエントリ", result.ignored);
  printWayBack(io, result);
}

function printDatabaseRestore(io: BackupCliIo, result: DatabaseRestoreResult): void {
  io.out(`${result.dryRun ? "[dry-run] " : ""}${result.name} の DB を ${result.destination} へ復元${result.dryRun ? "できます" : "しました"}`);
  if (result.dryRun) {
    io.out(`実際に復元するには、gateway を止めてから ${GATEWAY_STOPPED_FLAG} を付けて実行してください。`);
    io.out("ホームをコンテナに bind mount している場合は、gateway が動いているコンテナの中で実行します（ホスト側からは、稼働中の gateway を確実には検知できません）。");
    return;
  }
  if (result.preRestore) {
    io.out(`置き換え前の DB は ${result.preRestore.id} に退避しました。元に戻すには: ryoko backup restore ${result.preRestore.id} ${GATEWAY_STOPPED_FLAG}`);
  }
  io.out("gateway を起動してください: ryoko start");
}

export interface BackupRestoreCliOptions {
  /** Comma-separated kinds. Home archives only. */
  only?: string;
  dryRun?: boolean;
  allowExternalSymlinks?: boolean;
  /** Database backups only: the operator's confirmation that the gateway is stopped. */
  gatewayStopped?: boolean;
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
    /** What this restore saved before it replaced anything. */
    let saved: string | undefined;
    if (item.kind !== "home") {
      if (kinds) throw new Error("--only はホームのアーカイブにだけ使えます。DB のバックアップは丸ごと復元します。");
      const result = await restoreDatabase({
        backup: item.file, name: item.kind, home, backupDirectory: settings.directory, now, dryRun: options.dryRun,
        gatewayStopped: options.gatewayStopped,
      });
      saved = result.preRestore?.file;
      if (json) printJson(io, result);
      else printDatabaseRestore(io, result);
    } else {
      const result = await restoreHomeArchive({
        archive: item.file, home, only: kinds, dryRun: options.dryRun,
        allowExternalSymlinks: options.allowExternalSymlinks, backupDirectory: settings.directory, now,
        limits: archiveLimits(settings),
      });
      saved = result.preRestore?.file;
      if (json) printJson(io, result);
      else printFileRestore(io, result);
    }
    if (options.dryRun) return;
    try {
      // What was just saved is the way back from this restore: not this run's to trim, whatever the time in its name.
      pruneBackups(settings.directory, { retention: settings.retention, now, keep: saved ? [saved] : [] });
    } catch { /* the restore is done; trimming old snapshots can wait for the next run */ }
  });
}
