import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CronJob } from "../shared/types.js";
import { CRON_JOBS, CRON_RUNS } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export class CronJobsReadError extends Error {
  constructor(public readonly reason: "missing" | "invalid" | "unreadable", message: string) {
    super(message);
    this.name = "CronJobsReadError";
  }
}

function validateJobs(value: unknown): asserts value is CronJob[] {
  if (!Array.isArray(value)) {
    throw new CronJobsReadError("invalid", "cron/jobs.json must contain an array of jobs");
  }
  const ids = new Set<string>();
  for (const [index, job] of value.entries()) {
    if (!job || typeof job !== "object" || Array.isArray(job)
      || typeof job.id !== "string" || !job.id.trim()
      || typeof job.name !== "string" || typeof job.schedule !== "string"
      || typeof job.enabled !== "boolean") {
      throw new CronJobsReadError("invalid", `cron/jobs.json has an invalid job at index ${index}`);
    }
    if (ids.has(job.id)) {
      throw new CronJobsReadError("invalid", `cron/jobs.json has a duplicate job ID at index ${index}`);
    }
    ids.add(job.id);
  }
}

/** Missing is only empty for a new installation, never for a running reload. */
export function loadJobs(options: { allowMissing?: boolean } = {}): CronJob[] {
  let raw: string;
  try {
    raw = fs.readFileSync(CRON_JOBS, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (options.allowMissing !== false) return [];
      throw new CronJobsReadError("missing", "cron/jobs.json is missing");
    }
    throw new CronJobsReadError("unreadable", "cron/jobs.json could not be read");
  }
  let jobs: unknown;
  try { jobs = JSON.parse(raw); } catch {
    // JSON.parse may quote private prompt text in its error message.
    throw new CronJobsReadError("invalid", "cron/jobs.json contains invalid JSON");
  }
  validateJobs(jobs);
  return jobs;
}

export function saveJobs(jobs: CronJob[]): void {
  validateJobs(jobs);
  const dir = path.dirname(CRON_JOBS);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `.jobs-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(jobs, null, 2) + "\n", { encoding: "utf-8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, CRON_JOBS);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Where a job's run log lives, or null when the id would take it outside
 *  cron/runs (`../x`, a NUL byte). Job ids are free-form and jobs.json is not
 *  rejected over one, so the path is checked wherever it is built instead. */
export function runLogPath(jobId: string): string | null {
  if (jobId.includes("\0")) return null;
  const logPath = path.join(CRON_RUNS, `${jobId}.jsonl`);
  const relative = path.relative(CRON_RUNS, logPath);
  const escapes = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return escapes ? null : logPath;
}

export function appendRunLog(jobId: string, entry: object): void {
  const logPath = runLogPath(jobId);
  if (!logPath) {
    logger.warn(`Run log not written: job id ${JSON.stringify(jobId)} resolves outside cron/runs`);
    return;
  }
  fs.mkdirSync(CRON_RUNS, { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

/** A job's runs, oldest first (the log is append-only). A positive `limit`
 *  keeps the newest N in that same order and parses only those lines. An id
 *  that points outside cron/runs has no history. */
export function readRunLog(jobId: string, limit = 0): unknown[] {
  const logPath = runLogPath(jobId);
  if (!logPath || !fs.existsSync(logPath)) return [];
  const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
  return (limit > 0 ? lines.slice(-limit) : lines).map((line) => JSON.parse(line));
}
