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
    if (target.status === "failed") {
      // Said in the log because it is otherwise invisible: after this line there is a day of silence.
      const next = target.persistent
        ? ' This will not be retried until the next daily backup; once the cause is fixed, "ryoko backup run" takes one straight away.'
        : "";
      logger.error(`Backup failed (${target.name}): ${target.error ?? "unknown error"}${next}`);
    }
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
  const scheduler = new GatewayBackupScheduler(options);
  scheduler.start();
  return { stop: () => scheduler.stop(), check: () => scheduler.check() };
}

class GatewayBackupScheduler {
  private readonly home: string;
  private readonly now: () => Date;
  private readonly run: (options: BackupRunOptions) => Promise<BackupRunReport>;
  private readonly loadConfig: () => BackupConfig;
  private readonly checkIntervalMs: number;
  private settings: BackupSettings;
  private state: BackupState;
  /** The settings warnings last logged, so the same ones are not repeated on every check. */
  private warned = "";
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  constructor(private readonly options: BackupSchedulerOptions) {
    this.home = options.home ?? JINN_HOME;
    this.now = options.now ?? (() => new Date());
    this.run = options.run ?? runBackup;
    this.loadConfig = options.loadConfig ?? loadConfigFromDisk;
    this.checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
    this.settings = resolveBackupSettings(options.config.backup, this.home);
    this.state = readBackupState(this.settings.directory);
  }

  start(): void {
    this.warnAboutSettings();
    published = statusOf(this.settings, this.state);
    this.schedule(this.options.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    published = unknownStatus();
  }

  async check(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      this.refreshSettings();
      const due = this.settings.enabled ? dueTargets(this.state, this.now()) : [];
      if (due.length > 0) await this.backUp(due);
    } catch (error) {
      logger.error(`Backup check failed: ${errorMessage(error)}`);
    } finally {
      this.running = false;
      if (!this.stopped) published = statusOf(this.settings, this.state);
    }
  }

  /** The next check is only armed once this one has finished, so two never overlap. */
  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.check().finally(() => this.schedule(this.checkIntervalMs)); }, delayMs);
    this.timer.unref();
  }

  private warnAboutSettings(): void {
    const text = this.settings.warnings.join("\n");
    if (text === this.warned) return;
    this.warned = text;
    for (const warning of this.settings.warnings) logger.warn(`Backup settings: ${warning}`);
  }

  private refreshSettings(): void {
    const previous = this.settings.directory;
    try {
      this.settings = resolveBackupSettings(this.loadConfig().backup, this.home);
    } catch {
      // config.yaml does not parse right now. The settings that last did still apply.
    }
    this.warnAboutSettings();
    // A directory the config newly points at starts from its own history, so it
    // gets its first backup now rather than whenever the old one would be due.
    const onDisk = readBackupState(this.settings.directory);
    this.state = this.settings.directory === previous ? mergeStates(this.state, onDisk) : onDisk;
  }

  private async backUp(due: readonly BackupTargetName[]): Promise<void> {
    const report = await this.run({
      home: this.home,
      settings: this.settings,
      now: this.now(),
      targets: due,
      databases: { sessions: () => ({ database: this.options.database, release: () => {} }) },
    });
    this.state = applyRunReport(this.state, report);
    try {
      writeBackupState(this.settings.directory, this.state);
    } catch {
      // The run has already said why this directory cannot be written. The
      // state stays in memory, so the retry still waits its hour.
    }
    logReport(report);
  }
}
