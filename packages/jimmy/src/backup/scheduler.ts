import type Database from "better-sqlite3";
import { loadConfig as loadConfigFromDisk } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { redactText } from "../shared/redact.js";
import type { JinnConfig } from "../shared/types.js";
import { errorMessage, formatBytes } from "./format.js";
import { BACKUP_TARGETS, runBackup, type BackupRunOptions, type BackupRunReport, type BackupTargetName } from "./run.js";
import { resolveBackupSettings, type BackupSettings } from "./settings.js";
import { applyRunReport, dueTargets, mergeStates, readBackupState, writeBackupState, type BackupState } from "./state.js";

/** Boot has stale sessions to recover and connectors to start; the backup waits for that. */
const FIRST_CHECK_DELAY_MS = 15_000;
/** How often "is anything a day old yet" is asked. The answer is cheap: one small file. */
const CHECK_INTERVAL_MS = 15 * 60_000;
const MAX_ERROR_CHARS = 300;
const MAX_LOGGED_WARNINGS = 5;

type BackupConfig = Pick<JinnConfig, "backup">;

/** What `/api/status` reports about backups, beside the disk-space block it already carries. */
export interface BackupStatus {
  /** "warning" while the latest attempt at any target is a failure. */
  level: "ok" | "warning" | "disabled" | "unknown";
  directory: string | null;
  targets: Partial<Record<BackupTargetName, { lastSuccessAt: string | null; lastAttemptAt: string | null; error: string | null }>>;
}

export interface BackupSchedulerOptions {
  /** The gateway's own registry connection. A copy made through it is not restarted by the gateway's writes. */
  database: Database.Database;
  /** The config the gateway booted with. */
  config: BackupConfig;
  home?: string;
  now?: () => Date;
  /** Re-read on every check, so an edit to config.yaml takes effect without a restart. */
  loadConfig?: () => BackupConfig;
  run?: (options: BackupRunOptions) => Promise<BackupRunReport>;
  firstCheckDelayMs?: number;
  checkIntervalMs?: number;
}

export interface BackupScheduler {
  /** Cancels the timer. A run already in flight finishes on its own. */
  stop(): void;
  /** Runs one check now and resolves when it is done. A no-op while another is in flight. */
  check(): Promise<void>;
}

const unknownStatus = (): BackupStatus => ({ level: "unknown", directory: null, targets: {} });

let published: BackupStatus = unknownStatus();

/** The running gateway's backup health. "unknown" when no scheduler is active. */
export function getBackupStatus(): BackupStatus {
  return published;
}

function statusOf(settings: BackupSettings, state: BackupState): BackupStatus {
  const targets: BackupStatus["targets"] = {};
  for (const name of BACKUP_TARGETS) {
    const target = state.targets[name];
    if (!target) continue;
    targets[name] = {
      lastSuccessAt: target.lastSuccessAt ?? null,
      lastAttemptAt: target.lastAttemptAt ?? null,
      // Whatever went wrong may have been quoting a file; nothing secret leaves through a status page.
      error: target.lastError === undefined ? null : redactText(target.lastError).slice(0, MAX_ERROR_CHARS),
    };
  }
  const reported = Object.values(targets);
  const complete = reported.length === BACKUP_TARGETS.length && reported.every((target) => target.lastSuccessAt !== null);
  const level = !settings.enabled
    ? "disabled"
    : reported.some((target) => target.error !== null) ? "warning" : complete ? "ok" : "unknown";
  return { level, directory: settings.directory, targets };
}

function logReport(report: BackupRunReport): void {
  for (const target of report.targets) {
    if (target.status === "failed") logger.error(`Backup failed (${target.name}): ${target.error ?? "unknown error"}`);
    if (target.status === "ok") {
      const size = target.bytes === undefined ? "" : ` (${formatBytes(target.bytes)})`;
      logger.info(`Backup written (${target.name})${target.file ? `: ${target.file}` : ""}${size}`);
    }
    for (const warning of target.warnings.slice(0, MAX_LOGGED_WARNINGS)) logger.warn(`Backup (${target.name}): ${warning}`);
    if (target.warnings.length > MAX_LOGGED_WARNINGS) {
      logger.warn(`Backup (${target.name}): ${target.warnings.length - MAX_LOGGED_WARNINGS} more warning(s) not shown`);
    }
  }
  if (report.pruned.length > 0) logger.info(`Backup: removed ${report.pruned.length} expired file(s) from ${report.directory}`);
}

/**
 * Keeps the instance backed up for as long as the gateway runs.
 *
 * The backup used to happen once, at boot, so a gateway that stayed up for a
 * week made one copy that week. Here a timer asks every few minutes whether any
 * target's last success is a day old, and runs just those. What "last success"
 * means is read from the state file beside the backups on every check, so it
 * survives a restart and a backup taken with `ryoko backup run` counts too.
 *
 * Nothing here is awaited by boot: the first check is deferred, and a failure
 * is logged and reported through `getBackupStatus()` rather than thrown.
 */
export function startBackupScheduler(options: BackupSchedulerOptions): BackupScheduler {
  const home = options.home ?? JINN_HOME;
  const now = options.now ?? (() => new Date());
  const run = options.run ?? runBackup;
  const loadConfig = options.loadConfig ?? loadConfigFromDisk;
  const checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
  let settings = resolveBackupSettings(options.config.backup, home);
  let state = readBackupState(settings.directory);
  let warned = "";
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;

  const warnAboutSettings = (): void => {
    const text = settings.warnings.join("\n");
    if (text === warned) return;
    warned = text;
    for (const warning of settings.warnings) logger.warn(`Backup settings: ${warning}`);
  };

  const refreshSettings = (): void => {
    const previous = settings.directory;
    try {
      settings = resolveBackupSettings(loadConfig().backup, home);
    } catch {
      // config.yaml does not parse right now. The settings that last did still apply.
    }
    warnAboutSettings();
    // A directory the config newly points at starts from its own history, so it
    // gets its first backup now rather than whenever the old one would be due.
    state = settings.directory === previous
      ? mergeStates(state, readBackupState(settings.directory))
      : readBackupState(settings.directory);
  };

  const backUp = async (due: readonly BackupTargetName[]): Promise<void> => {
    const report = await run({
      home,
      settings,
      now: now(),
      targets: due,
      databases: { sessions: () => ({ database: options.database, release: () => {} }) },
    });
    state = applyRunReport(state, report);
    try {
      writeBackupState(settings.directory, state);
    } catch {
      // The run has already said why this directory cannot be written. The
      // state stays in memory, so the retry still waits its hour.
    }
    logReport(report);
  };

  const check = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      refreshSettings();
      const due = settings.enabled ? dueTargets(state, now()) : [];
      if (due.length > 0) await backUp(due);
    } catch (error) {
      logger.error(`Backup check failed: ${errorMessage(error)}`);
    } finally {
      running = false;
      if (!stopped) published = statusOf(settings, state);
    }
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => { void check().finally(() => schedule(checkIntervalMs)); }, delayMs);
    timer.unref();
  };

  warnAboutSettings();
  published = statusOf(settings, state);
  schedule(options.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      published = unknownStatus();
    },
    check,
  };
}
