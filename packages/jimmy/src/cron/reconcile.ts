import { loadJobs } from "./jobs.js";
import { reloadScheduler } from "./scheduler.js";
import { logger } from "../shared/logger.js";

/** Missing/partial writes must not erase the last successfully registered jobs. */
export function createCronReconciler(onReload: () => void): () => void {
  let previousError: string | undefined;
  return () => {
    try {
      const jobs = loadJobs({ allowMissing: false });
      const changed = reloadScheduler(jobs);
      if (previousError) logger.info("Cron jobs file is readable again");
      previousError = undefined;
      if (changed) {
        logger.info(`Cron jobs reconciled (${jobs.length} configured job(s))`);
        onReload();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown read error";
      if (message !== previousError) {
        logger.warn(`Cron reload skipped; keeping previous registrations: ${message}`);
        previousError = message;
      }
    }
  };
}
