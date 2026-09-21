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
import { validateCronSchedule } from "./validation.js";

/** Max random delay applied to each scheduled cron fire to de-synchronize the
 *  herd of jobs that share a schedule (e.g. every-15-min jobs all firing at :00). */
const CRON_JITTER_MS = 20 * 1000;

interface RegisteredJob {
  task: ScheduledTask;
  fingerprint: string;
  jitterTimers: Set<NodeJS.Timeout>;
}

export interface CronJobScheduleStatus {
  state: "scheduled" | "disabled" | "pending" | "error" | "stopped";
  registered: boolean;
  error?: string;
}

const tasks = new Map<string, RegisteredJob>();
const scheduleErrors = new Map<string, { fingerprint: string; error: string }>();
let running = false;
let lastReloadAt: string | null = null;
let lastJobsFingerprint: string | null = null;
let configuredJobIds: string[] = [];
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
  running = true;
  reloadScheduler(jobs);
}

export function reloadScheduler(jobs: CronJob[]): boolean {
  if (!running) return false;
  const jobsFingerprint = JSON.stringify(jobs.map((job) => [job.id, jobFingerprint(job)] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
  let changed = lastJobsFingerprint !== jobsFingerprint;
  const desired = new Map(jobs.map((job) => [job.id, job]));
  for (const [id, registration] of tasks) {
    const job = desired.get(id);
    if (!job?.enabled || registration.fingerprint !== jobFingerprint(job)) {
      removeRegistration(id, registration);
      changed = true;
    }
  }
  for (const id of scheduleErrors.keys()) {
    if (!desired.has(id)) scheduleErrors.delete(id);
  }
  for (const job of jobs) {
    if (!job.enabled) {
      scheduleErrors.delete(job.id);
      continue;
    }
    if (!tasks.has(job.id)) {
      const previousError = scheduleErrors.get(job.id)?.error;
      scheduleJob(job);
      if (tasks.has(job.id) || previousError !== scheduleErrors.get(job.id)?.error) changed = true;
    }
  }
  lastJobsFingerprint = jobsFingerprint;
  configuredJobIds = [...desired.keys()].sort();
  if (changed) lastReloadAt = new Date().toISOString();
  return changed;
}

export function stopScheduler(): void {
  running = false;
  for (const [id, registration] of tasks) {
    removeRegistration(id, registration);
  }
  scheduleErrors.clear();
  lastJobsFingerprint = null;
}

export function getCronJobScheduleStatus(job: CronJob): CronJobScheduleStatus {
  const registration = tasks.get(job.id);
  if (!job.enabled && !registration) return { state: "disabled", registered: false };
  if (!running) return { state: "stopped", registered: false };
  const fingerprint = jobFingerprint(job);
  if (registration) {
    return {
      state: registration.fingerprint === fingerprint ? "scheduled" : "pending",
      registered: true,
    };
  }
  const failure = scheduleErrors.get(job.id);
  if (failure?.fingerprint === fingerprint) {
    return { state: "error", registered: false, error: failure.error };
  }
  return { state: "pending", registered: false };
}

export function getSchedulerSnapshot(): {
  running: boolean;
  configuredJobIds: string[];
  registeredJobIds: string[];
  lastReloadAt: string | null;
} {
  return { running, configuredJobIds: [...configuredJobIds], registeredJobIds: [...tasks.keys()].sort(), lastReloadAt };
}

function removeRegistration(id: string, registration: RegisteredJob): void {
  // Invalidate the callback before destroying its node-cron task. Even an
  // already-queued callback must not execute a deleted/disabled job.
  tasks.delete(id);
  for (const timer of registration.jitterTimers) clearTimeout(timer);
  registration.jitterTimers.clear();
  try {
    // node-cron v4 keeps stopped tasks in its registry; destroy removes them.
    void Promise.resolve(registration.task.destroy()).catch((error: unknown) => {
      logger.error(`Could not destroy cron task "${id}": ${String(error)}`);
    });
  } catch (error) {
    logger.error(`Could not destroy cron task "${id}": ${String(error)}`);
  }
}

function scheduleJob(input: CronJob): void {
  const fingerprint = jobFingerprint(input);
  try {
    const errors = validateCronSchedule(input);
    if (errors.length) throw new Error(errors.map((error) => error.message).join("; "));
    // Keep callbacks isolated from subsequent mutations of a caller's job.
    const job = structuredClone(input);
    const jitterTimers = new Set<NodeJS.Timeout>();
    let registration: RegisteredJob;
    const task = cron.schedule(
      job.schedule,
      () => {
        if (!running || tasks.get(job.id) !== registration) return;
        // Spread simultaneous cron fires; unchanged reconciliations keep these
        // timers, while edits, disabling, deletion and stop cancel them.
        const jitter = Math.floor(Math.random() * CRON_JITTER_MS);
        const timer = setTimeout(() => {
          jitterTimers.delete(timer);
          if (!running || tasks.get(job.id) !== registration) return;
          void runCronJob(job, currentSessionManager, currentConfig, currentConnectors)
            .catch((error: unknown) => {
              logger.error(`Cron job "${job.name}" failed: ${String(error)}`);
            });
        }, jitter);
        jitterTimers.add(timer);
      },
      { timezone: job.timezone },
    );
    registration = { task, fingerprint, jitterTimers };
    tasks.set(job.id, registration);
    scheduleErrors.delete(job.id);
    logger.info(`Scheduled cron job "${job.name}" (${job.schedule})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const previous = scheduleErrors.get(input.id);
    if (previous?.fingerprint !== fingerprint || previous.error !== message) {
      logger.warn(`Could not schedule cron job "${input.name}": ${message}`);
    }
    scheduleErrors.set(input.id, { fingerprint, error: message });
  }
}

/** Include the execution payload as well as timing: changing a prompt or
 * command must cancel delayed fires against the old payload. Object key order
 * alone is not a change (editors may rewrite/reorder the JSON document). */
function jobFingerprint(job: CronJob): string {
  return JSON.stringify(job, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
    }
    return value;
  });
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
