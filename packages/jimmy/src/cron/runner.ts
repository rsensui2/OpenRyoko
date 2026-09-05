import type { CronJob, Connector, JinnConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { appendRunLog } from "./jobs.js";
import { scanOrg, findEmployee } from "../gateway/org.js";
import { CronConnector } from "../connectors/cron/index.js";
import type { SessionManager } from "../sessions/manager.js";
import { buildUpdateNotificationPrompt, checkForUpdates } from "../updates/checker.js";
import { getLastNotifiedVersion, markVersionNotified } from "../updates/notification-state.js";

const updateNotificationRuns = new Set<string>();

export async function runCronJob(
  job: CronJob,
  sessionManager: SessionManager,
  config: JinnConfig,
  connectors: Map<string, Connector>,
): Promise<void> {
  const startTime = Date.now();
  logger.info(`Cron job "${job.name}" (${job.id}) starting`);

  const delivery = job.delivery || config.cron?.defaultDelivery;
  const startedAt = new Date().toISOString();

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

  let updateVersion: string | undefined;
  let prompt = job.prompt;
  if (job.kind === "update-notification") {
    const status = await checkForUpdates({ force: true });
    if (status.error && !status.latestVersion) {
      appendRunLog(job.id, {
        timestamp: startedAt,
        status: "skipped",
        durationMs: Date.now() - startTime,
        reason: "update-check-unavailable",
      });
      updateNotificationRuns.delete(job.id);
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
      updateNotificationRuns.delete(job.id);
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
      updateNotificationRuns.delete(job.id);
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

  try {
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
        engine: job.engine || employee?.engine || config.engines.default,
        model: job.model || employee?.model || config.engines[(job.engine || config.engines.default) as "claude" | "codex" | "gemini"]?.model,
        title: job.name,
      },
    );

    if (updateVersion && (
      connector.getDeliveredMessageCount() === 0 ||
      !connector.hasDeliveredTextContaining(updateVersion)
    )) {
      throw new Error(`Update notification ${updateVersion} completed without a verified chat delivery`);
    }

    appendRunLog(job.id, {
      timestamp: startedAt,
      sessionKey,
      sessionId: routeResult?.sessionId ?? null,
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
  } finally {
    if (job.kind === "update-notification") updateNotificationRuns.delete(job.id);
  }
}
