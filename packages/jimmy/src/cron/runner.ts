import type { CronJob, Connector, JinnConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { appendRunLog } from "./jobs.js";
import { scanOrg, findEmployee } from "../gateway/org.js";
import { CronConnector } from "../connectors/cron/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { buildUpdateNotificationPrompt, checkForUpdates } from "../updates/checker.js";
import { getLastNotifiedVersion, markVersionNotified } from "../updates/notification-state.js";
import { runUpdateMaintenance } from "../updates/maintenance.js";
import type { MaintenanceMode } from "../updates/maintenance-audit.js";
import { runCommand } from "./command.js";
import { settledLimitFailure, settledRunFailure } from "./run-outcome.js";
import { clearAlertThrottle, isAlertThrottled, isLimitAlertThrottled, recordAlertSent, recordLimitAlertSent } from "./alert-throttle.js";
import { fireWaitingOnUsageLimit, trackFire } from "./waiting-fires.js";
import { countConsecutiveFailures, failureLimit, markProbe, probeDue, readBreaker, resumeBreaker, tripBreaker } from "./breaker.js";

const updateNotificationRuns = new Set<string>();

/** Where a failure alert goes: the job's own channel, the configured default, or nowhere (null switches it off). */
function alertTarget(job: CronJob, config: JinnConfig): { connector: string; channel: string } | undefined {
  if (job.failureDelivery === null) return undefined;
  return job.failureDelivery ?? (config.cron?.alertConnector && config.cron?.alertChannel
    ? { connector: config.cron.alertConnector, channel: config.cron.alertChannel } : undefined);
}

/** Resuming must never turn a good run into a failure. */
function resumeQuietly(job: CronJob): void {
  try { resumeBreaker(job.id); }
  catch (error) { logger.error(`Could not resume cron job "${job.name}": ${String(error)}`); }
}

/** After a failed run: once the streak reaches the limit, pause the job and say so once. */
async function pauseAfterStreak(
  job: CronJob, config: JinnConfig, connectors: Map<string, Connector>, lastError: string, logFile?: string,
): Promise<void> {
  try {
    const limit = failureLimit(job);
    if (limit === null || readBreaker(job.id)) return;
    const failures = countConsecutiveFailures(job.id);
    if (failures < limit) return;
    tripBreaker(job.id, failures, lastError);
    logger.error(`Cron job "${job.name}" paused after ${failures} consecutive failures`);
    const target = alertTarget(job, config);
    const connector = target ? connectors.get(target.connector) : undefined;
    if (!target || !connector) {
      logger.warn(`Cron job "${job.name}" was paused but has no usable alert target`);
      return;
    }
    await connector.sendMessage({ channel: target.channel },
      `⏸ Cron job "${job.name}" を連続${failures}回の失敗のため一時停止しました。1時間ごとに試し実行し、成功すれば自動で再開します。`
      + `すぐ戻すなら原因を直して \`ryoko automation resume ${job.id}\`。`
      + `\n最後のエラー: ${lastError.slice(0, 300)}${logFile ? `\nログ: ${logFile}` : ""}`);
  } catch (error) {
    logger.error(`Cron breaker failed for "${job.name}": ${String(error)}`);
  }
}

export async function runCronJob(
  job: CronJob,
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
  options: { maintenanceOnly?: boolean; maintenanceMode?: MaintenanceMode; forceMaintenance?: boolean; manual?: boolean } = {},
): Promise<void> {
  const startTime = Date.now();
  logger.info(`Cron job "${job.name}" (${job.id}) starting`);

  const delivery = job.delivery || config.cron?.defaultDelivery;
  const startedAt = new Date().toISOString();

  // A manual run goes ahead even when paused: that is how a fix is tried out.
  // Otherwise a paused job only gets its hourly trial run, quietly: it is already known to be failing.
  const held = options.manual ? null : readBreaker(job.id);
  const probing = held !== null;
  if (held) {
    if (!probeDue(held)) {
      appendRunLog(job.id, { timestamp: startedAt, status: "paused", reason: held.reason, durationMs: 0 });
      logger.warn(`Cron job "${job.name}" is paused after ${held.failures} consecutive failures; resume with: ryoko automation resume ${job.id}`);
      return;
    }
    markProbe(job.id, held);
    logger.info(`Cron job "${job.name}" is paused; running a trial`);
  }

  if (job.kind === "command") {
    let result;
    try { result = await runCommand(job); }
    catch (error) { result = { status: "error" as const, error: error instanceof Error ? error.message : String(error) }; }
    appendRunLog(job.id, { timestamp: startedAt, kind: "command", durationMs: Date.now() - startTime, ...result });
    logger.info(`Cron command "${job.name}" ${result.status} in ${Date.now() - startTime}ms`);
    if (result.status === "error" && !probing) {
      const target = alertTarget(job, config);
      if (target) {
        const connector = connectors.get(target.connector);
        if (connector) await connector.sendMessage({ channel: target.channel },
          `⚠️ Cron job "${job.name}" failed: ${result.error ?? "Command failed"}`)
          .catch(error => logger.error(`Cron command alert failed: ${String(error)}`));
        else logger.error(`Cron command alert connector unavailable: ${target.connector}`);
      }
      await pauseAfterStreak(job, config, connectors, result.error ?? "Command failed", "logFile" in result ? result.logFile : undefined);
    } else if (result.status === "success" && (options.manual || probing)) {
      resumeQuietly(job);
    }
    return;
  }

  if (job.kind === "update-notification") {
    if (updateNotificationRuns.has(job.id)) {
      appendRunLog(job.id, {
        timestamp: startedAt,
        status: "skipped",
        durationMs: Date.now() - startTime,
        reason: "already-running",
      });
      logger.info(`Cron job "${job.name}" skipped because a previous update check is still running`);
      return;
    }
    if (!delivery?.connector || !delivery.channel) {
      appendRunLog(job.id, {
        timestamp: startedAt,
        status: "skipped",
        durationMs: Date.now() - startTime,
        reason: "delivery-not-configured",
      });
      logger.warn(`Cron job "${job.name}" has no update notification delivery target`);
      return;
    }
    if (!connectors.has(delivery.connector)) {
      appendRunLog(job.id, {
        timestamp: startedAt,
        status: "skipped",
        durationMs: Date.now() - startTime,
        reason: "delivery-connector-unavailable",
      });
      logger.warn(`Cron job "${job.name}" delivery connector "${delivery.connector}" is unavailable`);
      return;
    }
    updateNotificationRuns.add(job.id);
  }

  // Include inspection and registry failures in the lock's lifetime too.
  try {
    let updateVersion: string | undefined;
    let prompt = job.prompt;
    if (job.kind === "update-notification") {
      try {
        const maintenance = await runUpdateMaintenance(job, sessionManager, config, connectors, {
          mode: options.maintenanceMode, force: options.forceMaintenance,
        });
        appendRunLog(job.id, {
          timestamp: startedAt, kind: "maintenance", ...maintenance,
          durationMs: Date.now() - startTime,
        });
      } catch {
        // An unavailable inspection/delivery must not hide an available release.
        appendRunLog(job.id, { timestamp: startedAt, kind: "maintenance", status: "error",
          error: "運用点検または結果通知に失敗しました。更新確認は継続します。", durationMs: Date.now() - startTime });
        logger.warn(`Cron update maintenance failed for job ${job.id}`);
      }
      if (options.maintenanceOnly) return;
      const status = await checkForUpdates({ force: true });
      if (status.error && !status.latestVersion) {
        appendRunLog(job.id, {
          timestamp: startedAt,
          status: "skipped",
          durationMs: Date.now() - startTime,
          reason: "update-check-unavailable",
        });
        logger.warn(`Cron job "${job.name}" could not reach the OpenRyoko package registry`);
        return;
      }
      if (!status.updateAvailable || !status.latestVersion) {
        appendRunLog(job.id, {
          timestamp: startedAt,
          status: "skipped",
          durationMs: Date.now() - startTime,
          reason: "up-to-date",
          currentVersion: status.currentVersion,
          latestVersion: status.latestVersion,
        });
        logger.info(`Cron job "${job.name}" found no newer OpenRyoko release`);
        return;
      }
      if (getLastNotifiedVersion(job.id) === status.latestVersion) {
        appendRunLog(job.id, {
          timestamp: startedAt,
          status: "skipped",
          durationMs: Date.now() - startTime,
          reason: "already-notified",
          latestVersion: status.latestVersion,
        });
        logger.info(`Cron job "${job.name}" already notified release ${status.latestVersion}`);
        return;
      }
      updateVersion = status.latestVersion;
      prompt = buildUpdateNotificationPrompt(status);
    }

    const cooSlug = config.portal?.portalName?.toLowerCase() || "jinn";
    if (delivery && job.employee && job.employee !== cooSlug) {
      logger.debug(
        `Cron job "${job.name}" targets employee "${job.employee}" directly (skipping COO delegation).`,
      );
    }

    // An earlier fire of this job that is parked on a usage limit runs when the
    // limit resets. One started beside it would spend a turn finding the same
    // limit, wait as well, and run the job a second time at that moment.
    const waiting = fireWaitingOnUsageLimit(job.id);
    if (waiting) {
      appendRunLog(job.id, {
        timestamp: startedAt,
        status: "skipped",
        durationMs: Date.now() - startTime,
        reason: "previous-run-waiting-for-usage-limit",
        ...waiting,
      });
      logger.info(`Cron job "${job.name}" skipped: an earlier fire is waiting for a usage limit to reset${waiting.resetsAt ? ` at ${waiting.resetsAt}` : ""}`);
      return;
    }

    let employee;
    if (job.employee) {
      const orgRegistry = scanOrg();
      employee = findEmployee(job.employee, orgRegistry);
    }

    const connector = new CronConnector(connectors, delivery);
    const sessionKey = `cron:${job.id}:${Date.now()}`;
    let sessionId: string | null = null;
    const fireSettled = trackFire(job.id, sessionKey);

    try {
      // route() would start a session, post "engine not available" into the
      // delivery channel and return as if the turn had run. Only an engine the
      // job itself names is checked; defaults remain route()'s to resolve.
      if (job.engine && !sessionManager.getEngine(job.engine)) {
        throw new Error(`Engine "${job.engine}" named by the job is not available`);
      }

      const routeResult = await sessionManager.route(
        {
          connector: connector.name,
          source: "cron",
          sessionKey,
          replyContext: {
            channel: delivery?.channel || job.id,
            messageTs: null,
            cronJobId: job.id,
            cronJobName: job.name,
            deliveryConnector: delivery?.connector ?? null,
          },
          messageId: undefined,
          channel: delivery?.channel || job.id,
          thread: undefined,
          user: "system",
          userId: "system",
          text: prompt,
          attachments: [],
          raw: { jobId: job.id, trigger: "cron" },
          transportMeta: {
            cronJobId: job.id,
            cronJobName: job.name,
            deliveryConnector: delivery?.connector ?? null,
            deliveryChannel: delivery?.channel ?? null,
          },
        },
        connector,
        {
          employee,
          // Only what the job itself names. route() resolves the employee and
          // config defaults, and the engine that runs supplies its own model;
          // spelling a default out here handed an employee on another engine
          // the default engine's model.
          engine: job.engine || undefined,
          model: job.model || undefined,
          title: job.name,
          effortLevel: job.effortLevel,
        },
      );
      sessionId = routeResult?.sessionId ?? null;

      // route() returning is not the turn succeeding: a failed turn settles its
      // session as an error and still returns here. Read that receipt before
      // anything else is awaited, and fail the run the way a throw already does.
      const failure = settledRunFailure(sessionId, job.name);
      if (failure) throw new Error(failure);

      // A turn can succeed and still reach nobody: when the delivery connector
      // is not running, the cron connector can only drop what it is given. A
      // notice lost along the way is logged, not failed, once the result arrived.
      const undelivered = connector.getUndeliveredMessageCount();
      if (connector.isOutputUndelivered()) {
        // No count in the reason: how many messages a fire lost varies, the failure does not.
        throw new Error(`Delivery connector "${delivery?.connector}" is not available: the run's output was not delivered`);
      }
      if (undelivered > 0) {
        logger.warn(`Cron job "${job.name}" delivered its result, but ${undelivered} earlier message${undelivered === 1 ? " was" : "s were"} not delivered: connector "${delivery?.connector}" was not available`);
      }

      if (updateVersion && (
        connector.getDeliveredMessageCount() === 0 ||
        !connector.hasDeliveredTextContaining(updateVersion)
      )) {
        throw new Error(`Update notification ${updateVersion} completed without a verified chat delivery`);
      }

      appendRunLog(job.id, {
        timestamp: startedAt,
        sessionKey,
        sessionId,
        status: "success",
        durationMs: Date.now() - startTime,
        error: null,
        resultPreview: null,
        ...(updateVersion ? { updateVersion } : {}),
      });
      if (updateVersion) markVersionNotified(job.id, updateVersion);
      clearAlertThrottle(job.id);
      if (options.manual || probing) resumeQuietly(job);
      logger.info(`Cron job "${job.name}" completed in ${Date.now() - startTime}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendRunLog(job.id, {
        timestamp: startedAt,
        sessionKey,
        ...(sessionId ? { sessionId } : {}),
        status: "error",
        durationMs: Date.now() - startTime,
        error: message,
        resultPreview: null,
      });
      logger.error(`Cron job "${job.name}" failed: ${message}`);

      // Send alert if configured
      const alertConnector = config.cron?.alertConnector;
      const alertChannel = config.cron?.alertChannel;
      // A paused job's trial run is already known to be failing: no alert for it.
      if (alertConnector && alertChannel && !probing) {
        const alertTarget = connectors.get(alertConnector);
        const destination = `${alertConnector}:${alertChannel}`;
        // A usage limit that is not waited for fails every fire until it
        // resets: its alert is held for that limit period, not for a window.
        const limit = settledLimitFailure(sessionId);
        const throttled = limit
          ? isLimitAlertThrottled(job.id, limit, destination, config.cron?.alertThrottleMinutes)
          : isAlertThrottled(job.id, message, destination, config.cron?.alertThrottleMinutes);
        if (alertTarget && throttled) {
          logger.info(`Cron alert for "${job.name}" not repeated: the same failure was already reported`);
        } else if (alertTarget) {
          await alertTarget.sendMessage(
            { channel: alertChannel },
            `⚠️ Cron job "${job.name}" failed:\n${message.slice(0, 500)}`,
          ).then(() => (limit ? recordLimitAlertSent(job.id, limit, destination) : recordAlertSent(job.id, message, destination)), (alertErr) => {
            logger.error(`Failed to send cron alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
          });
        }
      }
      await pauseAfterStreak(job, config, connectors, message);
    } finally {
      fireSettled();
    }
  } finally {
    if (job.kind === "update-notification") updateNotificationRuns.delete(job.id);
  }
}
