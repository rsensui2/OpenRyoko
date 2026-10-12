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
import { settledRunFailure } from "./run-outcome.js";

const updateNotificationRuns = new Set<string>();

export async function runCronJob(
  job: CronJob,
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
  options: { maintenanceOnly?: boolean; maintenanceMode?: MaintenanceMode; forceMaintenance?: boolean } = {},
): Promise<void> {
  const startTime = Date.now();
  logger.info(`Cron job "${job.name}" (${job.id}) starting`);

  const delivery = job.delivery || config.cron?.defaultDelivery;
  const startedAt = new Date().toISOString();

  if (job.kind === "command") {
    let result;
    try { result = await runCommand(job); }
    catch (error) { result = { status: "error" as const, error: error instanceof Error ? error.message : String(error) }; }
    appendRunLog(job.id, { timestamp: startedAt, kind: "command", durationMs: Date.now() - startTime, ...result });
    logger.info(`Cron command "${job.name}" ${result.status} in ${Date.now() - startTime}ms`);
    if (result.status === "error") {
      const target = job.failureDelivery === null ? undefined : job.failureDelivery ?? (config.cron?.alertConnector && config.cron?.alertChannel
        ? { connector: config.cron.alertConnector, channel: config.cron.alertChannel } : undefined);
      if (target) {
        const connector = connectors.get(target.connector);
        if (connector) await connector.sendMessage({ channel: target.channel },
          `⚠️ Cron job "${job.name}" failed: ${result.error ?? "Command failed"}`)
          .catch(error => logger.error(`Cron command alert failed: ${String(error)}`));
        else logger.error(`Cron command alert connector unavailable: ${target.connector}`);
      }
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

    let employee;
    if (job.employee) {
      const orgRegistry = scanOrg();
      employee = findEmployee(job.employee, orgRegistry);
    }

    const connector = new CronConnector(connectors, delivery);
    const sessionKey = `cron:${job.id}:${Date.now()}`;
    let sessionId: string | null = null;

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
      // is not running, the cron connector can only drop what it is given.
      const undelivered = connector.getUndeliveredMessageCount();
      if (undelivered > 0) {
        throw new Error(`Delivery connector "${delivery?.connector}" is not available: ${undelivered} message${undelivered === 1 ? " was" : "s were"} not delivered`);
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
      if (alertConnector && alertChannel) {
        const alertTarget = connectors.get(alertConnector);
        if (alertTarget) {
          await alertTarget.sendMessage(
            { channel: alertChannel },
            `⚠️ Cron job "${job.name}" failed:\n${message.slice(0, 500)}`,
          ).catch((alertErr) => {
            logger.error(`Failed to send cron alert: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
          });
        }
      }
    }
  } finally {
    if (job.kind === "update-notification") updateNotificationRuns.delete(job.id);
  }
}
