import cron, { type ScheduledTask } from "node-cron";
import type {
  CronJob,
  JinnConfig,
  Connector,
} from "../shared/types.js";
import { runCronJob } from "./runner.js";
import { logger } from "../shared/logger.js";
import type { SessionManager } from "../sessions/manager.js";
import { loadJobs, saveJobs } from "./jobs.js";

/** Max random delay applied to each scheduled cron fire to de-synchronize the
 *  herd of jobs that share a schedule (e.g. every-15-min jobs all firing at :00). */
const CRON_JITTER_MS = 20 * 1000;

let tasks: ScheduledTask[] = [];
/** Pending jitter timers (the 0–CRON_JITTER_MS delay between a cron fire and the
 *  actual run). Tracked so stopScheduler()/reload can cancel them — otherwise a
 *  delayed fire would run AFTER its job was disabled/deleted, against a stale
 *  job/config/connector snapshot, and could double-fire on reload. */
let jitterTimers = new Set<NodeJS.Timeout>();
let currentSessionManager: SessionManager;
let currentConfig: JinnConfig;
let currentConnectors: Map<string, Connector>;

export function startScheduler(
  jobs: CronJob[],
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
): void {
  currentSessionManager = sessionManager;
  currentConfig = config;
  currentConnectors = connectors;
  scheduleJobs(jobs);
}

export function reloadScheduler(jobs: CronJob[]): void {
  stopScheduler();
  scheduleJobs(jobs);
}

export function stopScheduler(): void {
  for (const task of tasks) {
    // node-cron v4 keeps stopped tasks in its registry; destroy removes them.
    void task.destroy();
  }
  tasks = [];
  // Cancel any in-flight jitter delays so a stale fire can't land after stop/reload.
  for (const timer of jitterTimers) clearTimeout(timer);
  jitterTimers.clear();
}

function scheduleJobs(jobs: CronJob[]): void {
  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!cron.validate(job.schedule)) {
      logger.warn(
        `Invalid cron schedule for job "${job.name}": ${job.schedule}`,
      );
      continue;
    }
    const task = cron.schedule(
      job.schedule,
      () => {
        // Jitter the fire by 0–CRON_JITTER_MS to spread the :00/:15/:30/:45
        // thundering herd (multiple jobs spawning `claude` in the same instant).
        // Reduces load spikes and lock contention on shared resources; the OAuth
        // refresh race is fixed separately by the spawn gate, this is defence in
        // depth. Manual triggers (triggerCronJob) bypass the jitter intentionally.
        const jitter = Math.floor(Math.random() * CRON_JITTER_MS);
        const timer = setTimeout(() => {
          jitterTimers.delete(timer);
          runCronJob(job, currentSessionManager, currentConfig, currentConnectors);
        }, jitter);
        jitterTimers.add(timer);
      },
      { timezone: job.timezone },
    );
    tasks.push(task);
    logger.info(`Scheduled cron job "${job.name}" (${job.schedule})`);
  }
}

export async function triggerCronJob(idOrName: string): Promise<CronJob | undefined> {
  const job = findJob(idOrName);
  if (!job) return undefined;
  await runCronJob(job, currentSessionManager, currentConfig, currentConnectors);
  return job;
}

export function setCronJobEnabled(idOrName: string, enabled: boolean): CronJob | undefined {
  const jobs = loadJobs();
  const index = jobs.findIndex((job) => matchesJob(job, idOrName));
  if (index === -1) return undefined;
  jobs[index] = { ...jobs[index], enabled };
  saveJobs(jobs);
  reloadScheduler(jobs);
  return jobs[index];
}

function findJob(idOrName: string): CronJob | undefined {
  return loadJobs().find((job) => matchesJob(job, idOrName));
}

function matchesJob(job: CronJob, idOrName: string): boolean {
  const needle = idOrName.trim().toLowerCase();
  return job.id.toLowerCase() === needle || job.name.toLowerCase() === needle;
}
