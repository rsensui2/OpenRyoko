import type { CronJob, Engine, JimmyConfig, Connector } from "../shared/types.js";
import { buildContext } from "../sessions/context.js";
import { createSession, updateSession, insertMessage } from "../sessions/registry.js";
import { JIMMY_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { appendRunLog } from "./jobs.js";
import { scanOrg, findEmployee } from "../gateway/org.js";

export async function runCronJob(
  job: CronJob,
  engines: Map<string, Engine>,
  config: JimmyConfig,
  connectors: Map<string, Connector>,
): Promise<void> {
  const startTime = Date.now();
  logger.info(`Cron job "${job.name}" (${job.id}) starting`);

  // 1. Determine engine + model
  const engineName = job.engine || config.engines.default;
  const engine = engines.get(engineName);
  if (!engine) {
    logger.error(`Engine "${engineName}" not found for cron job "${job.name}"`);
    return;
  }
  const model =
    job.model || config.engines[engineName as "claude" | "codex"]?.model;

  // 2. Warn if a non-jimmy employee has delivery configured (anti-pattern)
  const delivery = job.delivery || config.cron?.defaultDelivery;
  if (delivery && job.employee && job.employee !== "jimmy") {
    logger.warn(
      `Cron job "${job.name}" targets employee "${job.employee}" with delivery to ${delivery.connector}:${delivery.channel}. ` +
        `Recommended pattern: target "jimmy" and let the COO delegate to "${job.employee}" via a child session for output review/filtering.`,
    );
  }

  // 3. Resolve employee
  let employee;
  if (job.employee) {
    const orgRegistry = scanOrg();
    employee = findEmployee(job.employee, orgRegistry);
  }

  // 4. Create a proper session in the DB
  const sourceRef = `cron:${job.id}`;
  const session = createSession({
    engine: engineName,
    source: "cron",
    sourceRef,
    employee: employee?.name,
    model,
    title: job.name,
    prompt: job.prompt,
  });
  insertMessage(session.id, "user", job.prompt);

  // 5. Build context
  const ctx = buildContext({
    source: "cron",
    channel: job.id,
    user: "system",
    employee,
    config,
    connectors: Array.from(connectors.keys()),
    sessionId: session.id,
  });

  updateSession(session.id, {
    status: "running",
    lastActivity: new Date().toISOString(),
  });

  // 6. Run engine (fresh session, no resume)
  try {
    const result = await engine.run({
      prompt: job.prompt,
      systemPrompt: ctx,
      cwd: JIMMY_HOME,
      model,
    });

    const durationMs = Date.now() - startTime;
    const responseText = result.result?.trim()
      ? result.result
      : result.error || "(No response from engine)";

    // Persist assistant response
    insertMessage(session.id, "assistant", responseText);

    // Update session with engine session id
    updateSession(session.id, {
      engineSessionId: result.sessionId,
      status: result.error ? "error" : "idle",
      lastActivity: new Date().toISOString(),
      lastError: result.error ?? null,
    });

    // 7. If delivery configured (job-level or default), send result to connector
    if (delivery && result.result) {
      const connector = connectors.get(delivery.connector);
      if (connector) {
        await connector.sendMessage(
          { channel: delivery.channel },
          result.result,
        );
      } else {
        logger.warn(
          `Delivery connector "${delivery.connector}" not found`,
        );
      }
    }

    // 8. Log run
    appendRunLog(job.id, {
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      status: result.error ? "error" : "success",
      durationMs,
      error: result.error || null,
      resultPreview: result.result?.slice(0, 500) || null,
    });

    logger.info(`Cron job "${job.name}" completed in ${durationMs}ms`);
  } catch (err: any) {
    const durationMs = Date.now() - startTime;

    updateSession(session.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: err.message,
    });

    appendRunLog(job.id, {
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      status: "error",
      durationMs,
      error: err.message,
      resultPreview: null,
    });
    logger.error(`Cron job "${job.name}" failed: ${err.message}`);
  }
}
