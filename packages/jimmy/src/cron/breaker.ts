import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CronJob } from "../shared/types.js";
import { CRON_RUNS, CRON_STATE } from "../shared/paths.js";
import { appendRunLog } from "./jobs.js";

/** Failed runs in a row before a job is paused. Five catches every long streak in
 * the run history while leaving one-off and short failures alone. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
/** A paused job gets one trial run this often, and comes back by itself when the trial succeeds. */
export const PROBE_INTERVAL_MS = 60 * 60 * 1000;
/** The streak is read from the end of the run log, which can be megabytes long. */
const TAIL_BYTES = 64 * 1024;

export interface BreakerState {
  pausedAt: string;
  reason: "consecutive_failures";
  failures: number;
  lastError: string;
  /** When a paused job last got a trial run. */
  lastProbeAt?: string;
}

/** The limit for a job; null means the breaker is off for it. */
export function failureLimit(job: Pick<CronJob, "maxConsecutiveFailures">): number | null {
  const value = job.maxConsecutiveFailures;
  if (value === null || value === 0) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_CONSECUTIVE_FAILURES;
}

/** Failed runs at the end of the log. Skipped and paused entries are neither a failure nor a recovery;
 * a success or a resume ends the streak; maintenance entries are not runs of the job itself. */
export function countConsecutiveFailures(jobId: string): number {
  let text: string;
  try {
    const fd = fs.openSync(path.join(CRON_RUNS, `${jobId}.jsonl`), "r");
    try {
      const { size } = fs.fstatSync(fd);
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString("utf-8");
      if (size > length) text = text.slice(text.indexOf("\n") + 1); // the first line is cut off
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
  let failures = 0;
  for (const line of text.split("\n").reverse()) {
    if (!line.trim()) continue;
    let entry: { status?: unknown; kind?: unknown };
    try { entry = JSON.parse(line) as { status?: unknown; kind?: unknown }; } catch { continue; }
    if (entry.kind === "maintenance") continue;
    const status = entry.status;
    if (status === "error") failures += 1;
    else if (status !== "skipped" && status !== "paused") break;
  }
  return failures;
}

function statePath(jobId: string): string {
  // Job IDs are free text; one must never address a path outside the state directory.
  return path.join(CRON_STATE, `${encodeURIComponent(jobId)}.json`);
}

/** Why the job is paused, or null. An unreadable file never stops a job. */
export function readBreaker(jobId: string): BreakerState | null {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(jobId), "utf-8")) as Partial<BreakerState> | null;
    return value && typeof value.pausedAt === "string" ? (value as BreakerState) : null;
  } catch {
    return null;
  }
}

export function tripBreaker(jobId: string, failures: number, lastError: string): BreakerState {
  const state: BreakerState = {
    pausedAt: new Date().toISOString(),
    reason: "consecutive_failures",
    failures,
    lastError: lastError.slice(0, 500),
  };
  writeState(jobId, state);
  return state;
}

/** Whether a paused job is due its trial run. */
export function probeDue(state: BreakerState, now: number = Date.now()): boolean {
  const since = Date.parse(state.lastProbeAt ?? state.pausedAt);
  return Number.isNaN(since) || now - since >= PROBE_INTERVAL_MS;
}

/** Record a trial run before it starts, so two overlapping ticks do not both try. */
export function markProbe(jobId: string, state: BreakerState): void {
  writeState(jobId, { ...state, lastProbeAt: new Date().toISOString() });
}

function writeState(jobId: string, state: BreakerState): void {
  fs.mkdirSync(CRON_STATE, { recursive: true });
  const temporary = path.join(CRON_STATE, `.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, statePath(jobId));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** True when the job was paused. The run log gets a "resumed" entry so the streak starts from zero. */
export function resumeBreaker(jobId: string): boolean {
  try {
    fs.unlinkSync(statePath(jobId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  appendRunLog(jobId, { timestamp: new Date().toISOString(), status: "resumed" });
  return true;
}
