import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CronJob } from "../shared/types.js";
import { CRON_JOBS, CRON_RUNS } from "../shared/paths.js";

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

export function appendRunLog(jobId: string, entry: object): void {
  fs.mkdirSync(CRON_RUNS, { recursive: true });
  const logPath = path.join(CRON_RUNS, `${jobId}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}
