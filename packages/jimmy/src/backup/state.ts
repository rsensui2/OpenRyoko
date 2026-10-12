import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BACKUP_TARGETS, type BackupRunReport, type BackupTargetName } from "./run.js";

/** A target is due once its last success is this old. */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * A target that failed is tried again after this long, rather than on every
 * check. That is for a failure that may have passed: a full disk, a database
 * that could not be read. One that trying again cannot change waits a whole
 * BACKUP_INTERVAL_MS, the next daily run, like a success would.
 */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
export const BACKUP_STATE_FILE = "backup-state.json";

export interface TargetState {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  /** Present while the latest attempt is a failure. */
  lastError?: string;
  /** Beside `lastError`, when that failure is one trying again cannot change. */
  lastErrorPersistent?: true;
}

/**
 * When each target last ran, kept beside the backups. It is what lets "daily"
 * survive a restart, and what lets a `ryoko backup run` from the CLI count
 * towards the gateway's schedule.
 */
export interface BackupState {
  version: 1;
  targets: Partial<Record<BackupTargetName, TargetState>>;
}

const emptyState = (): BackupState => ({ version: 1, targets: {} });

function parseTarget(value: unknown): TargetState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const target: TargetState = {};
  for (const key of ["lastAttemptAt", "lastSuccessAt", "lastError"] as const) {
    if (typeof raw[key] === "string") target[key] = raw[key];
  }
  if (target.lastError !== undefined && raw.lastErrorPersistent === true) target.lastErrorPersistent = true;
  return target;
}

/** Reads the state file. Anything unreadable or unexpected counts as no history, never as an error. */
export function readBackupState(directory: string): BackupState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(directory, BACKUP_STATE_FILE), "utf8"));
  } catch {
    return emptyState();
  }
  const raw = parsed as { version?: unknown; targets?: unknown } | null;
  if (!raw || raw.version !== 1 || typeof raw.targets !== "object" || raw.targets === null || Array.isArray(raw.targets)) return emptyState();
  const targets: BackupState["targets"] = {};
  for (const name of BACKUP_TARGETS) {
    const target = parseTarget((raw.targets as Record<string, unknown>)[name]);
    if (target) targets[name] = target;
  }
  return { version: 1, targets };
}

export function writeBackupState(directory: string, state: BackupState): void {
  const file = path.join(directory, BACKUP_STATE_FILE);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    // Created exclusively: something already sitting under this name is not written through.
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * When a target that did not fail was last really backed up.
 *
 * Normally that is this run. But a run that finds today's database copy already
 * there has made nothing: the last success is the copy it found. Dating it
 * from the run instead let a `ryoko backup run` late in the day push the next
 * copy a full day past it - up to two days after the last one that was made.
 * The record moves up to the existing copy if that is newer than what was
 * known, and never past it.
 */
function lastSuccess(target: BackupRunReport["targets"][number], previous: TargetState | undefined, startedAt: string): string {
  if (target.status !== "skipped" || !target.copiedAt) return startedAt;
  return previous?.lastSuccessAt && previous.lastSuccessAt > target.copiedAt ? previous.lastSuccessAt : target.copiedAt;
}

/**
 * Folds a run into the state. Success is dated from the moment the run started,
 * so the next one falls due a day after that and the schedule does not creep
 * later by however long each backup takes.
 */
export function applyRunReport(state: BackupState, report: BackupRunReport): BackupState {
  const targets = { ...state.targets };
  for (const target of report.targets) {
    const previous = state.targets[target.name];
    targets[target.name] = target.status === "failed"
      ? {
        lastAttemptAt: report.startedAt,
        ...(previous?.lastSuccessAt ? { lastSuccessAt: previous.lastSuccessAt } : {}),
        lastError: target.error ?? "failed",
        ...(target.persistent ? { lastErrorPersistent: true as const } : {}),
      }
      : { lastAttemptAt: report.startedAt, lastSuccessAt: lastSuccess(target, previous, report.startedAt) };
  }
  return { version: 1, targets };
}

/** Per target, whichever side attempted most recently. */
export function mergeStates(a: BackupState, b: BackupState): BackupState {
  const targets: BackupState["targets"] = {};
  for (const name of BACKUP_TARGETS) {
    const left = a.targets[name];
    const right = b.targets[name];
    const chosen = !left ? right : !right ? left : (right.lastAttemptAt ?? "") > (left.lastAttemptAt ?? "") ? right : left;
    if (chosen) targets[name] = chosen;
  }
  return { version: 1, targets };
}

/** Milliseconds since `timestamp`, or null when it is missing, unreadable or still in the future. */
function elapsedSince(timestamp: string | undefined, now: Date): number | null {
  if (!timestamp) return null;
  const elapsed = now.getTime() - Date.parse(timestamp);
  // A time ahead of the clock says the clock moved, not that a backup is recent.
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

/** The targets whose last success is a day old or never happened, minus the ones still waiting out a failure. */
export function dueTargets(state: BackupState, now: Date): BackupTargetName[] {
  return BACKUP_TARGETS.filter((name) => {
    const target = state.targets[name] ?? {};
    const sinceSuccess = elapsedSince(target.lastSuccessAt, now);
    if (sinceSuccess !== null && sinceSuccess < BACKUP_INTERVAL_MS) return false;
    if (target.lastError === undefined) return true;
    const sinceAttempt = elapsedSince(target.lastAttemptAt, now);
    const wait = target.lastErrorPersistent ? BACKUP_INTERVAL_MS : RETRY_AFTER_FAILURE_MS;
    return sinceAttempt === null || sinceAttempt >= wait;
  });
}
