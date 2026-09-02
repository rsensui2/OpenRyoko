import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import cron from "node-cron";
import type { CronJob, Engine, IncomingMessage, JinnConfig, Session, Target } from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import type { SessionManager } from "../sessions/manager.js";
import { buildContext } from "../sessions/context.js";
import {
  initDb,
  listSessions,
  getSession,
  createSession,
  updateSession,
  UpdateSessionFields,
  deleteSession,
  deleteSessions,
  duplicateSession,
  insertMessage,
  getMessages,
  enqueueQueueItem,
  insertNotificationWithQueueItem,
  cancelQueueItem,
  getQueueItems,
  cancelAllPendingQueueItems,
  listAllPendingQueueItems,
  getFile,
  getMessagePage,
  getMessageWindow,
  isFtsBackfillPending,
  listSessionPage,
  searchMessages,
} from "../sessions/registry.js";
import { forkEngineSession } from "../sessions/fork.js";
import { deliverToOriginConnector, isUndeliveredToOrigin, recordFailedOriginDelivery } from "../sessions/origin-delivery.js";
import {
  CONFIG_PATH,
  CRON_JOBS,
  CRON_RUNS,
  ORG_DIR,
  SKILLS_DIR,
  LOGS_DIR,
  TMP_DIR,
  FILES_DIR,
} from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { getSttStatus, downloadModel, transcribe as sttTranscribe, resolveLanguages, WHISPER_LANGUAGES } from "../stt/stt.js";
import { JINN_HOME } from "../shared/paths.js";
import { handleHookPost, LOOPBACK as HOOK_LOOPBACK } from "./hook-endpoint.js";
import { resolveEffort } from "../shared/effort.js";
import { explicitThread } from "../shared/threading.js";
import { effortLevelsForModel, invalidateModelRegistry } from "../shared/models.js";
import { computeNextRetryDelayMs, computeRateLimitDeadlineMs, detectRateLimit } from "../shared/rateLimit.js";
import { getClaudeExpectedResetAt, recordClaudeRateLimit } from "../shared/usageAwareness.js";
import { loadJobs, saveJobs } from "../cron/jobs.js";
import { reloadScheduler } from "../cron/scheduler.js";
import { runCronJob } from "../cron/runner.js";
import { checkForUpdates } from "../updates/checker.js";
import QRCode from "qrcode";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { handleFilesRequest, ensureFilesDir } from "./files.js";
import { notifyParentSession, notifyRateLimited, notifyRateLimitResumed, notifyDiscordChannel } from "../sessions/callbacks.js";
import { loadInstances } from "../cli/instances.js";
import { recordTurnAccounting } from "../sessions/accounting.js";
import { messageText } from "./message-body.js";
import { decodeSessionCursor, encodeSessionCursor } from "./pagination.js";
import {
  authCookieHeaders,
  clearAuthCookieHeaders,
  consumePairingCode,
  createAuthSession,
  currentDeviceId,
  issuePairingCode,
  listAuthSessions,
  requestIsSecure,
  revokeAuthSession,
  shouldRequireGatewayAuth,
  verifyGatewayAuth,
} from "./auth.js";
import { handleWorkflowApi } from "./workflow-api.js";
import type { WorkflowService } from "../workflows/service.js";
import { shouldRequireGatewayAuth as workflowAuthRequired, verifyGatewayAuth as workflowVerifyAuth } from "./auth.js";
import { getDiskSpaceStatus } from "../shared/storage-health.js";
import { ptySnapshotStore } from "../engines/pty-snapshot.js";
import { collectClaudeUsage } from "../shared/claude-usage.js";
import { PairingAttemptLimiter, pairingAttemptKey } from "./pairing-rate-limit.js";
import { personalizeInstructionMd, personalizeIdentityMd, resolveEffectiveName } from "./onboarding-personalize.js";
import { patchPortalSection, writeFileAtomic } from "./portal-config.js";

/** Max bytes accepted on /api/internal/hook (loopback-only relay payloads are tiny). */
const HOOK_BODY_MAX_BYTES = 64 * 1024;
const PAIR_BODY_MAX_BYTES = 1024;
const PAIR_ATTEMPT_WINDOW_MS = 5 * 60_000;
const pairingAttempts = new PairingAttemptLimiter(10, PAIR_ATTEMPT_WINDOW_MS);
const pairingGlobalAttempts = new PairingAttemptLimiter(1_000, PAIR_ATTEMPT_WINDOW_MS, 1);

export interface ApiContext {
  config: JinnConfig;
  sessionManager: SessionManager;
  startTime: number;
  getConfig: () => JinnConfig;
  emit: (event: string, payload: unknown) => void;
  connectors: Map<string, import("../shared/types.js").Connector>;
  reloadConnectorInstances?: () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
  /**
   * Reload BOTH top-level (slack/discord/telegram/whatsapp) and instance-based
   * connectors from the current on-disk config. Use this when config.yaml
   * changes — particularly Slack tokens saved via the WebUI.
   */
  reloadAllConnectors?: () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
  /**
   * Tell the file watcher to ignore the next config-change event for the
   * purpose of triggering a connector reload. Call this *before* writing to
   * ~/.ryoko/config.yaml when the same code path is also going to call
   * reloadAllConnectors() itself — without it the watcher will fire ~500ms
   * later and start a redundant disconnect/reconnect cycle.
   */
  suppressNextConnectorReload?: () => void;
  /**
   * Cancel a previously-armed {@link suppressNextConnectorReload}. Used in
   * the failure path of an eager reload so the watcher is allowed to retry
   * instead of being permanently silenced for the next event.
   */
  clearSuppressNextConnectorReload?: () => void;
  /**
   * Hook registry + shared secret for the interactive Claude (PTY) engine. Only
   * set when the interactive engine is active (config.engines.claude.interactive).
   * The /api/internal/hook route delivers Claude Code turn hooks (relayed by
   * hook-relay.mjs) into this registry to resolve in-flight PTY turns.
   */
  hookRegistry?: import("./hook-registry.js").HookRegistry;
  hookSecret?: string;
  authToken?: string;
  authHome?: string;
  /** Present only when config.workflows.enabled — carries the Workflow engine. */
  workflowService?: WorkflowService;
  /** The workflow store's own connection — atomic create wraps the repository
   *  writes in one transaction on it. Present alongside workflowService. */
  workflowDatabase?: import("better-sqlite3").Database;
  /** The workflow repository on that connection (atomic create writes through
   *  it so no service-side notifications fire mid-transaction). */
  workflowRepository?: import("../workflows/repository.js").WorkflowRepository;
}

export function resumePendingWebQueueItems(context: ApiContext): void {
  const pending = listAllPendingQueueItems();
  if (pending.length === 0) return;

  let resumed = 0;
  for (const item of pending) {
    let session = getSession(item.sessionId);
    if (!session) {
      cancelQueueItem(item.id);
      continue;
    }
    // Connector-origin sessions normally get their runs from the connector
    // route, EXCEPT notification wake-ups (detached jobs, child callbacks):
    // the job monitor already got its 200 and will never re-send, so a
    // restart here would strand the wake-up forever. Detect those by the
    // persisted notification message matching the queued prompt and resume
    // them with origin-connector delivery.
    let deliverToConnector = false;
    if (session.source !== "web") {
      const messages = getMessages(session.id);
      const match = [...messages].reverse().find((m) => m.content === item.prompt);
      if (match?.role !== "notification") continue;
      deliverToConnector = true;
    }
    session = maybeRevertEngineOverride(session);

    const config = context.getConfig();
    const engine = context.sessionManager.getEngine(session.engine);
    if (!engine) {
      cancelQueueItem(item.id);
      updateSession(session.id, { status: "error", lastActivity: new Date().toISOString(), lastError: `Engine "${session.engine}" not available` });
      continue;
    }

    // Ensure the session is in a runnable state
    updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });

    dispatchWebSessionRun(session, item.prompt, engine, config, context, { queueItemId: item.id, deliverToConnector });
    resumed++;
  }

  if (resumed > 0) {
    logger.info(`Re-dispatched ${resumed} pending web queue item(s) after gateway restart`);
  }
}

function maybeRevertEngineOverride(session: Session): Session {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return session;

  const originalEngine = typeof override.originalEngine === "string" ? override.originalEngine : null;
  const originalEngineSessionId = typeof override.originalEngineSessionId === "string"
    ? override.originalEngineSessionId
    : null;
  const syncSince = typeof override.syncSince === "string" ? override.syncSince : null;
  const untilIso = typeof override.until === "string" ? override.until : null;
  if (!originalEngine || !untilIso) return session;

  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime())) return session;
  if (until.getTime() > Date.now()) return session;

  const engineSessionsRaw = meta["engineSessions"];
  const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
    ? { ...(engineSessionsRaw as Record<string, unknown>) }
    : {};

  // Preserve the current engine session ID under its engine key
  if (session.engine && session.engineSessionId) {
    engineSessions[String(session.engine)] = session.engineSessionId;
  }

  const restoredSessionId = originalEngineSessionId
    ?? (typeof engineSessions[originalEngine] === "string" ? (engineSessions[originalEngine] as string) : null);

  const nextMeta = { ...meta, engineSessions } as Record<string, unknown>;
  if (originalEngine === "claude" && syncSince && session.engine !== "claude") {
    nextMeta["claudeSyncSince"] = syncSince;
  }
  delete (nextMeta as Record<string, unknown>)["engineOverride"];
  return updateSession(session.id, {
    engine: originalEngine,
    engineSessionId: restoredSessionId,
    transportMeta: nextMeta as any,
    lastError: null,
  }) ?? session;
}

// In-memory idempotency keys for notification wake-ups. The persisted-message
// comparison in the /message handler covers gateway restarts; this map covers
// the common case cheaply and caps unbounded growth by TTL pruning on write.
const seenDedupeKeys = new Map<string, number>();
const DEDUPE_TTL_MS = 60 * 60 * 1000;

function rememberDedupeKey(key: string): void {
  const now = Date.now();
  for (const [k, t] of seenDedupeKeys) {
    if (now - t > DEDUPE_TTL_MS) seenDedupeKeys.delete(k);
  }
  seenDedupeKeys.set(key, now);
}

function dispatchWebSessionRun(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
  opts?: { delayMs?: number; queueItemId?: string; attachments?: string[]; deliverToConnector?: boolean },
): void {
  const run = async () => {
    await context.sessionManager.getQueue().enqueue(session.sessionKey || session.sourceRef, async () => {
      context.emit("session:started", { sessionId: session.id });
      await runWebSession(session, prompt, engine, config, context, opts?.attachments, opts?.deliverToConnector);
    }, opts?.queueItemId);
  };

  const launch = () => {
    run().catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Web session ${session.id} dispatch error: ${errMsg}`);
      updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      context.emit("session:completed", {
        sessionId: session.id,
        result: null,
        error: errMsg,
      });
    });
  };

  if (opts?.delayMs && opts.delayMs > 0) {
    setTimeout(launch, opts.delayMs);
  } else {
    launch();
  }
}

/** Read a request body but stop buffering once it exceeds `maxBytes`. The stream
 *  is drained without retaining further chunks so the caller can still return a
 *  deterministic 413 response on the existing HTTP connection. */
function readBodyBounded(req: HttpRequest, maxBytes: number): Promise<{ ok: true; raw: string } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (r: { ok: true; raw: string } | { ok: false }) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        chunks.length = 0;
        finish({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ ok: true, raw: Buffer.concat(chunks).toString() }));
    req.on("error", () => finish({ ok: false }));
  });
}

function readBody(req: HttpRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function readBodyRaw(req: HttpRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req: HttpRequest, res: ServerResponse, maxBytes?: number): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const contentLength = Number(req.headers["content-length"] ?? NaN);
  if (maxBytes !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) {
    req.resume();
    json(res, { error: "Payload too large" }, 413);
    return { ok: false };
  }
  const bounded = maxBytes === undefined ? undefined : await readBodyBounded(req, maxBytes);
  if (bounded && !bounded.ok) {
    json(res, { error: "Payload too large" }, 413);
    return { ok: false };
  }
  const raw = bounded?.ok ? bounded.raw : await readBody(req);
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    badRequest(res, "Invalid JSON in request body");
    return { ok: false };
  }
}

/** Resolve an array of file IDs to local filesystem paths for engine consumption. */
function resolveAttachmentPaths(fileIds: unknown): string[] {
  if (!Array.isArray(fileIds)) return [];
  const paths: string[] = [];
  for (const id of fileIds) {
    if (typeof id !== "string" || !id.trim()) continue;
    const meta = getFile(id);
    if (!meta) {
      logger.warn(`Attachment file not found: ${id}`);
      continue;
    }
    const filePath = path.join(FILES_DIR, meta.id, meta.filename);
    if (fs.existsSync(filePath)) {
      paths.push(filePath);
    } else if (meta.path && fs.existsSync(meta.path)) {
      paths.push(meta.path);
    } else {
      logger.warn(`Attachment file missing on disk: ${id} (${meta.filename})`);
    }
  }
  return paths;
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}

const SANITIZED_KEYS = new Set(["token", "botToken", "signingSecret", "appToken"]);

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    // Skip sanitized secret placeholders — keep original value
    if (SANITIZED_KEYS.has(key) && sv === "***") continue;
    // JSON cannot carry `undefined`. An explicit null removes an optional
    // override, allowing clients to restore inherited/default behavior.
    if (sv === null) {
      delete result[key];
      continue;
    }
    if (Array.isArray(sv)) {
      // For arrays (e.g. instances), preserve secrets from matching items
      if (Array.isArray(tv)) {
        result[key] = sv.map((item: unknown) => {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const srcItem = item as Record<string, unknown>;
            // Find matching target item by id
            const matchTarget = (tv as unknown[]).find(
              (t) => t && typeof t === "object" && (t as Record<string, unknown>).id === srcItem.id
            ) as Record<string, unknown> | undefined;
            if (matchTarget) return deepMerge(matchTarget, srcItem);
          }
          return item;
        });
      } else {
        result[key] = sv;
      }
    } else if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

function matchRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function serializeSession(session: Session, context: ApiContext): Session {
  const queue = context.sessionManager.getQueue();
  const queueDepth = queue.getPendingCount(session.sessionKey || session.sourceRef);
  const transportState = queue.getTransportState(session.sessionKey || session.sourceRef, session.status);
  return {
    ...session,
    queueDepth,
    transportState,
  };
}

function checkInstanceHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "localhost", port, path: "/api/health", timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

export async function handleApiRequest(
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  try {
    // /api/workflows/** — the Workflow engine (upstream port). Routed before the
    // flat routes below; handleWorkflowApi returns false for everything else.
    if (context.workflowService && pathname.startsWith("/api/workflows")) {
      const authenticated = !workflowAuthRequired(context.getConfig())
        || Boolean(context.authToken && context.authHome
          && workflowVerifyAuth(req.headers, context.authToken, context.authHome));
      if (await handleWorkflowApi(req, res, { method, pathname, url },
        { service: context.workflowService, authenticated })) return;
    }

    // GET /api/onboarding/engines — is each configured engine INSTALLED and
    // STARTABLE, and what login state can be observed locally? This is an
    // install check with the best available auth signal — the wizard words it
    // that way. It never spends tokens or reaches the network. One probe runs
    // at a time (shared in-flight promise) and the result is cached briefly,
    // so a burst of requests spawns one set of child processes, not many.
    if (method === "GET" && pathname === "/api/onboarding/engines") {
      const config = context.getConfig();
      res.setHeader("Cache-Control", "no-store");
      return json(res, await probeOnboardingEngines(config));
    }

    // POST /api/onboarding/slack/connect — the whole Slack hookup as ONE
    // server-side operation: verify both tokens, save, reload, and if the
    // connector still fails to start, put the previous Slack config back and
    // reload again. The wizard calls only this, so "a wrong token never
    // overwrites a working connection" holds across the verify→save gap too.
    if (method === "POST" && pathname === "/api/onboarding/slack/connect") {
      const { readJsonBody } = await import("./http-helpers.js");
      const read = await readJsonBody(req, res, { maxBytes: 16 * 1024 });
      if (!read.ok) return;
      const body = read.body as { botToken?: unknown; appToken?: unknown } | null;
      const botToken = typeof body?.botToken === "string" ? body.botToken.trim() : "";
      const appToken = typeof body?.appToken === "string" ? body.appToken.trim() : "";
      if (!botToken.startsWith("xoxb-") || !appToken.startsWith("xapp-")) {
        return badRequest(res, "botToken must start with xoxb- and appToken with xapp-");
      }
      res.setHeader("Cache-Control", "no-store");
      return json(res, await connectSlack(context, botToken, appToken));
    }

    // POST /api/onboarding/slack/verify — prove BOTH Slack tokens before
    // anything is saved: auth.test for the bot token, apps.connections.open
    // for the app token (Socket Mode). Nothing is written here; the wizard
    // saves only after both answer ok, so a wrong token can never overwrite a
    // working connection.
    if (method === "POST" && pathname === "/api/onboarding/slack/verify") {
      const { readJsonBody } = await import("./http-helpers.js");
      const read = await readJsonBody(req, res, { maxBytes: 16 * 1024 });
      if (!read.ok) return;
      const body = read.body as { botToken?: unknown; appToken?: unknown } | null;
      const botToken = typeof body?.botToken === "string" ? body.botToken.trim() : "";
      const appToken = typeof body?.appToken === "string" ? body.appToken.trim() : "";
      if (!botToken.startsWith("xoxb-") || !appToken.startsWith("xapp-")) {
        return badRequest(res, "botToken must start with xoxb- and appToken with xapp-");
      }
      res.setHeader("Cache-Control", "no-store");
      return json(res, await verifySlackTokens(botToken, appToken));
    }

    // GET /api/automation/templates — the fill-in-the-blanks workflow shapes.    // GET /api/automation/templates — the fill-in-the-blanks workflow shapes.
    // Lives outside /api/workflows so a definition id can never shadow it.
    if (method === "GET" && pathname === "/api/automation/templates") {
      const { AUTOMATION_TEMPLATES } = await import("../workflows/templates.js");
      return json(res, { templates: AUTOMATION_TEMPLATES, workflowsEnabled: Boolean(context.workflowService) });
    }

    // POST /api/automation/templates/:id  — build from a template
    // POST /api/automation/definitions    — raw nodes/edges (agents, --file)
    // Both validate the FULL definition (schema + executability) up front and
    // then create+save+enable in ONE transaction (atomic-create.ts), so no
    // failure can leave a skeleton definition behind.
    {
      const templateParams = matchRoute("/api/automation/templates/:id", pathname);
      const isRawCreate = pathname === "/api/automation/definitions";
      if (method === "POST" && (templateParams || isRawCreate)) {
        if (!context.workflowService || !context.workflowDatabase || !context.workflowRepository) {
          return json(res, { error: "Workflow エンジンが無効です。config.workflows.enabled: true にして再起動してください。" }, 404);
        }
        const { isJsonMediaType } = await import("./media-type.js");
        if (!isJsonMediaType(req.headers["content-type"])) {
          return json(res, { error: "Content-Type must be application/json" }, 415);
        }
        const { readJsonBody } = await import("./http-helpers.js");
        const read = await readJsonBody(req, res, { maxBytes: 256 * 1024, rejectDuplicateTopLevelKeys: true });
        if (!read.ok) return; // readJsonBody already responded (bad JSON / dup keys / too large)
        const parsed = read.body;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return badRequest(res, "Request body must be a JSON object");
        }
        const known = new Set(isRawCreate
          ? ["name", "title", "description", "nodes", "edges", "enable"]
          : ["name", "title", "vars", "enable"]);
        const unknown = Object.keys(parsed).filter((key) => !known.has(key));
        if (unknown.length > 0) return badRequest(res, `Unknown field(s): ${unknown.join(", ")}`);
        const { name, title, vars, enable, description, nodes, edges } = parsed as {
          name?: unknown; title?: unknown; vars?: unknown; enable?: unknown;
          description?: unknown; nodes?: unknown; edges?: unknown;
        };
        if (typeof name !== "string" || !name.trim()) {
          return badRequest(res, "name is required (workflow id, alphanumeric + hyphen)");
        }
        if (title !== undefined && typeof title !== "string") return badRequest(res, "title must be a string");
        if (enable !== undefined && typeof enable !== "boolean") return badRequest(res, "enable must be a boolean");

        const { TemplateError } = await import("../workflows/templates.js");
        const { workflowDefinitionSchema } = await import("../workflows/model.js");
        const { validateExecutableWorkflow } = await import("../workflows/validation.js");
        const { WorkflowRepositoryError } = await import("../workflows/repository-support.js");
        const { createWorkflowAtomically } = await import("./workflow-atomic-create.js");
        try {
          let builtDescription: string | undefined;
          let builtNodes: unknown;
          let builtEdges: unknown;
          if (templateParams) {
            if (vars !== undefined && (typeof vars !== "object" || vars === null || Array.isArray(vars)
              || Object.values(vars).some((value) => typeof value !== "string"))) {
              return badRequest(res, "vars must be an object of string values");
            }
            const { buildTemplateBody } = await import("../workflows/templates.js");
            const built = buildTemplateBody(templateParams.id, (vars ?? {}) as Record<string, string>);
            builtDescription = built.description;
            builtNodes = built.nodes;
            builtEdges = built.edges;
          } else {
            if (description !== undefined && typeof description !== "string") return badRequest(res, "description must be a string");
            if (!Array.isArray(nodes) || !Array.isArray(edges)) return badRequest(res, "nodes and edges are required arrays");
            builtDescription = description as string | undefined;
            builtNodes = nodes;
            builtEdges = edges;
          }
          // Pre-validate the complete definition the save would produce.
          const now = new Date().toISOString();
          const candidate = workflowDefinitionSchema.safeParse({
            schemaVersion: 1, id: name, title: title ?? name,
            ...(builtDescription ? { description: builtDescription } : {}),
            revision: 1, enabled: false, createdAt: now, updatedAt: now,
            nodes: builtNodes, edges: builtEdges,
          });
          if (!candidate.success) {
            return json(res, { error: "Workflow definition is invalid.", issues: candidate.error.issues }, 422);
          }
          const executable = validateExecutableWorkflow(candidate.data);
          if (!executable.ok) {
            return json(res, { error: "Workflow definition is not executable.", issues: executable.issues }, 422);
          }
          const result = createWorkflowAtomically(context.workflowDatabase, context.workflowRepository, context.workflowService, {
            id: name, title: (title as string | undefined) ?? name,
            ...(builtDescription ? { description: builtDescription } : {}),
            nodes: candidate.data.nodes, edges: candidate.data.edges,
            enable: enable === true,
          });
          return json(res, result, 201);
        } catch (error) {
          if (error instanceof TemplateError) return json(res, { error: error.message }, 422);
          if (error instanceof WorkflowRepositoryError) {
            const status = error.code === "id-conflict" || error.code === "revision-conflict" ? 409
              : error.code === "not-found" ? 404 : 422;
            return json(res, { error: error.message, code: error.code }, status);
          }
          console.error(`[automation] create failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          return serverError(res, "Workflow create failed");
        }
      }
    }

    // POST /api/internal/hook — receive Claude Code turn hooks from hook-relay.mjs
    // (interactive PTY engine). Loopback-only + shared-secret authenticated.
    if (method === "POST" && pathname === "/api/internal/hook") {
      if (!context.hookRegistry || !context.hookSecret) {
        return json(res, { error: "Interactive mode not active" }, 503);
      }
      // Loopback check FIRST — before reading the body — so a non-loopback
      // caller can't force unbounded body buffering by sending a huge POST.
      const remote = req.socket.remoteAddress;
      if (!remote || !HOOK_LOOPBACK.has(remote)) {
        return json(res, { message: "forbidden" }, 403);
      }
      // Reject oversized bodies up front via Content-Length, then enforce the cap
      // mid-stream too (chunked / missing / lying Content-Length can't bypass it).
      const contentLength = Number(req.headers["content-length"] ?? NaN);
      if (Number.isFinite(contentLength) && contentLength > HOOK_BODY_MAX_BYTES) {
        return json(res, { error: "Payload too large" }, 413);
      }
      const bounded = await readBodyBounded(req, HOOK_BODY_MAX_BYTES);
      if (!bounded.ok) return json(res, { error: "Payload too large" }, 413);
      let hookBody: { jinnSessionId?: string; hook?: import("./hook-registry.js").HookPayload };
      try {
        hookBody = JSON.parse(bounded.raw);
      } catch {
        return json(res, { error: "Invalid JSON" }, 400);
      }
      const result = handleHookPost(
        { reg: context.hookRegistry, secret: context.hookSecret, remoteAddress: remote },
        req.headers["x-jinn-hook-secret"] as string | undefined,
        hookBody,
      );
      // Central engineSessionId capture: persist Claude's OWN session id the moment
      // it reports one (SessionStart, or Stop as backup), independent of turn state.
      // Without this, an interrupted turn or idle CLI-view spawn never persisted the
      // id, so the next cold respawn ran `claude` with resume:none → a fresh convo.
      if (
        result.status === 200 &&
        hookBody.jinnSessionId &&
        (hookBody.hook?.hook_event_name === "SessionStart" || hookBody.hook?.hook_event_name === "Stop") &&
        typeof hookBody.hook?.session_id === "string" &&
        hookBody.hook.session_id
      ) {
        const existing = getSession(hookBody.jinnSessionId);
        if (existing && existing.engineSessionId !== hookBody.hook.session_id) {
          updateSession(hookBody.jinnSessionId, { engineSessionId: hookBody.hook.session_id });
        }
      }
      return json(res, { ok: result.status === 200 }, result.status);
    }

    // Minimal unauthenticated liveness probe. Do not add runtime metadata here.
    if (method === "GET" && pathname === "/api/health") {
      res.setHeader("Cache-Control", "no-store");
      return json(res, { ok: true });
    }

    // GET /api/status
    if (method === "GET" && pathname === "/api/status") {
      const config = context.getConfig();
      const sessions = listSessions();
      const running = sessions.filter((s) => s.status === "running").length;
      const connectors = Object.fromEntries(
        Array.from(context.connectors.values()).map((connector) => [connector.name, connector.getHealth()]),
      );
      res.setHeader("Cache-Control", "no-store");
      return json(res, {
        status: "ok",
        uptime: Math.floor((Date.now() - context.startTime) / 1000),
        port: config.gateway.port || 7777,
        engines: {
          default: config.engines.default,
          // `interactive` tells the web UI the Claude engine runs as a live PTY
          // (cc_entrypoint=cli, Max-subsidized) — so the CLI view can attach the
          // live xterm (/ws/pty) instead of the poll-based transcript.
          claude: { model: config.engines.claude.model, available: true, interactive: config.engines.claude.interactive === true },
          codex: { model: config.engines.codex.model, available: true },
          ...(config.engines.gemini ? { gemini: { model: config.engines.gemini.model, available: true } } : {}),
        },
        sessions: { total: sessions.length, running, active: running },
        connectors,
        storage: getDiskSpaceStatus(),
      });
    }

    // GET /api/update — fixed-origin npm registry check with a shared cache.
    // `refresh=1` is used only by an explicit user action; normal dashboard
    // loads reuse the six-hour cache to avoid unnecessary external traffic.
    if (method === "GET" && pathname === "/api/update") {
      res.setHeader("Cache-Control", "no-store");
      return json(res, await checkForUpdates({ force: url.searchParams.get("refresh") === "1" }));
    }

    // Live Claude subscription buckets, including model-scoped weekly limits.
    // The collector returns only a fixed projection; OAuth credentials and raw
    // provider failures never cross the gateway boundary.
    if (method === "GET" && pathname === "/api/usage/claude") {
      return json(res, await collectClaudeUsage());
    }

    // Browser/device authentication. The state and redemption routes are the
    // only public auth endpoints; code creation and device management pass
    // through the gateway auth middleware (or Bearer token) in server.ts.
    if (method === "GET" && pathname === "/api/auth/state") {
      const authRequired = shouldRequireGatewayAuth(context.getConfig());
      const authenticated = Boolean(
        context.authToken && context.authHome && verifyGatewayAuth(req.headers, context.authToken, context.authHome),
      );
      res.setHeader("Cache-Control", "no-store");
      return json(res, {
        authRequired,
        authenticated,
        networkExposed: context.getConfig().gateway.host !== "127.0.0.1" && context.getConfig().gateway.host !== "localhost",
      });
    }

    if (method === "POST" && pathname === "/api/auth/pairing-codes") {
      if (!context.authHome) return json(res, { error: "Auth is not configured" }, 503);
      return json(res, { ...issuePairingCode(context.authHome), ttlSeconds: 300 });
    }

    if (method === "POST" && pathname === "/api/auth/pair") {
      if (!context.authHome) return json(res, { error: "Auth is not configured" }, 503);
      const parsed = await readJsonBody(req, res, PAIR_BODY_MAX_BYTES);
      if (!parsed.ok) return;
      const gateway = context.getConfig().gateway;
      const trustProxyHeaders = gateway.trustProxyHeaders === true;
      const trustedProxyAddresses = gateway.trustedProxyAddresses ?? [];
      const attemptKey = pairingAttemptKey(req, trustProxyHeaders, trustedProxyAddresses);
      if (!pairingAttempts.claim(attemptKey) || !pairingGlobalAttempts.claim("global")) {
        res.setHeader("Retry-After", String(Math.ceil(PAIR_ATTEMPT_WINDOW_MS / 1_000)));
        return json(res, { error: "Too many pairing attempts" }, 429);
      }
      const code = (parsed.body as { code?: unknown }).code;
      if (typeof code !== "string" || !consumePairingCode(context.authHome, code)) {
        return json(res, { error: "Invalid or expired pairing code" }, 401);
      }
      const session = createAuthSession(context.authHome, req);
      pairingAttempts.clear(attemptKey);
      const secure = requestIsSecure(req, trustProxyHeaders, trustedProxyAddresses);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Set-Cookie", authCookieHeaders(session.secret, session.id, context.authHome, secure));
      return json(res, { status: "ok" });
    }

    if (method === "POST" && pathname === "/api/auth/logout") {
      if (context.authHome) {
        const id = currentDeviceId(req.headers, context.authHome);
        if (id) revokeAuthSession(context.authHome, id);
      }
      res.setHeader("Set-Cookie", clearAuthCookieHeaders(context.authHome ?? JINN_HOME));
      return json(res, { status: "ok" });
    }

    if (method === "GET" && pathname === "/api/auth/devices") {
      if (!context.authHome) return json(res, { devices: [] });
      return json(res, { devices: listAuthSessions(context.authHome, currentDeviceId(req.headers, context.authHome)) });
    }

    let authParams = matchRoute("/api/auth/devices/:id", pathname);
    if (method === "DELETE" && authParams) {
      if (!context.authHome) return json(res, { error: "Auth is not configured" }, 503);
      const current = currentDeviceId(req.headers, context.authHome) === authParams.id;
      if (!revokeAuthSession(context.authHome, authParams.id)) return notFound(res);
      if (current) res.setHeader("Set-Cookie", clearAuthCookieHeaders(context.authHome));
      return json(res, { status: "ok", current });
    }

    // GET /api/instances
    if (method === "GET" && pathname === "/api/instances") {
      const instances = loadInstances();
      const currentPort = context.getConfig().gateway.port || 7777;
      const gateway = context.getConfig().gateway;
      const protocol = requestIsSecure(
        req,
        gateway.trustProxyHeaders === true,
        gateway.trustedProxyAddresses ?? [],
      ) ? "https" : "http";
      let requestHostname = "localhost";
      try { requestHostname = new URL(`${protocol}://${req.headers.host || "localhost"}`).hostname; } catch { /* fallback */ }
      const urlHost = requestHostname.includes(":") ? `[${requestHostname}]` : requestHostname;
      const results = await Promise.all(
        instances.map(async (inst) => ({
          name: inst.name,
          displayName: inst.name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
          port: inst.port,
          running: inst.port === currentPort ? true : await checkInstanceHealth(inst.port),
          current: inst.port === currentPort,
          switchUrl: `${protocol}://${urlHost}:${inst.port}/chat`,
        }))
      );
      return json(res, results);
    }

    // GET /api/sessions
    if (method === "GET" && pathname === "/api/sessions") {
      if (url.searchParams.has("limit") || url.searchParams.has("cursor")) {
        let cursor;
        try { cursor = decodeSessionCursor(url.searchParams.get("cursor")); }
        catch (err) { return badRequest(res, err instanceof Error ? err.message : String(err)); }
        const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 200));
        const page = listSessionPage(limit, cursor);
        return json(res, {
          sessions: page.sessions.map((session) => serializeSession(session, context)),
          nextCursor: encodeSessionCursor(page.nextCursor),
        });
      }
      const sessions = listSessions();
      return json(res, sessions.map((session) => serializeSession(session, context)));
    }

    // GET /api/search/messages?q=... — FTS5 over user/assistant history.
    if (method === "GET" && pathname === "/api/search/messages") {
      const query = (url.searchParams.get("q") || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
      if (!query) return badRequest(res, "q is required");
      if (query.length > 500) return badRequest(res, "q is too long (max 500 characters)");
      const role = url.searchParams.get("role");
      if (role && role !== "user" && role !== "assistant") return badRequest(res, 'role must be "user" or "assistant"');
      const results = searchMessages(query, parseInt(url.searchParams.get("limit") || "20", 10), {
        sessionId: url.searchParams.get("sessionId") || undefined,
        employee: url.searchParams.get("employee") || undefined,
        engine: url.searchParams.get("engine") || undefined,
        role: role as "user" | "assistant" | undefined,
      });
      return json(res, { query, results, indexing: isFtsBackfillPending() });
    }

    // GET /api/sessions/interrupted — list sessions that can be resumed after a restart
    if (method === "GET" && pathname === "/api/sessions/interrupted") {
      const { getInterruptedSessions } = await import("../sessions/registry.js");
      const interrupted = getInterruptedSessions();
      return json(res, interrupted.map((session) => serializeSession(session, context)));
    }

    // GET /api/sessions/:id
    let params = matchRoute("/api/sessions/:id", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const includeMessages = url.searchParams.get("messages") !== "0";
      const lastN = Math.max(0, Math.min(parseInt(url.searchParams.get("last") || "0", 10) || 0, 200));
      let messagePage = includeMessages && lastN > 0 ? getMessagePage(params.id, { limit: lastN }) : null;
      let messages = includeMessages ? (messagePage?.messages ?? getMessages(params.id)) : [];

      // Backfill from Claude Code's JSONL transcript if our DB has no messages
      if (includeMessages && messages.length === 0 && session.engineSessionId) {
        const transcriptMessages = loadTranscriptMessages(session.engineSessionId);
        if (transcriptMessages.length > 0) {
          for (const tm of transcriptMessages) {
            insertMessage(params.id, tm.role, tm.content);
          }
          messagePage = lastN > 0 ? getMessagePage(params.id, { limit: lastN }) : null;
          messages = messagePage?.messages ?? getMessages(params.id);
        }
      }

      return json(res, {
        ...serializeSession(session, context),
        ...(includeMessages ? { messages } : {}),
        ...(messagePage ? { messagesPage: { hasOlder: messagePage.hasOlder } } : {}),
      });
    }

    // GET /api/sessions/:id/messages?before=<messageId>&limit=N
    params = matchRoute("/api/sessions/:id/messages", pathname);
    if (method === "GET" && params) {
      if (!getSession(params.id)) return notFound(res);
      const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 200));
      const around = url.searchParams.get("around");
      if (around) return json(res, getMessageWindow(params.id, around, Math.min(limit, 100)));
      return json(res, getMessagePage(params.id, { before: url.searchParams.get("before") || undefined, limit }));
    }

    // PUT /api/sessions/:id
    params = matchRoute("/api/sessions/:id", pathname);
    if (method === "PUT" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const updates: UpdateSessionFields = {};
      if (body.title !== undefined) {
        if (typeof body.title !== "string") return badRequest(res, "title must be a string");
        const trimmed = body.title.trim();
        if (!trimmed) return badRequest(res, "title must not be empty");
        updates.title = trimmed.slice(0, 200);
      }
      if (Object.keys(updates).length === 0) return badRequest(res, "no valid fields to update");
      const updated = updateSession(params.id, updates);
      if (!updated) return notFound(res);
      context.emit("session:updated", { sessionId: params.id });
      return json(res, serializeSession(updated, context));
    }

    // DELETE /api/sessions/:id
    params = matchRoute("/api/sessions/:id", pathname);
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);

      // Kill any live engine process for this session before deleting it.
      const engine = context.sessionManager.getEngine(session.engine);
      if (engine && isInterruptibleEngine(engine) && engine.isAlive(params.id)) {
        logger.info(`Killing live engine process for deleted session ${params.id}`);
        engine.kill(params.id);
      }

      const deleted = deleteSession(params.id);
      if (!deleted) return notFound(res);
      ptySnapshotStore.deleteSync(params.id);
      logger.info(`Session deleted: ${params.id}`);
      context.emit("session:deleted", { sessionId: params.id });
      return json(res, { status: "deleted" });
    }

    // POST /api/sessions/:id/stop
    params = matchRoute("/api/sessions/:id/stop", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const engine = context.sessionManager.getEngine(session.engine);
      if (engine && isInterruptibleEngine(engine) && engine.isAlive(params.id)) {
        engine.kill(params.id, "Interrupted by user");
      }
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      updateSession(params.id, { status: "idle", lastActivity: new Date().toISOString(), lastError: null });
      context.emit("session:stopped", { sessionId: params.id });
      return json(res, { status: "stopped", sessionId: params.id });
    }

    // POST /api/sessions/:id/reset — clear stuck session state (stale engine IDs, errors)
    params = matchRoute("/api/sessions/:id/reset", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const engine = context.sessionManager.getEngine(session.engine);
      if (engine && isInterruptibleEngine(engine) && engine.isAlive(params.id)) {
        engine.kill(params.id, "Interrupted by reset");
      }
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
      const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
      delete meta["engineSessions"];
      delete meta["engineOverride"];
      updateSession(params.id, {
        status: "idle",
        engineSessionId: null,
        lastActivity: new Date().toISOString(),
        lastError: null,
        transportMeta: meta as any,
      });
      ptySnapshotStore.deleteSync(params.id);
      logger.info(`Session ${params.id} reset via API (cleared engineSessions, engineOverride, engineSessionId, lastError)`);
      context.emit("session:updated", { sessionId: params.id });
      return json(res, { status: "reset", sessionId: params.id });
    }

    // POST /api/sessions/:id/duplicate — duplicate a session (snapshot fork)
    params = matchRoute("/api/sessions/:id/duplicate", pathname);
    if (method === "POST" && params) {
      const source = getSession(params.id);
      if (!source) return notFound(res);
      if (!source.engineSessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session has no engine session ID — cannot duplicate" }));
        return;
      }

      let newSessionId: string | null = null;
      try {
        // 1. Duplicate session + messages in the registry
        const { session: newSession, messageCount } = duplicateSession(params.id);
        newSessionId = newSession.id;

        // 2. Fork the engine session (Claude/Codex/Gemini)
        const forkResult = forkEngineSession(source.engine, source.engineSessionId, JINN_HOME);

        // 3. Store the new engine session ID
        updateSession(newSession.id, { engineSessionId: forkResult.engineSessionId });

        const result = getSession(newSession.id)!;
        logger.info(`Session duplicated: ${params.id} → ${newSession.id} (engine: ${forkResult.engineSessionId}, ${messageCount} messages)`);
        context.emit("session:created", { sessionId: newSession.id });
        return json(res, serializeSession(result, context));
      } catch (err: any) {
        // Clean up orphaned session if the engine fork failed after DB insert
        if (newSessionId) {
          try { deleteSession(newSessionId); } catch { /* best effort */ }
        }
        logger.error(`Failed to duplicate session ${params.id}: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Duplicate failed: ${err.message}` }));
        return;
      }
    }

    // DELETE /api/sessions/:id/queue/:itemId — cancel specific item
    const queueItemParams = matchRoute("/api/sessions/:id/queue/:itemId", pathname);
    if (method === "DELETE" && queueItemParams) {
      const session = getSession(queueItemParams.id);
      if (!session) return notFound(res);
      const cancelled = cancelQueueItem(queueItemParams.itemId);
      if (!cancelled) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Item not found or already running" }));
        return;
      }
      context.emit("queue:updated", { sessionId: queueItemParams.id, sessionKey: session.sessionKey });
      return json(res, { status: "cancelled", itemId: queueItemParams.itemId });
    }

    // GET /api/sessions/:id/queue
    params = matchRoute("/api/sessions/:id/queue", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const items = getQueueItems(session.sessionKey || session.sourceRef || session.id);
      return json(res, items);
    }

    // DELETE /api/sessions/:id/queue — clear all pending
    params = matchRoute("/api/sessions/:id/queue", pathname);
    if (method === "DELETE" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().clearQueue(sessionKey);
      const cancelled = cancelAllPendingQueueItems(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, depth: 0 });
      return json(res, { status: "cleared", cancelled });
    }

    // POST /api/sessions/:id/queue/pause
    params = matchRoute("/api/sessions/:id/queue/pause", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().pauseQueue(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: true });
      return json(res, { status: "paused", sessionId: params.id });
    }

    // POST /api/sessions/:id/queue/resume
    params = matchRoute("/api/sessions/:id/queue/resume", pathname);
    if (method === "POST" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      context.sessionManager.getQueue().resumeQueue(sessionKey);
      context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: false });
      return json(res, { status: "resumed", sessionId: params.id });
    }

    // POST /api/sessions/bulk-delete
    if (method === "POST" && pathname === "/api/sessions/bulk-delete") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const ids: string[] = body.ids;
      if (!Array.isArray(ids) || ids.length === 0) return badRequest(res, "ids array is required");

      // Kill any live engine processes before deleting
      for (const id of ids) {
        const session = getSession(id);
        if (!session) continue;
        const engine = context.sessionManager.getEngine(session.engine);
        if (engine && isInterruptibleEngine(engine) && engine.isAlive(id)) {
          engine.kill(id);
        }
      }

      const count = deleteSessions(ids);
      for (const id of ids) {
        ptySnapshotStore.deleteSync(id);
        context.emit("session:deleted", { sessionId: id });
      }
      logger.info(`Bulk deleted ${count} sessions`);
      return json(res, { status: "deleted", count });
    }

    // GET /api/sessions/:id/children
    params = matchRoute("/api/sessions/:id/children", pathname);
    if (method === "GET" && params) {
      const children = listSessions().filter((s) => s.parentSessionId === params!.id);
      return json(res, children.map((child) => serializeSession(child, context)));
    }

    // GET /api/sessions/:id/transcript — return raw Claude Code session transcript
    params = matchRoute("/api/sessions/:id/transcript", pathname);
    if (method === "GET" && params) {
      const session = getSession(params.id);
      if (!session) return notFound(res);
      if (!session.engineSessionId) return json(res, []);
      const entries = loadRawTranscript(session.engineSessionId);
      return json(res, entries);
    }

    // POST /api/sessions/stub — create a session with a pre-populated assistant
    // message but do NOT run the engine. Used for lazy onboarding.
    if (method === "POST" && pathname === "/api/sessions/stub") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const greeting = body.greeting || "Hey! Say hi when you're ready to get started.";
      const config = context.getConfig();
      const engineName = body.engine || config.engines.default;
      const sessionKey = `web:${Date.now()}`;
      const session = createSession({
        engine: engineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        employee: body.employee,
        title: body.title,
        portalName: config.portal?.portalName,
      });
      insertMessage(session.id, "assistant", greeting);
      logger.info(`Stub session created: ${session.id}`);
      return json(res, serializeSession(session, context), 201);
    }

    // POST /api/sessions
    if (method === "POST" && pathname === "/api/sessions") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const prompt = messageText(body, ["prompt", "message"]);
      if (!prompt) return badRequest(res, "prompt or message must be a non-empty string");
      const config = context.getConfig();
      const engineName = body.engine || config.engines.default;
      const sessionKey = `web:${Date.now()}`;
      const session = createSession({
        engine: engineName,
        source: "web",
        sourceRef: sessionKey,
        connector: "web",
        sessionKey,
        replyContext: { source: "web" },
        employee: body.employee,
        parentSessionId: body.parentSessionId,
        effortLevel: body.effortLevel,
        prompt,
        portalName: config.portal?.portalName,
      });
      logger.info(`Web session created: ${session.id}`);
      insertMessage(session.id, "user", prompt);

      // Run engine asynchronously — respond immediately, push result via WebSocket
      const engine = context.sessionManager.getEngine(engineName);
      if (!engine) {
        updateSession(session.id, {
          status: "error",
          lastError: `Engine "${engineName}" not available`,
        });
        return json(res, { ...serializeSession({ ...session, status: "error", lastError: `Engine "${engineName}" not available` }, context) }, 201);
      }

      // Set status to "running" synchronously BEFORE returning the response.
      // This prevents a race condition where the caller polls immediately and
      // sees "idle" status before runWebSession has a chance to set "running".
      updateSession(session.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
      session.status = "running";

      const attachmentPaths = resolveAttachmentPaths(body.attachments);

      const queueSessionKey = session.sessionKey || session.sourceRef || session.id;
      const queueItemId = enqueueQueueItem(session.id, queueSessionKey, prompt);
      context.emit("queue:updated", { sessionId: session.id, sessionKey: queueSessionKey });

      dispatchWebSessionRun(session, prompt, engine, config, context, { queueItemId, attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined });

      return json(res, serializeSession(session, context), 201);
    }

    // POST /api/sessions/:id/message
    params = matchRoute("/api/sessions/:id/message", pathname);
    if (method === "POST" && params) {
      let session = getSession(params.id);
      if (!session) return notFound(res);
      session = maybeRevertEngineOverride(session);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const prompt = messageText(body, ["message", "prompt"]);
      if (!prompt) return badRequest(res, "message must be a non-empty string");

      // Allow internal callers (e.g. child session callbacks) to specify a non-user role
      const messageRole: string = body.role === "notification" ? "notification" : "user";
      const isNotification = messageRole === "notification";

      // Notification wake-ups are a loopback-only mechanism (job monitors,
      // child-session callbacks). A remote caller must not be able to wake an
      // arbitrary session — the woken turn can post into its origin Slack
      // conversation, so this would be a remote-to-customer-channel bridge.
      if (isNotification && (!req.socket.remoteAddress || !HOOK_LOOPBACK.has(req.socket.remoteAddress))) {
        return json(res, { error: "notification role is loopback-only" }, 403);
      }

      // Idempotency: a job monitor retries its wake-up when a response is
      // lost after the gateway already accepted it. Same dedupeKey (+ an
      // identical persisted notification, which survives restarts) → don't
      // enqueue a second engine turn. The key is only REMEMBERED after the
      // message + queue item are durably persisted below, so a failure
      // before that point never turns the retry into a false duplicate.
      const dedupeKey = typeof body.dedupeKey === "string" && body.dedupeKey.trim() ? body.dedupeKey.trim() : null;
      const dedupedNotification = isNotification && dedupeKey !== null;
      if (dedupedNotification) {
        const duplicate = seenDedupeKeys.has(dedupeKey!)
          || getMessages(session.id).some((m) => m.role === "notification" && m.content === prompt);
        if (duplicate) {
          return json(res, { status: "duplicate", sessionId: session.id });
        }
      }

      const config = context.getConfig();
      const engine = context.sessionManager.getEngine(session.engine);
      if (!engine) return serverError(res, `Engine "${session.engine}" not available`);

      // Persist the message immediately. Deduped notifications defer this to
      // the atomic message+queue-item write below — the duplicate check above
      // treats "message exists" as "turn queued", so the two writes must
      // never be separable by a crash.
      if (!dedupedNotification) {
        insertMessage(session.id, messageRole, prompt);
      }

      // Emit notification event for UI display (renders as system banner, not user bubble)
      if (isNotification) {
        context.emit("session:notification", { sessionId: session.id, message: prompt });
        // Don't return early — fall through to enqueue + dispatch so the engine
        // (e.g. the COO) actually processes the notification and can respond.
      }

      if (!isNotification && session.status === "waiting") {
        const expectedResetAt = getClaudeExpectedResetAt();
        const resumeText = expectedResetAt
          ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
          : null;
        const queuedText =
          `⏳ Still paused due to Claude usage limit${resumeText ? ` (resets ${resumeText})` : ""}. Your message is queued and will run automatically.`;
        insertMessage(session.id, "notification", queuedText);
        context.emit("session:notification", { sessionId: session.id, message: queuedText });
      }

      // If a turn is already running, check whether we should interrupt or queue.
      // Notifications (child completion callbacks) should never interrupt — just queue.
      if (session.status === "running") {
        if (!isNotification && (config.sessions?.interruptOnNewMessage ?? true) && isInterruptibleEngine(engine) && engine.isAlive(session.id)) {
          logger.info(`Interrupting running session ${session.id} for new message`);
          engine.kill(session.id, "Interrupted: new message received");
          // Wait briefly for the process to exit so the queue slot frees up
          await new Promise((resolve) => setTimeout(resolve, 500));
          context.emit("session:interrupted", { sessionId: session.id, reason: "new message" });
        } else {
          context.emit("session:queued", { sessionId: session.id, message: prompt });
        }
      }

      // If session was interrupted by a restart, clear the error and resume
      if (session.status === "interrupted") {
        logger.info(`Resuming interrupted session ${session.id} (engineSessionId: ${session.engineSessionId})`);
        updateSession(session.id, {
          status: "running",
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        context.emit("session:resumed", { sessionId: session.id });
      }

      // Clear any pending cancellation so the new message runs normally.
      context.sessionManager.getQueue().clearCancelled(session.sessionKey || session.sourceRef || session.id);

      const attachmentPaths = resolveAttachmentPaths(body.attachments);

      const sessionKey = session.sessionKey || session.sourceRef || session.id;
      const queueItemId = dedupedNotification
        ? insertNotificationWithQueueItem(session.id, sessionKey, prompt)
        : enqueueQueueItem(session.id, sessionKey, prompt);
      if (dedupedNotification) rememberDedupeKey(dedupeKey!);
      context.emit("queue:updated", { sessionId: session.id, sessionKey });

      dispatchWebSessionRun(session, prompt, engine, config, context, {
        queueItemId,
        attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
        // A notification wake-up (detached job finished, child callback) runs
        // on this connector-less path; deliver the answer back to the origin
        // conversation so e.g. a Slack thread is not left waiting silently.
        deliverToConnector: isNotification,
      });

      return json(res, { status: "queued", sessionId: session.id });
    }

    // GET /api/cron
    if (method === "GET" && pathname === "/api/cron") {
      const jobs = loadJobs();
      // Enrich with last run status
      const enriched = jobs.map((job) => {
        const runFile = path.join(CRON_RUNS, `${job.id}.jsonl`);
        let lastRun = null;
        if (fs.existsSync(runFile)) {
          const lines = fs.readFileSync(runFile, "utf-8").trim().split("\n").filter(Boolean);
          if (lines.length > 0) {
            try { lastRun = JSON.parse(lines[lines.length - 1]); } catch {}
          }
        }
        return { ...job, lastRun };
      });
      return json(res, enriched);
    }

    // GET /api/cron/:id/runs
    params = matchRoute("/api/cron/:id/runs", pathname);
    if (method === "GET" && params) {
      const runFile = path.join(CRON_RUNS, `${params.id}.jsonl`);
      if (!fs.existsSync(runFile)) return json(res, []);
      const lines = fs
        .readFileSync(runFile, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      return json(res, lines);
    }

    // POST /api/cron — create new cron job
    if (method === "POST" && pathname === "/api/cron") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const jobs = loadJobs();
      const newJobId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : crypto.randomUUID();
      if (jobs.some((job) => job.id === newJobId)) {
        return json(res, { error: `Cron job id already exists: ${newJobId}` }, 409);
      }
      const newJob: CronJob = {
        id: newJobId,
        name: body.name || "untitled",
        enabled: body.enabled ?? true,
        schedule: body.schedule || "0 * * * *",
        kind: body.kind === "update-notification" ? "update-notification" : "prompt",
        timezone: body.timezone,
        engine: body.engine,
        model: body.model,
        employee: body.employee,
        prompt: body.prompt || "",
        delivery: body.delivery,
      };
      if (newJob.kind === "update-notification") {
        if (!cron.validate(newJob.schedule)) return badRequest(res, "Invalid cron schedule");
        if (newJob.enabled && (
          !newJob.delivery ||
          typeof newJob.delivery.connector !== "string" || !newJob.delivery.connector.trim() ||
          typeof newJob.delivery.channel !== "string" || !newJob.delivery.channel.trim()
        )) {
          return badRequest(res, "Enabled update notifications require a delivery connector and channel");
        }
      }
      jobs.push(newJob);
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, newJob, 201);
    }

    // PUT /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "PUT" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const updated = { ...jobs[idx], ...body, id: params.id } as CronJob;
      if (updated.kind !== undefined && updated.kind !== "prompt" && updated.kind !== "update-notification") {
        return badRequest(res, "Invalid cron job kind");
      }
      if (updated.kind === "update-notification") {
        if (!cron.validate(updated.schedule)) return badRequest(res, "Invalid cron schedule");
        if (updated.enabled && (
          !updated.delivery ||
          typeof updated.delivery.connector !== "string" || !updated.delivery.connector.trim() ||
          typeof updated.delivery.channel !== "string" || !updated.delivery.channel.trim()
        )) {
          return badRequest(res, "Enabled update notifications require a delivery connector and channel");
        }
      }
      jobs[idx] = updated;
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, jobs[idx]);
    }

    // DELETE /api/cron/:id
    params = matchRoute("/api/cron/:id", pathname);
    if (method === "DELETE" && params) {
      const jobs = loadJobs();
      const idx = jobs.findIndex((j) => j.id === params!.id);
      if (idx === -1) return notFound(res);
      const removed = jobs.splice(idx, 1)[0];
      saveJobs(jobs);
      reloadScheduler(jobs);
      return json(res, { deleted: removed.id, name: removed.name });
    }

    // POST /api/cron/:id/trigger — manually run a cron job now
    params = matchRoute("/api/cron/:id/trigger", pathname);
    if (method === "POST" && params) {
      const jobs = loadJobs();
      const job = jobs.find((j) => j.id === params!.id);
      if (!job) return notFound(res);

      logger.info(`Manual trigger for cron job "${job.name}" (${job.id})`);

      // Fire and forget — respond immediately, run in background
      runCronJob(job, context.sessionManager, context.getConfig(), context.connectors).catch(
        (err) => logger.error(`Manual cron trigger failed for "${job.name}": ${err}`)
      );

      return json(res, {
        triggered: true,
        jobId: job.id,
        name: job.name,
        employee: job.employee,
        message: `Cron job "${job.name}" triggered manually`,
      });
    }

    // GET /api/org
    if (method === "GET" && pathname === "/api/org") {
      if (!fs.existsSync(ORG_DIR)) return json(res, { departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } });
      const entries = fs.readdirSync(ORG_DIR, { withFileTypes: true });
      const departments = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      const { scanOrg } = await import("./org.js");
      const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
      const orgRegistry = scanOrg();
      const hierarchy = resolveOrgHierarchy(orgRegistry);

      const employees = hierarchy.sorted.map((name) => {
        const node = hierarchy.nodes[name];
        const emp = node.employee;
        const { persona, ...rest } = emp;
        return {
          ...rest,
          parentName: node.parentName,
          directReports: node.directReports,
          depth: node.depth,
          chain: node.chain,
        };
      });

      return json(res, {
        departments,
        employees,
        hierarchy: {
          root: hierarchy.root,
          sorted: hierarchy.sorted,
          warnings: hierarchy.warnings,
        },
      });
    }

    // GET /api/org/employees/:name
    params = matchRoute("/api/org/employees/:name", pathname);
    if (method === "GET" && params) {
      const { scanOrg } = await import("./org.js");
      const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
      const orgRegistry = scanOrg();
      const emp = orgRegistry.get(params.name);
      if (!emp) return notFound(res);

      const hierarchy = resolveOrgHierarchy(orgRegistry);
      const node = hierarchy.nodes[params.name];

      return json(res, {
        ...emp,
        parentName: node?.parentName ?? null,
        directReports: node?.directReports ?? [],
        depth: node?.depth ?? 0,
        chain: node?.chain ?? [params.name],
      });
    }

    // PATCH /api/org/employees/:name — update employee fields (currently only alwaysNotify)
    params = matchRoute("/api/org/employees/:name", pathname);
    if (method === "PATCH" && params) {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const body = _parsed.body as any;
      const { updateEmployeeYaml } = await import("./org.js");
      const updated = updateEmployeeYaml(params.name, {
        alwaysNotify: typeof body.alwaysNotify === "boolean" ? body.alwaysNotify : undefined,
      });
      if (!updated) return notFound(res);
      context.emit("org:updated", { employee: params.name });
      return json(res, { status: "ok" });
    }

    // GET /api/org/services — list all cross-department services
    if (method === "GET" && pathname === "/api/org/services") {
      const { scanOrg } = await import("./org.js");
      const { buildServiceRegistry } = await import("./services.js");
      const orgRegistry = scanOrg();
      const services = buildServiceRegistry(orgRegistry);
      const result = Array.from(services.values()).map((entry) => ({
        name: entry.declaration.name,
        description: entry.declaration.description,
        provider: {
          name: entry.provider.name,
          displayName: entry.provider.displayName,
          department: entry.provider.department,
          rank: entry.provider.rank,
        },
      }));
      return json(res, { services: result });
    }

    // POST /api/org/cross-request — route a service request to the provider
    if (method === "POST" && pathname === "/api/org/cross-request") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return;
      const body = parsed.body as any;
      const { fromEmployee, service, prompt, parentSessionId } = body;
      if (!fromEmployee || !service || !prompt) {
        return badRequest(res, "Missing required fields: fromEmployee, service, prompt");
      }

      const { scanOrg } = await import("./org.js");
      const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
      const { buildServiceRegistry, buildRoutePath, resolveManagerChain } = await import("./services.js");

      const orgRegistry = scanOrg();
      const requester = orgRegistry.get(fromEmployee);
      if (!requester) return notFound(res);

      const services = buildServiceRegistry(orgRegistry);
      const entry = services.get(service);
      if (!entry) {
        return json(res, { error: `Service "${service}" not found` }, 404);
      }

      const hierarchy = resolveOrgHierarchy(orgRegistry);
      const route = buildRoutePath(fromEmployee, entry.provider.name, hierarchy);
      const managers = resolveManagerChain(route, hierarchy);

      const crossBrief = `## Cross-service request

**From**: ${requester.displayName} (${requester.department})
**Service**: ${service} — ${entry.declaration.description}

### Request
${prompt}

---
Handle this as a priority request from a colleague.`;

      const config = context.getConfig();
      const session = createSession({
        engine: entry.provider.engine || config.engines.default,
        model: entry.provider.model || undefined,
        source: "cross-request",
        sourceRef: `cross:${fromEmployee}:${service}`,
        connector: "web",
        sessionKey: `cross:${Date.now()}`,
        replyContext: { source: "cross-request" },
        employee: entry.provider.name,
        parentSessionId: parentSessionId || undefined,
        prompt: crossBrief,
        portalName: config.portal?.portalName,
        title: `Cross-request: ${fromEmployee} → ${service}`,
      });
      insertMessage(session.id, "user", crossBrief);
      logger.info(`Cross-request session created: ${session.id} (${fromEmployee} → ${service} → ${entry.provider.name})`);

      return json(res, {
        sessionId: session.id,
        provider: {
          name: entry.provider.name,
          displayName: entry.provider.displayName,
          department: entry.provider.department,
        },
        route,
        managers: managers.map((m) => m.employee.name),
        service,
      }, 201);
    }

    // GET /api/org/departments/:name/board
    params = matchRoute("/api/org/departments/:name/board", pathname);
    if (method === "GET" && params) {
      const boardPath = path.join(ORG_DIR, params.name, "board.json");
      if (!fs.existsSync(boardPath)) return notFound(res);
      const board = JSON.parse(fs.readFileSync(boardPath, "utf-8"));
      return json(res, board);
    }

    // PUT /api/org/departments/:name/board
    if (method === "PUT" && matchRoute("/api/org/departments/:name/board", pathname)) {
      const p = matchRoute("/api/org/departments/:name/board", pathname)!;
      const boardPath = path.join(ORG_DIR, p.name, "board.json");
      const deptDir = path.join(ORG_DIR, p.name);
      if (!fs.existsSync(deptDir)) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      fs.writeFileSync(boardPath, JSON.stringify(body, null, 2));
      context.emit("board:updated", { department: p.name });
      return json(res, { status: "ok" });
    }

    // GET /api/skills/search?q=<query> — search the skills.sh registry
    if (method === "GET" && pathname === "/api/skills/search") {
      const query = url.searchParams.get("q") || "";
      if (!query) return badRequest(res, "q parameter is required");
      try {
        const { execFileSync } = await import("node:child_process");
        const output = execFileSync("npx", ["skills", "find", query], {
          encoding: "utf-8",
          timeout: 30000,
        });
        const results = parseSkillsSearchOutput(output);
        return json(res, results);
      } catch (err) {
        const msg = err instanceof Error ? (err as any).stderr || err.message : String(err);
        return json(res, { results: [], error: msg });
      }
    }

    // GET /api/skills/manifest — return skills.json contents
    if (method === "GET" && pathname === "/api/skills/manifest") {
      const { readManifest } = await import("../cli/skills.js");
      return json(res, readManifest());
    }

    // POST /api/skills/install — install a skill from skills.sh
    if (method === "POST" && pathname === "/api/skills/install") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const source = body.source;
      if (!source) return badRequest(res, "source is required");
      try {
        const {
          snapshotDirs, diffSnapshots, copySkillToInstance,
          upsertManifest, extractSkillName, findExistingSkill,
        } = await import("../cli/skills.js");
        const { execFileSync } = await import("node:child_process");

        const before = snapshotDirs();
        execFileSync("npx", ["skills", "add", String(source), "-g", "-y"], {
          encoding: "utf-8",
          timeout: 60000,
        });
        const after = snapshotDirs();
        const newDirs = diffSnapshots(before, after);

        let skillName: string;
        if (newDirs.length > 0) {
          const installed = newDirs[0];
          skillName = installed.name;
          copySkillToInstance(installed.name, path.join(installed.dir, installed.name));
        } else {
          skillName = extractSkillName(source);
          const existing = findExistingSkill(skillName);
          if (existing) {
            copySkillToInstance(existing.name, existing.dir);
          } else {
            return serverError(res, "Skill installed globally but could not locate the directory");
          }
        }
        upsertManifest(skillName, source);
        return json(res, { status: "installed", name: skillName });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return serverError(res, msg);
      }
    }

    // GET /api/skills
    if (method === "GET" && pathname === "/api/skills") {
      if (!fs.existsSync(SKILLS_DIR)) return json(res, []);
      const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
      const skills = entries.filter((e) => e.isDirectory()).map((e) => {
        const skillMdPath = path.join(SKILLS_DIR, e.name, "SKILL.md");
        let description = "";
        if (fs.existsSync(skillMdPath)) {
          const content = fs.readFileSync(skillMdPath, "utf-8");
          // Extract description from YAML frontmatter, ## Trigger section, or first paragraph
          const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (frontmatterMatch) {
            const descMatch = frontmatterMatch[1].match(/^description:\s*(.+)$/m);
            if (descMatch) {
              description = descMatch[1].trim();
            }
          }
          if (!description) {
            const triggerMatch = content.match(/##\s*Trigger\s*\n+([^\n#]+)/);
            if (triggerMatch) {
              description = triggerMatch[1].trim();
            } else {
              // Use first non-heading, non-empty, non-frontmatter line
              const bodyContent = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;
              const lines = bodyContent.split("\n");
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith("#")) {
                  description = trimmed;
                  break;
                }
              }
            }
          }
        }
        return { name: e.name, description };
      });
      return json(res, skills);
    }

    // GET /api/skills/:name
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "GET" && params) {
      const skillMd = path.join(SKILLS_DIR, params.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) return notFound(res);
      const content = fs.readFileSync(skillMd, "utf-8");
      return json(res, { name: params.name, content });
    }

    // DELETE /api/skills/:name — remove a skill
    params = matchRoute("/api/skills/:name", pathname);
    if (method === "DELETE" && params) {
      const skillDir = path.join(SKILLS_DIR, params.name);
      if (!fs.existsSync(skillDir)) return notFound(res);
      fs.rmSync(skillDir, { recursive: true, force: true });
      const { removeFromManifest } = await import("../cli/skills.js");
      removeFromManifest(params.name);
      logger.info(`Skill removed via API: ${params.name}`);
      return json(res, { status: "removed", name: params.name });
    }

    // GET /api/config
    if (method === "GET" && pathname === "/api/config") {
      const config = context.getConfig();
      // Sanitize: remove any secrets/tokens from connectors
      const rawConnectors = config.connectors || {};
      const sanitizedConnectors: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawConnectors)) {
        if (k === "instances" && Array.isArray(v)) {
          sanitizedConnectors.instances = v.map((inst: any) => ({
            ...inst,
            token: inst?.token ? "***" : undefined,
            signingSecret: inst?.signingSecret ? "***" : undefined,
            botToken: inst?.botToken ? "***" : undefined,
            appToken: inst?.appToken ? "***" : undefined,
          }));
        } else if (v && typeof v === "object") {
          sanitizedConnectors[k] = {
            ...v,
            token: (v as any)?.token ? "***" : undefined,
            signingSecret: (v as any)?.signingSecret ? "***" : undefined,
            botToken: (v as any)?.botToken ? "***" : undefined,
            appToken: (v as any)?.appToken ? "***" : undefined,
          };
        } else {
          sanitizedConnectors[k] = v;
        }
      }
      const sanitized = {
        ...config,
        connectors: sanitizedConnectors,
      };
      return json(res, sanitized);
    }

    // PUT /api/config
    if (method === "PUT" && pathname === "/api/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      // Basic validation: must be a plain object
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return badRequest(res, "Config must be a JSON object");
      }
      // Validate known top-level keys
      // Keep this aligned with `JinnConfig` in src/shared/types.ts
      const KNOWN_KEYS = [
        "jinn",
        "gateway",
        "engines",
        "models",
        "connectors",
        "logging",
        "mcp",
        "sessions",
        "cron",
        "workflows",
        "notifications",
        "portal",
        "context",
        "stt",
        "skills",
        "remotes",
      ];
      const unknownKeys = Object.keys(body).filter((k) => !KNOWN_KEYS.includes(k));
      if (unknownKeys.length > 0) {
        return badRequest(res, `Unknown config keys: ${unknownKeys.join(", ")}`);
      }
      // Validate critical field types
      if (body.gateway !== undefined) {
        if (typeof body.gateway !== "object" || Array.isArray(body.gateway)) {
          return badRequest(res, "gateway must be an object");
        }
        if (body.gateway.port !== undefined && typeof body.gateway.port !== "number") {
          return badRequest(res, "gateway.port must be a number");
        }
      }
      if (body.engines !== undefined && (typeof body.engines !== "object" || Array.isArray(body.engines))) {
        return badRequest(res, "engines must be an object");
      }
      // Every read→merge→write→reload of config.yaml runs under one lock, so a
      // concurrent writer (another PUT, the onboarding Slack connect and its
      // rollback) can never interleave with — or be overwritten by — this one.
      return withConfigLock(async () => {
      // Deep-merge incoming config with existing config to preserve
      // fields not included in the update (e.g. connector tokens).
      let existing: Record<string, unknown> = {};
      try {
        existing = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown> || {};
      } catch { /* start fresh if unreadable */ }
      const merged = deepMerge(existing, body);
      const yamlStr = yaml.dump(merged);

      // Compare AGAINST THE MERGED config, not the request body — partial
      // updates (e.g. saving only "portal.portalName") leave body.connectors
      // undefined, which would falsely look like the connectors block was
      // wiped. Use the deep-merged result so we only reload when the
      // effective on-disk values actually changed.
      //
      // We also reload connectors when portal.portalName / portal.operatorName
      // change, because SlackConnector captures those at construction and
      // would otherwise keep displaying the old portal name in triage prompts
      // until a daemon restart.
      const portalSliceChanged = (() => {
        const prev = (existing as { portal?: Record<string, unknown> }).portal ?? {};
        const next = (merged as { portal?: Record<string, unknown> }).portal ?? {};
        return prev.portalName !== next.portalName || prev.operatorName !== next.operatorName;
      })();
      const connectorsChanged =
        JSON.stringify(existing.connectors ?? null) !==
          JSON.stringify((merged as Record<string, unknown>).connectors ?? null) ||
        portalSliceChanged;

      // Tell the watcher to skip its connector-reload reaction for the file
      // write we're about to do — we'll handle the reload ourselves below
      // so the user's "Save" feels instant. Without this, the watcher would
      // fire ~500ms later and start a redundant disconnect/reconnect cycle.
      if (connectorsChanged) {
        context.suppressNextConnectorReload?.();
      }

      fs.writeFileSync(CONFIG_PATH, yamlStr);
      invalidateModelRegistry(); // models/engines may have changed — rebuild on next read
      _resetEngineProbeCache(); // engine bins may have changed — the onboarding probe must re-run
      logger.info("Config updated via API");

      if (connectorsChanged && context.reloadAllConnectors) {
        try {
          const reload = await context.reloadAllConnectors();
          // reloadAllConnectors() already updated currentConfig + sessionManager
          // internally. Make sure apiContext.config (returned by GET /api/config)
          // reflects the on-disk merge too — without this, the GET handler
          // would return the previous snapshot until the (suppressed) watcher
          // event fires.
          context.config = context.getConfig();
          context.emit("connectors:reloaded", reload);
          // reloadAllConnectors() collects per-connector start/stop failures
          // into reload.errors instead of throwing. Surface them clearly so
          // the UI doesn't show a misleading "Settings saved" toast when
          // the new Slack token actually failed to authenticate.
          const status = reload.errors.length > 0 ? "partial" : "ok";
          if (status === "partial") {
            logger.warn(
              `Config saved but ${reload.errors.length} connector(s) failed to (re)start: ${reload.errors.join(" | ")}`,
            );
            // Allow the chokidar event for the file we just wrote to fire
            // a second reload attempt — useful for transient failures
            // (network blip during Slack reconnect, brief Discord gateway
            // outage, etc.). For permanent failures (bad token), the second
            // attempt will fail the same way; no harm done.
            context.clearSuppressNextConnectorReload?.();
          }
          return json(res, { status, connectorsReload: reload });
        } catch (err) {
          // Eager reload failed. Re-arm the watcher so the chokidar event
          // for the file we just wrote is NOT suppressed — it's now our only
          // chance to retry connector reload before the next external edit
          // or manual /api/connectors/reload. (suppressNextConnectorReload
          // was armed above; clearing it via a fresh suppress with 0 effect
          // isn't possible, so we expose a clear() instead via the API.)
          context.clearSuppressNextConnectorReload?.();
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Eager connector reload after config save failed: ${message}`);
          return json(res, { status: "ok", connectorsReloadError: message });
        }
      }

      return json(res, { status: "ok" });
      });
    }

    // GET /api/logs
    if (method === "GET" && pathname === "/api/logs") {
      const logFile = path.join(LOGS_DIR, "gateway.log");
      if (!fs.existsSync(logFile)) return json(res, { lines: [] });
      const n = parseInt(url.searchParams.get("n") || "100", 10);
      // Read only the last 64KB to avoid loading the entire file into memory
      const MAX_BYTES = 64 * 1024;
      const stat = fs.statSync(logFile);
      const readSize = Math.min(stat.size, MAX_BYTES);
      const fd = fs.openSync(logFile, "r");
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);
      const allLines = buf.toString("utf-8").split("\n").filter(Boolean);
      const lines = allLines.slice(-n);
      return json(res, { lines });
    }

    // POST /api/connectors/reload — restart ALL connectors (top-level + instances)
    // from the on-disk config. Falls back to instance-only reload if the gateway
    // wasn't built with reloadAllConnectors (older daemon mid-upgrade).
    if (method === "POST" && pathname === "/api/connectors/reload") {
      const reload = context.reloadAllConnectors ?? context.reloadConnectorInstances;
      if (!reload) {
        return json(res, { error: "Connector reload not available" }, 501);
      }
      try {
        const result = await reload();
        context.emit("connectors:reloaded", result);
        return json(res, result);
      } catch (err) {
        return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    // POST /api/connectors/:id/incoming — receive proxied Discord messages from primary instance
    // Supports both the legacy /api/connectors/discord/incoming and named instance ids
    params = matchRoute("/api/connectors/:id/incoming", pathname);
    if (method === "POST" && params && params.id) {
      // Try the exact instance id first, then fall back to "discord" for the legacy path
      const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
      if (!connector) return notFound(res);
      if (!("deliverMessage" in connector)) {
        return json(res, { error: "Discord connector is not in remote mode" }, 400);
      }

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      // Download attachments from Discord CDN URLs to local temp
      const { downloadAttachment } = await import("../connectors/discord/format.js");
      const { sanitizeIncomingDiscordMeta } = await import("../connectors/discord/remote.js");
      const attachments = await Promise.all(
        (body.attachments || []).map(async (att: { name: string; url: string; mimeType: string }) => {
          if (att.url) {
            try {
              const localPath = await downloadAttachment(att.url, TMP_DIR, att.name);
              return { name: att.name, url: att.url, mimeType: att.mimeType, localPath };
            } catch {
              return { name: att.name, url: att.url, mimeType: att.mimeType };
            }
          }
          return att;
        }),
      );

      const incomingMsg: IncomingMessage = {
        connector: params.id,
        source: "discord",
        sessionKey: body.sessionKey,
        channel: body.channel,
        thread: body.thread,
        user: body.user,
        userId: body.userId,
        text: body.text,
        messageId: body.messageId,
        attachments,
        replyContext: body.replyContext || {},
        // Boundary scrub: this endpoint carries Discord traffic — drop
        // cross-platform identity fields a forged payload might smuggle in.
        transportMeta: sanitizeIncomingDiscordMeta(body.transportMeta) as IncomingMessage["transportMeta"],
        raw: body,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (connector as any).deliverMessage(incomingMsg);
      return json(res, { status: "delivered" });
    }

    // POST /api/connectors/:id/proxy — proxy connector operations from remote instances
    // Supports both the legacy /api/connectors/discord/proxy and named instance ids
    params = matchRoute("/api/connectors/:id/proxy", pathname);
    if (method === "POST" && params && params.id) {
      const connector = context.connectors.get(params.id) ?? (params.id === "discord" ? context.connectors.get("discord") : undefined);
      if (!connector) return notFound(res);

      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;

      const action = body.action as string;
      const target = body.target as Target | undefined;
      let messageId: string | undefined;

      switch (action) {
        case "sendMessage": {
          if (!target || !body.text) return badRequest(res, "target and text are required");
          // Same contract as /send: an explicit thread on the target means a
          // thread reply. Connectors' sendMessage historically dropped
          // target.thread, landing "thread replies" bare in the channel (#6).
          const proxyThread = explicitThread(target.thread);
          messageId = proxyThread
            ? ((await connector.replyMessage({ ...target, thread: proxyThread }, body.text)) as string | undefined)
            : ((await connector.sendMessage(target, body.text)) as string | undefined);
          break;
        }
        case "replyMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          messageId = (await connector.replyMessage(target, body.text)) as string | undefined;
          break;
        case "editMessage":
          if (!target || !body.text) return badRequest(res, "target and text are required");
          await connector.editMessage(target, body.text);
          break;
        case "addReaction":
          if (!target || !body.emoji) return badRequest(res, "target and emoji are required");
          await connector.addReaction(target, body.emoji);
          break;
        case "removeReaction":
          if (!target || !body.emoji) return badRequest(res, "target and emoji are required");
          await connector.removeReaction(target, body.emoji);
          break;
        case "setTypingStatus":
          if (connector.setTypingStatus) {
            await connector.setTypingStatus(body.channelId ?? "", body.threadTs, body.status ?? "");
          }
          break;
        default:
          return badRequest(res, `Unknown proxy action: ${action}`);
      }

      return json(res, { status: "ok", messageId });
    }

    // POST /api/connectors/:name/send — send a message via a connector
    params = matchRoute("/api/connectors/:name/send", pathname);
    if (method === "POST" && params) {
      const connector = context.connectors.get(params.name);
      if (!connector) return notFound(res);
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      if (!body.channel || !body.text) return badRequest(res, "channel and text are required");
      const thread = explicitThread(body.thread);
      const target = { channel: body.channel, thread };
      if (thread) {
        await connector.replyMessage(target, body.text);
      } else {
        await connector.sendMessage(target, body.text);
      }
      return json(res, { status: "sent" });
    }

    // GET /api/connectors/whatsapp/qr — return current QR code as PNG data URL
    if (method === "GET" && pathname === "/api/connectors/whatsapp/qr") {
      const waConnector = context.connectors.get("whatsapp");
      if (!waConnector) return notFound(res);
      const qrString = (waConnector as WhatsAppConnector).getQrCode();
      if (!qrString) return json(res, { qr: null });
      const dataUrl = await QRCode.toDataURL(qrString, { width: 256, margin: 2 });
      return json(res, { qr: dataUrl });
    }

    // GET /api/connectors/slack/channels — channels the bot is a member of.
    // Used by the settings UI to populate the Agents View canvas channel picker.
    if (method === "GET" && pathname === "/api/connectors/slack/channels") {
      const slackConnector = context.connectors.get("slack");
      if (!slackConnector) {
        return json(res, { ok: false, error: "slack_not_configured" }, 400);
      }
      const lister = (slackConnector as unknown as { listChannels?: () => Promise<Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean }>> }).listChannels;
      if (typeof lister !== "function") {
        return json(res, { ok: false, error: "list_channels_unsupported" }, 400);
      }
      try {
        const channels = await lister.call(slackConnector);
        return json(res, { ok: true, channels });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json(res, { ok: false, error: msg }, 502);
      }
    }

    // GET /api/connectors — list available connectors
    if (method === "GET" && pathname === "/api/connectors") {
      const connectors = Array.from(context.connectors.entries()).map(([instanceId, connector]) => ({
        name: connector.name,
        instanceId,
        employee: connector.getEmployee?.() ?? undefined,
        ...connector.getHealth(),
      }));
      return json(res, connectors);
    }

    // GET /api/activity — recent activity derived from sessions
    if (method === "GET" && pathname === "/api/activity") {
      const sessions = listSessions();
      const events: Array<{ event: string; payload: unknown; ts: number }> = [];
      for (const s of sessions) {
        const ts = new Date(s.lastActivity || s.createdAt).getTime();
        const transportState = context.sessionManager.getQueue().getTransportState(s.sessionKey || s.sourceRef, s.status);
        if (transportState === "running") {
          events.push({ event: "session:started", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "queued") {
          events.push({ event: "session:queued", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "idle") {
          events.push({ event: "session:completed", payload: { sessionId: s.id, employee: s.employee, engine: s.engine, connector: s.connector }, ts });
        } else if (transportState === "error") {
          events.push({ event: "session:error", payload: { sessionId: s.id, employee: s.employee, error: s.lastError, connector: s.connector }, ts });
        }
      }
      events.sort((a, b) => b.ts - a.ts);
      return json(res, events.slice(0, 30));
    }

    // GET /api/onboarding — check if onboarding is needed
    if (method === "GET" && pathname === "/api/onboarding") {
      const sessions = listSessions();
      const hasEmployees = fs.existsSync(ORG_DIR) &&
        fs.readdirSync(ORG_DIR, { recursive: true }).some(
          (f) => String(f).endsWith(".yaml") && !String(f).endsWith("department.yaml")
        );
      const config = context.getConfig();
      const onboarded = config.portal?.onboarded === true;
      return json(res, {
        needed: !onboarded && sessions.length === 0 && !hasEmployees,
        onboarded,
        sessionsCount: sessions.length,
        hasEmployees,
        portalName: config.portal?.portalName ?? null,
        operatorName: config.portal?.operatorName ?? null,
      });
    }

    // POST /api/onboarding — persist portal personalization
    if (method === "POST" && pathname === "/api/onboarding") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const { portalName, operatorName, language } = body;

      // Read current config and merge portal settings. Empty strings are
      // treated as "not provided" — deleting the key would silently revert
      // the portal to its defaults.
      const config = context.getConfig();
      const provided = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
      const portalPatch: Record<string, unknown> = {
        ...config.portal,
        onboarded: true,
        ...(provided(portalName) && { portalName }),
        ...(provided(operatorName) && { operatorName }),
        ...(provided(language) && { language }),
      };
      const updated = { ...config, portal: portalPatch };

      // Patch only the portal block — a whole-file yaml.dump would strip
      // every comment the shipped config template carries.
      const rawConfig = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf-8") : "";
      writeFileAtomic(CONFIG_PATH, patchPortalSection(rawConfig, portalPatch));
      logger.info(`Onboarding: portal name="${portalName}", operator="${operatorName}", language="${language}"`);

      const effectiveName = resolveEffectiveName(portalName, config.portal?.portalName);
      const languageSection = language && language !== "English"
        ? `\n\n## Language\nAlways respond in ${language}. All communication with the user must be in ${language}.`
        : "";

      // Update CLAUDE.md / AGENTS.md: language section always; the name only
      // when this request actually carries one (a language-only update must
      // not rename a customized assistant back to the default).
      for (const filename of ["CLAUDE.md", "AGENTS.md"]) {
        const mdPath = path.join(JINN_HOME, filename);
        if (!fs.existsSync(mdPath)) continue;
        let md = fs.readFileSync(mdPath, "utf-8");
        if (provided(portalName)) {
          md = personalizeInstructionMd(md, effectiveName);
        }
        // Remove existing language section if present, then add new one if needed
        md = md.replace(/\n\n## Language\nAlways respond in .+\. All communication with the user must be in .+\./m, "");
        if (languageSection) {
          md = md.trimEnd() + languageSection + "\n";
        }
        writeFileAtomic(mdPath, md);
      }

      // Keep the persona file's Name section in sync
      const identityMdPath = path.join(JINN_HOME, "IDENTITY.md");
      if (provided(portalName) && fs.existsSync(identityMdPath)) {
        writeFileAtomic(
          identityMdPath,
          personalizeIdentityMd(fs.readFileSync(identityMdPath, "utf-8"), effectiveName),
        );
      }

      context.emit("config:updated", { portal: updated.portal });
      return json(res, { status: "ok", portal: updated.portal });
    }

    // ── STT (Speech-to-Text) ──────────────────────────────────
    if (method === "GET" && pathname === "/api/stt/status") {
      const config = context.getConfig();
      const languages = resolveLanguages(config.stt);
      const status = getSttStatus(config.stt?.model, languages);
      return json(res, status);
    }

    if (method === "POST" && pathname === "/api/stt/download") {
      const config = context.getConfig();
      const model = config.stt?.model || "small";

      downloadModel(model, (progress) => {
        context.emit("stt:download:progress", { progress });
      }).then(() => {
        // Update config to mark STT as enabled
        try {
          const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
          const cfg = yaml.load(raw) as Record<string, unknown>;
          if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
          const sttCfg = cfg.stt as Record<string, unknown>;
          sttCfg.enabled = true;
          sttCfg.model = model;
          if (!sttCfg.languages) sttCfg.languages = ["en"];
          fs.writeFileSync(CONFIG_PATH, yaml.dump(cfg, { lineWidth: -1 }));
        } catch (err) {
          logger.error(`Failed to update config after STT download: ${err}`);
        }
        context.emit("stt:download:complete", { model });
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`STT download failed: ${msg}`);
        context.emit("stt:download:error", { error: msg });
      });

      return json(res, { status: "downloading", model });
    }

    if (method === "POST" && pathname === "/api/stt/transcribe") {
      const config = context.getConfig();
      const model = config.stt?.model || "small";
      const languages = resolveLanguages(config.stt);
      // Accept language from query param, fall back to first configured language
      const requestedLang = url.searchParams.get("language");
      const language = requestedLang && languages.includes(requestedLang) ? requestedLang : languages[0];

      const audioBuffer = await readBodyRaw(req);
      if (audioBuffer.length === 0) return badRequest(res, "No audio data");
      if (audioBuffer.length > 100 * 1024 * 1024) return badRequest(res, "Audio too large (100MB max)");

      const contentType = req.headers["content-type"] || "audio/webm";
      const ext = contentType.includes("wav") ? ".wav"
        : contentType.includes("mp4") || contentType.includes("m4a") ? ".m4a"
        : contentType.includes("ogg") ? ".ogg"
        : ".webm";

      const tmpFile = path.join(TMP_DIR, `stt-${crypto.randomUUID()}${ext}`);
      fs.mkdirSync(TMP_DIR, { recursive: true });
      fs.writeFileSync(tmpFile, audioBuffer);

      try {
        const text = await sttTranscribe(tmpFile, model, language);
        return json(res, { text });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`STT transcription failed: ${msg}`);
        return serverError(res, `Transcription failed: ${msg}`);
      } finally {
        try { fs.unlinkSync(tmpFile); } catch {}
      }
    }

    if (method === "PUT" && pathname === "/api/stt/config") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = _parsed.body as any;
      const langs = body.languages;

      if (!Array.isArray(langs) || langs.length === 0) {
        return badRequest(res, "languages must be a non-empty array");
      }

      const invalid = langs.filter((l) => typeof l !== "string" || !WHISPER_LANGUAGES[l]);
      if (invalid.length > 0) {
        return badRequest(res, `Invalid language codes: ${invalid.join(", ")}`);
      }

      try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const cfg = yaml.load(raw) as Record<string, unknown>;
        if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
        const sttCfg = cfg.stt as Record<string, unknown>;
        sttCfg.languages = langs;
        // Remove deprecated language field if present
        delete sttCfg.language;
        fs.writeFileSync(CONFIG_PATH, yaml.dump(cfg, { lineWidth: -1 }));
        return json(res, { status: "ok", languages: langs });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return serverError(res, `Failed to update STT config: ${msg}`);
      }
    }

    // /api/files — file upload/download/management
    if (pathname.startsWith("/api/files")) {
      const handled = await handleFilesRequest(req, res, pathname, method, context);
      if (handled) return;
    }

    // ── Goals ────────────────────────────────────────────────────────
    // GET /api/goals
    if (method === "GET" && pathname === "/api/goals") {
      const { listGoals } = await import("./goals.js");
      const db = initDb();
      return json(res, listGoals(db));
    }

    // GET /api/goals/tree
    if (method === "GET" && pathname === "/api/goals/tree") {
      const { getGoalTree } = await import("./goals.js");
      const db = initDb();
      return json(res, getGoalTree(db));
    }

    // POST /api/goals
    if (method === "POST" && pathname === "/api/goals") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const { createGoal } = await import("./goals.js");
      const db = initDb();
      const goal = createGoal(db, _parsed.body as Record<string, unknown>);
      return json(res, goal, 201);
    }

    // GET /api/goals/:id
    params = matchRoute("/api/goals/:id", pathname);
    if (method === "GET" && params) {
      const { getGoal } = await import("./goals.js");
      const db = initDb();
      const goal = getGoal(db, params.id);
      if (!goal) return notFound(res);
      return json(res, goal);
    }

    // PUT /api/goals/:id
    params = matchRoute("/api/goals/:id", pathname);
    if (method === "PUT" && params) {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const { updateGoal } = await import("./goals.js");
      const db = initDb();
      const goal = updateGoal(db, params.id, _parsed.body as Record<string, unknown>);
      if (!goal) return notFound(res);
      return json(res, goal);
    }

    // DELETE /api/goals/:id
    params = matchRoute("/api/goals/:id", pathname);
    if (method === "DELETE" && params) {
      const { deleteGoal } = await import("./goals.js");
      const db = initDb();
      deleteGoal(db, params.id);
      return json(res, { status: "ok" });
    }

    // ── Costs ────────────────────────────────────────────────────────
    // GET /api/costs/summary
    if (method === "GET" && pathname === "/api/costs/summary") {
      const { getCostSummary } = await import("./costs.js");
      const rawPeriod = url.searchParams.get("period") ?? "month";
      const period = (rawPeriod === "day" || rawPeriod === "week" || rawPeriod === "month") ? rawPeriod : "month";
      return json(res, getCostSummary(period));
    }

    // GET /api/costs/by-employee
    if (method === "GET" && pathname === "/api/costs/by-employee") {
      const { getCostsByEmployee } = await import("./costs.js");
      const rawPeriod = url.searchParams.get("period") ?? "month";
      const period = (rawPeriod === "week") ? "week" : "month";
      return json(res, getCostsByEmployee(period));
    }

    // ── Budgets ──────────────────────────────────────────────────────
    // GET /api/budgets
    if (method === "GET" && pathname === "/api/budgets") {
      const { getBudgetStatus } = await import("./budgets.js");
      const config = context.getConfig();
      const budgetConfig = (config as any).budgets?.employees as Record<string, number> | undefined ?? {};
      const employees = Object.keys(budgetConfig);
      const statuses = employees.map((emp) => ({
        employee: emp,
        ...getBudgetStatus(emp, budgetConfig),
      }));
      return json(res, { employees: budgetConfig, statuses });
    }

    // PUT /api/budgets
    if (method === "PUT" && pathname === "/api/budgets") {
      const _parsed = await readJsonBody(req, res);
      if (!_parsed.ok) return;
      const body = _parsed.body as Record<string, unknown>;
      let existing: Record<string, unknown> = {};
      try {
        existing = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown> || {};
      } catch { /* start fresh if unreadable */ }
      const merged = deepMerge(existing, { budgets: { employees: body } });
      fs.writeFileSync(CONFIG_PATH, yaml.dump(merged));
      logger.info("Budget limits updated via API");
      return json(res, { status: "ok" });
    }

    // POST /api/budgets/:employee/override
    params = matchRoute("/api/budgets/:employee/override", pathname);
    if (method === "POST" && params) {
      const { overrideBudget } = await import("./budgets.js");
      const config = context.getConfig();
      const budgetConfig = (config as any).budgets?.employees as Record<string, number> | undefined ?? {};
      return json(res, overrideBudget(params.employee, budgetConfig));
    }

    // GET /api/budgets/events
    if (method === "GET" && pathname === "/api/budgets/events") {
      const { getBudgetEvents } = await import("./budgets.js");
      return json(res, getBudgetEvents());
    }

    return notFound(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`API error: ${msg}`);
    if (msg.startsWith("Insufficient disk space")) return json(res, { error: msg }, 507);
    return serverError(res, msg);
  }
}

/**
 * Parse the output of `npx skills find <query>` into structured results.
 *
 * Format:
 * ```
 * owner/repo@skill-name  <N> installs
 * └ https://skills.sh/owner/repo/skill-name
 * ```
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function parseSkillsSearchOutput(
  output: string,
): Array<{ name: string; source: string; url: string; installs: number }> {
  const results: Array<{ name: string; source: string; url: string; installs: number }> = [];
  const lines = output.trim().split("\n");

  for (let i = 0; i < lines.length; i++) {
    const headerLine = stripAnsi(lines[i]).trim();
    // Match "owner/repo@skill-name  <N> installs"
    const headerMatch = headerLine.match(/^(\S+)\s+(\d+)\s+installs?$/);
    if (!headerMatch) continue;

    const source = headerMatch[1];
    const installs = parseInt(headerMatch[2], 10);
    const atIdx = source.lastIndexOf("@");
    const name = atIdx > 0 ? source.slice(atIdx + 1) : source;

    // Next line should be the URL
    let url = "";
    if (i + 1 < lines.length) {
      const urlLine = stripAnsi(lines[i + 1]).trim();
      const urlMatch = urlLine.match(/[└]\s*(https?:\/\/\S+)/);
      if (urlMatch) {
        url = urlMatch[1];
        i++; // consume the URL line
      }
    }

    results.push({ name, source, url, installs });
  }
  return results;
}

/**
 * Load messages from a Claude Code JSONL transcript file.
 * Used as a fallback when the messages DB is empty (pre-existing sessions).
 */
interface TranscriptContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  id?: string;
}

interface TranscriptEntry {
  role: "user" | "assistant" | "system";
  content: TranscriptContentBlock[];
}

function loadRawTranscript(engineSessionId: string): TranscriptEntry[] {
  const claudeProjectsDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".claude",
    "projects",
  );
  if (!fs.existsSync(claudeProjectsDir)) return [];

  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(claudeProjectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    const entries: TranscriptEntry[] = [];
    const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const type = obj.type;
        if (type !== "user" && type !== "assistant") continue;
        const msg = obj.message;
        if (!msg) continue;

        const rawContent = msg.content;
        const blocks: TranscriptContentBlock[] = [];

        if (typeof rawContent === "string") {
          if (rawContent.trim()) blocks.push({ type: "text", text: rawContent });
        } else if (Array.isArray(rawContent)) {
          for (const block of rawContent) {
            if (!block || typeof block !== "object") continue;
            const b = block as Record<string, unknown>;
            const blockType = String(b.type || "");
            if (blockType === "text") {
              blocks.push({ type: "text", text: String(b.text || "") });
            } else if (blockType === "tool_use") {
              blocks.push({
                type: "tool_use",
                name: String(b.name || ""),
                input: (b.input as Record<string, unknown>) || {},
              });
            } else if (blockType === "tool_result") {
              const resultContent = b.content;
              let resultText: string;
              if (typeof resultContent === "string") {
                resultText = resultContent;
              } else if (Array.isArray(resultContent)) {
                resultText = (resultContent as Record<string, unknown>[])
                  .filter((rc) => rc.type === "text")
                  .map((rc) => String(rc.text || ""))
                  .join("");
              } else {
                resultText = "";
              }
              blocks.push({ type: "tool_result", text: resultText });
            } else if (blockType === "thinking") {
              blocks.push({ type: "thinking", text: String(b.thinking || b.text || "") });
            }
          }
        }

        if (blocks.length > 0) {
          entries.push({ role: type as "user" | "assistant", content: blocks });
        }
      } catch {
        continue;
      }
    }
    return entries;
  }
  return [];
}

function loadTranscriptMessages(engineSessionId: string): Array<{ role: string; content: string }> {
  // Claude Code stores transcripts in ~/.claude/projects/<project-key>/<sessionId>.jsonl
  const claudeProjectsDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".claude",
    "projects",
  );
  if (!fs.existsSync(claudeProjectsDir)) return [];

  // Search all project dirs for the transcript
  const projectDirs = fs.readdirSync(claudeProjectsDir, { withFileTypes: true });
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const jsonlPath = path.join(claudeProjectsDir, dir.name, `${engineSessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) continue;

    const messages: Array<{ role: string; content: string }> = [];
    const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const type = obj.type;
        if (type !== "user" && type !== "assistant") continue;
        const msg = obj.message;
        if (!msg) continue;

        let content = msg.content;
        if (Array.isArray(content)) {
          content = content
            .filter((b: Record<string, unknown>) => b.type === "text")
            .map((b: Record<string, unknown>) => b.text)
            .join("");
        }
        if (typeof content === "string" && content.trim()) {
          messages.push({ role: type, content: content.trim() });
        }
      } catch {
        continue;
      }
    }
    return messages;
  }
  return [];
}

async function runWebSession(
  session: Session,
  prompt: string,
  engine: Engine,
  config: JinnConfig,
  context: ApiContext,
  attachments?: string[],
  /** Deliver the final answer to the session's origin connector (Slack thread
   *  etc.). Set for notification-triggered wake-ups: this run path has no
   *  connector of its own, so without explicit delivery a woken Slack session
   *  would compute its reply and post it nowhere (issue #38 follow-up). */
  deliverToConnector?: boolean,
): Promise<void> {
  const currentSession = getSession(session.id);
  if (!currentSession) {
    logger.info(`Skipping deleted web session ${session.id} before run start`);
    return;
  }
  logger.info(`Web session ${currentSession.id} running engine "${currentSession.engine}" (model: ${currentSession.model || "default"})`);

  // Ensure status is "running" (may already be set by the POST handler)
  const currentStatus = getSession(currentSession.id);
  if (currentStatus && currentStatus.status !== "running") {
    updateSession(currentSession.id, {
      status: "running",
      lastActivity: new Date().toISOString(),
    });
  }

  // If this session has an assigned employee, load their persona
  let employee: import("../shared/types.js").Employee | undefined;
  if (currentSession.employee) {
    const { findEmployee } = await import("./org.js");
    const { scanOrg } = await import("./org.js");
    const registry = scanOrg();
    employee = findEmployee(currentSession.employee, registry);
  }

  const { scanOrg: scanOrgForHierarchy } = await import("./org.js");
  const { resolveOrgHierarchy } = await import("./org-hierarchy.js");
  const orgHierarchy = resolveOrgHierarchy(scanOrgForHierarchy());

  try {

    const systemPrompt = buildContext({
      // Preserve the session's true origin — labeling everything "web" here
      // would grant web-level trust (MEMORY injection) to Slack/cron-origin
      // sessions driven through this runner.
      source: currentSession.source || "web",
      channel: currentSession.sourceRef,
      user: "web-user",
      employee,
      connectors: Array.from(context.connectors.keys()),
      config,
      sessionId: currentSession.id,
      // Interactive PTY survives across turns; everything else is a one-shot
      // process whose background tasks die at turn end (#38).
      processLifetime:
        currentSession.engine === "claude" &&
        config.engines.claude?.interactive === true &&
        !employee?.sshHost
          ? "persistent"
          : "one-shot",
      hierarchy: orgHierarchy,
    });

    const engineConfig = currentSession.engine === "codex"
      ? config.engines.codex
      : currentSession.engine === "gemini"
        ? config.engines.gemini ?? config.engines.claude
        : config.engines.claude;
    const effortLevel = resolveEffort(
      engineConfig,
      currentSession,
      employee,
      effortLevelsForModel(config, currentSession.engine, currentSession.model ?? engineConfig.model),
    );

    let lastHeartbeatAt = 0;
    const runHeartbeat = setInterval(() => {
      updateSession(currentSession.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
    }, 5000);

    const syncSinceIso = (currentSession.transportMeta as any)?.claudeSyncSince;
    const syncSinceMs = typeof syncSinceIso === "string" ? new Date(syncSinceIso).getTime() : NaN;
    const syncRequested = currentSession.engine === "claude" && typeof syncSinceIso === "string" && Number.isFinite(syncSinceMs);
    const promptToRun = syncRequested
      ? (() => {
        const sinceMessages = getMessages(currentSession.id)
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp >= syncSinceMs)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        return `We temporarily switched to GPT due to a Claude usage limit. Sync your context with this transcript (most recent last), then respond to the last USER message.\n\n${transcript}`;
      })()
      : prompt;

    const result = await engine.run({
      prompt: promptToRun,
      resumeSessionId: currentSession.engineSessionId ?? undefined,
      systemPrompt,
      cwd: JINN_HOME,
      bin: engineConfig.bin,
      model: currentSession.model ?? engineConfig.model,
      effortLevel,
      cliFlags: employee?.cliFlags,
      sshHost: employee?.sshHost,
      remoteCwd: employee?.remoteCwd,
      attachments: attachments?.length ? attachments : undefined,
      sessionId: currentSession.id,
      onStream: (delta) => {
        const now = Date.now();
        if (now - lastHeartbeatAt >= 2000) {
          lastHeartbeatAt = now;
          updateSession(currentSession.id, {
            status: "running",
            lastActivity: new Date(now).toISOString(),
          });
        }
        try {
          context.emit("session:delta", {
            sessionId: currentSession.id,
            type: delta.type,
            content: delta.content,
            toolName: delta.toolName,
            toolId: delta.toolId,
            subAgent: delta.subAgent,
          });
        } catch (err) {
          logger.warn(`Failed to emit stream delta for session ${currentSession.id}: ${err instanceof Error ? err.message : err}`);
        }
      },
    }).finally(() => {
      clearInterval(runHeartbeat);
    });
    if (!getSession(currentSession.id)) {
      logger.info(`Skipping completion for deleted web session ${currentSession.id}`);
      return;
    }

    const wasInterrupted = result.error?.startsWith("Interrupted");
    const rateLimit = !wasInterrupted ? detectRateLimit(result) : { limited: false as const };

    if (rateLimit.limited) {
      recordClaudeRateLimit(rateLimit.resetsAt);
      const strategy = config.sessions?.rateLimitStrategy ?? "fallback";

      // Optional fallback: switch to GPT (Codex) while Claude resets
      if (currentSession.engine === "claude" && strategy === "fallback") {
        const fallbackName = config.sessions?.fallbackEngine ?? "codex";
        const fallbackEngine = context.sessionManager.getEngine(fallbackName);
        if (fallbackEngine) {
          const { resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
          const until = resumeAt ?? new Date(Date.now() + 6 * 60 * 60_000);
          const syncSince = new Date().toISOString();

          const resumeText = resumeAt
            ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
            : null;

          const notificationText =
            `⚠️ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""}. Switching to GPT for now.`;
          insertMessage(currentSession.id, "notification", notificationText);
          context.emit("session:notification", { sessionId: currentSession.id, message: notificationText });

          const nextMeta = { ...(currentSession.transportMeta || {}) } as Record<string, unknown>;
          const engineSessionsRaw = nextMeta.engineSessions;
          const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
            ? { ...(engineSessionsRaw as Record<string, unknown>) }
            : {};
          if (currentSession.engineSessionId) {
            engineSessions.claude = currentSession.engineSessionId;
          }
          nextMeta.engineSessions = engineSessions;
          nextMeta.engineOverride = { originalEngine: "claude", originalEngineSessionId: currentSession.engineSessionId, until: until.toISOString(), syncSince };

          updateSession(currentSession.id, {
            engine: fallbackName,
            transportMeta: nextMeta as any,
            status: "running",
            lastActivity: new Date().toISOString(),
            lastError: resumeAt
              ? `Claude usage limit — using GPT until ${resumeAt.toISOString()}`
              : "Claude usage limit — using GPT temporarily",
          });

          notifyDiscordChannel(
            `⚠️ Claude usage limit reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} switching to GPT.`,
          );

          const fallbackConfig = config.engines.codex;
          const fallbackEffort = resolveEffort(
            fallbackConfig,
            currentSession,
            employee,
            effortLevelsForModel(config, "codex", currentSession.model ?? fallbackConfig.model),
          );
          const codexResume = typeof engineSessions.codex === "string" ? (engineSessions.codex as string) : undefined;
          const history = getMessages(currentSession.id)
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
          const historyText = history.slice(-12).join("\n\n");
          const fallbackPrompt = codexResume
            ? prompt
            : `Continue this conversation and respond to the last USER message.\n\nConversation so far:\n\n${historyText}`;
          const fallbackResult = await fallbackEngine.run({
            prompt: fallbackPrompt,
            resumeSessionId: codexResume,
            systemPrompt,
            cwd: JINN_HOME,
            bin: fallbackConfig.bin,
            model: currentSession.model ?? fallbackConfig.model,
            effortLevel: fallbackEffort,
            cliFlags: employee?.cliFlags,
            sshHost: employee?.sshHost,
            remoteCwd: employee?.remoteCwd,
            sessionId: currentSession.id,
            onStream: (delta) => {
              context.emit("session:delta", {
                sessionId: currentSession.id,
                type: delta.type,
                content: delta.content,
                toolName: delta.toolName,
                toolId: delta.toolId,
                subAgent: delta.subAgent,
              });
            },
          });
          recordTurnAccounting(currentSession.id, fallbackResult);

          if (fallbackResult.result) {
            insertMessage(currentSession.id, "assistant", fallbackResult.result);
          }

          // Persist Codex thread id so future fallbacks can resume it
          const nextEngineSessions = { ...engineSessions };
          if (fallbackResult.sessionId) {
            nextEngineSessions.codex = fallbackResult.sessionId;
          }
          const metaAfter = { ...(getSession(currentSession.id)?.transportMeta || nextMeta) } as Record<string, unknown>;
          metaAfter.engineSessions = nextEngineSessions;
          updateSession(currentSession.id, { transportMeta: metaAfter as any });

          const completedFallback = updateSession(currentSession.id, {
            engineSessionId: fallbackResult.sessionId,
            status: fallbackResult.error ? "error" : "idle",
            lastActivity: new Date().toISOString(),
            lastError: fallbackResult.error ?? null,
            ...(typeof fallbackResult.contextTokens === "number" ? { lastContextTokens: fallbackResult.contextTokens } : {}),
          });
          if (completedFallback) {
            notifyParentSession(completedFallback, { result: fallbackResult.result, error: fallbackResult.error ?? null, cost: fallbackResult.cost, durationMs: fallbackResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
            if (deliverToConnector && fallbackResult.result && !fallbackResult.error) {
              const delivery = await deliverToOriginConnector(completedFallback, fallbackResult.result, context.connectors);
              if (isUndeliveredToOrigin(delivery, completedFallback)) recordFailedOriginDelivery(completedFallback, context.emit);
            }
          }

          context.emit("session:completed", {
            sessionId: currentSession.id,
            employee: currentSession.employee || config.portal?.portalName || "Ryoko",
            title: currentSession.title,
            result: fallbackResult.result,
            error: fallbackResult.error || null,
            cost: fallbackResult.cost,
            durationMs: fallbackResult.durationMs,
          });

          return;
        }
      }

      // Otherwise: wait until reset and retry automatically
      const { delayMs, resumeAt } = computeNextRetryDelayMs(rateLimit.resetsAt);
      const deadlineMs = computeRateLimitDeadlineMs(
        rateLimit.resetsAt,
        rateLimit.resetsAt ? 30 * 60_000 : 6 * 60 * 60_000,
      );

      const resumeText = resumeAt
        ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
        : null;

      logger.info(
        `Web session ${currentSession.id} hit Claude usage limit — will auto-retry ${resumeAt ? `at ${resumeAt.toISOString()}` : `in ${Math.round(delayMs / 1000)}s`}`,
      );

      // Send hardcoded Discord notification — does not depend on the LLM
      notifyDiscordChannel(
        `⚠️ Claude usage limit reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} paused${resumeText ? ` until ${resumeText}` : ""}.`,
      );

      const notificationText =
        `⏳ Claude usage limit reached${resumeText ? `. Resets ${resumeText}` : ""} — I'll continue automatically.`;
      insertMessage(currentSession.id, "notification", notificationText);
      context.emit("session:notification", { sessionId: currentSession.id, message: notificationText });

      const waitingSession = updateSession(currentSession.id, {
        ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
        status: "waiting",
        lastActivity: new Date().toISOString(),
        lastError: resumeAt
          ? `Claude usage limit — resumes ${resumeAt.toISOString()}`
          : "Claude usage limit — waiting for reset",
      });

      // Notify parent session about rate limit (fire-and-forget)
      notifyRateLimited(
        (waitingSession ?? { ...currentSession, status: "waiting" }) as Session,
        resumeAt
          ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
          : undefined,
      );

      context.emit("session:rate-limited", {
        sessionId: currentSession.id,
        employee: currentSession.employee,
        error: result.error,
        resetsAt: rateLimit.resetsAt ?? null,
      });

      // Keep lastActivity fresh while waiting (UI / status endpoints)
      const heartbeat = setInterval(() => {
        updateSession(currentSession.id, { status: "waiting", lastActivity: new Date().toISOString() });
      }, 60_000);

      try {
        let attempt = 0;
        let nextDelayMs = delayMs;

        while (Date.now() < deadlineMs) {
          await new Promise<void>((r) => setTimeout(r, nextDelayMs));
          attempt++;

          // Check session still exists and hasn't been cancelled
          const current = getSession(currentSession.id);
          if (!current || current.status === "error") {
            logger.info(`Web session ${currentSession.id} stopped while waiting for usage reset`);
            return;
          }

          logger.info(`Web session ${currentSession.id} retrying after usage limit (attempt ${attempt})`);

          const retryResult = await engine.run({
            prompt,
            resumeSessionId: current.engineSessionId ?? undefined,
            systemPrompt,
            cwd: JINN_HOME,
            bin: engineConfig.bin,
            model: current.model ?? engineConfig.model,
            effortLevel,
            cliFlags: employee?.cliFlags,
            sshHost: employee?.sshHost,
            remoteCwd: employee?.remoteCwd,
            sessionId: currentSession.id,
            onStream: (delta) => {
              context.emit("session:delta", {
                sessionId: currentSession.id,
                type: delta.type,
                content: delta.content,
                toolName: delta.toolName,
                toolId: delta.toolId,
                subAgent: delta.subAgent,
              });
            },
          });
          const retryInterrupted = retryResult.error?.startsWith("Interrupted");
          const retryRateLimit = !retryInterrupted ? detectRateLimit(retryResult) : { limited: false as const };

          if (retryRateLimit.limited) {
            recordClaudeRateLimit(retryRateLimit.resetsAt);
            logger.info(`Web session ${currentSession.id} still rate limited (attempt ${attempt})`);

            const next = computeNextRetryDelayMs(retryRateLimit.resetsAt);
            nextDelayMs = next.delayMs;

            updateSession(currentSession.id, {
              ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
              status: "waiting",
              lastActivity: new Date().toISOString(),
              lastError: next.resumeAt
                ? `Claude usage limit — resumes ${next.resumeAt.toISOString()}`
                : "Claude usage limit — waiting for reset",
            });

            continue;
          }

          // Usage limit cleared — handle result
          recordTurnAccounting(currentSession.id, retryResult);
          if (retryResult.result) {
            insertMessage(currentSession.id, "assistant", retryResult.result);
          }

          const completedAfterRetry = updateSession(currentSession.id, {
            ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
            status: retryResult.error ? "error" : "idle",
            lastActivity: new Date().toISOString(),
            lastError: retryResult.error ?? null,
            ...(typeof retryResult.contextTokens === "number" ? { lastContextTokens: retryResult.contextTokens } : {}),
          });

          if (completedAfterRetry) {
            notifyRateLimitResumed(completedAfterRetry);
            notifyDiscordChannel(
              `✅ Claude usage limit cleared. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} resumed.`,
            );
            notifyParentSession(completedAfterRetry, { result: retryResult.result, error: retryResult.error ?? null, cost: retryResult.cost, durationMs: retryResult.durationMs }, { alwaysNotify: employee?.alwaysNotify });
            if (deliverToConnector && retryResult.result && !retryResult.error) {
              const delivery = await deliverToOriginConnector(completedAfterRetry, retryResult.result, context.connectors);
              if (isUndeliveredToOrigin(delivery, completedAfterRetry)) recordFailedOriginDelivery(completedAfterRetry, context.emit);
            }
          }

          context.emit("session:completed", {
            sessionId: currentSession.id,
            employee: currentSession.employee || config.portal?.portalName || "Ryoko",
            title: currentSession.title,
            result: retryResult.result,
            error: retryResult.error || null,
            cost: retryResult.cost,
            durationMs: retryResult.durationMs,
          });

          logger.info(`Web session ${currentSession.id} resumed after usage reset`);
          return;
        }

        // Exhausted waiting window
        notifyDiscordChannel(
          `❌ Claude usage limit did not clear in time. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} has been stopped.`,
        );
        const erroredSession = updateSession(currentSession.id, {
          status: "error",
          lastActivity: new Date().toISOString(),
          lastError: "Claude usage limit did not clear in time",
        });
        if (erroredSession) {
          notifyParentSession(erroredSession, { error: "Claude usage limit did not clear in time" }, { alwaysNotify: employee?.alwaysNotify });
        }
        context.emit("session:completed", {
          sessionId: currentSession.id,
          result: null,
          error: "Claude usage limit did not clear in time",
        });
        logger.warn(`Web session ${currentSession.id} exhausted usage limit retries`);
        return;
      } finally {
        clearInterval(heartbeat);
      }
    }

    // A turn interrupted by a newer user message is not an error — the newer
    // message is already being dispatched as its own turn. Surface a calm
    // notice instead of a red error, and let the new turn drive the UI/status.
    if (wasInterrupted) {
      const noticeText = "🔄 新しいメッセージを踏まえて再検討";
      insertMessage(currentSession.id, "notification", noticeText);
      context.emit("session:notification", { sessionId: currentSession.id, message: noticeText });
      updateSession(currentSession.id, { lastActivity: new Date().toISOString(), lastError: null });
      logger.info(`Web session ${currentSession.id} interrupted by new message — reconsidering`);
      return;
    }

    // Persist the assistant response
    if (result.result) {
      insertMessage(currentSession.id, "assistant", result.result);
    }

    recordTurnAccounting(currentSession.id, result);
    const completedSession = updateSession(currentSession.id, {
      ...(result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
      status: result.error ? "error" : "idle",
      lastActivity: new Date().toISOString(),
      lastError: result.error ?? null,
      ...(typeof result.contextTokens === "number" ? { lastContextTokens: result.contextTokens } : {}),
    });
    if (syncRequested && !rateLimit.limited && !wasInterrupted) {
      const meta = (getSession(currentSession.id)?.transportMeta || currentSession.transportMeta || {}) as Record<string, unknown>;
      if (meta && typeof meta === "object" && !Array.isArray(meta)) {
        const nextMeta = { ...meta } as Record<string, unknown>;
        delete nextMeta["claudeSyncSince"];
        updateSession(currentSession.id, { transportMeta: nextMeta as any });
      }
    }
    if (completedSession) {
      notifyParentSession(completedSession, { result: result.result, error: result.error ?? null, cost: result.cost, durationMs: result.durationMs }, { alwaysNotify: employee?.alwaysNotify });
      if (deliverToConnector && result.result && !result.error) {
        const delivery = await deliverToOriginConnector(completedSession, result.result, context.connectors);
        if (isUndeliveredToOrigin(delivery, completedSession)) recordFailedOriginDelivery(completedSession, context.emit);
      }
    }

    context.emit("session:completed", {
      sessionId: currentSession.id,
      employee: currentSession.employee || config.portal?.portalName || "Ryoko",
      title: currentSession.title,
      result: result.result,
      error: result.error || null,
      cost: result.cost,
      durationMs: result.durationMs,
    });

    logger.info(
      `Web session ${currentSession.id} completed` +
      (result.durationMs ? ` in ${result.durationMs}ms` : "") +
      (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!getSession(currentSession.id)) {
      logger.info(`Skipping error handling for deleted web session ${currentSession.id}: ${errMsg}`);
      return;
    }
    const erroredSession = updateSession(currentSession.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    if (erroredSession) {
      notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify });
    }
    context.emit("session:completed", {
      sessionId: currentSession.id,
      result: null,
      error: errMsg,
    });
    logger.error(`Web session ${currentSession.id} error: ${errMsg}`);
  }
}


// ---------------------------------------------------------------------------
// Config write serialization (fork addition)
// ---------------------------------------------------------------------------

/** One writer at a time for config.yaml + connector reload. The chain never
 *  rejects: a failing writer settles its own promise and the next waiter runs. */
let configWriteChain: Promise<void> = Promise.resolve();
export function withConfigLock<T>(work: () => Promise<T>): Promise<T> {
  const run = configWriteChain.then(work, work);
  configWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Onboarding probes (fork addition)
// ---------------------------------------------------------------------------

interface EngineProbeResult {
  name: string;
  configured: boolean;
  installed: boolean;
  runnable: boolean;
  bin?: string;
  version?: string;
  error?: string;
  auth?: { method: "api-key" | "oauth" | "chatgpt" | "none" | "unknown"; expiresAt?: string; expired?: boolean; note: string };
}

const ENGINE_PROBE_TTL_MS = 10_000;
type EngineProbePayload = { default: string; probedAt: string; engines: EngineProbeResult[] };
/** Cache and in-flight probe are keyed by the engine config they were taken
 *  under, so a bin/default change is never answered from a stale result — and
 *  a probe started under the old config only ever caches under the old key. */
let engineProbeInFlight: { key: string; promise: Promise<EngineProbePayload> } | null = null;
let engineProbeCache: { key: string; at: number; value: EngineProbePayload } | null = null;

function engineProbeKey(config: JinnConfig): string {
  return JSON.stringify({
    default: config.engines.default,
    claude: config.engines.claude?.bin, codex: config.engines.codex?.bin, gemini: config.engines.gemini?.bin,
  });
}

function runBinary(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    import("node:child_process").then(({ execFile }) => {
      execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") });
      });
    });
  });
}

async function probeEngine(name: string, bin: string | undefined): Promise<EngineProbeResult> {
  if (!bin) return { name, configured: false, installed: false, runnable: false };
  const { tryResolveBin } = await import("../shared/resolveBin.js");
  const resolved = tryResolveBin(bin);
  if (!resolved) return { name, configured: true, installed: false, runnable: false, bin, error: `${bin} が PATH にありません` };
  const version = await runBinary(resolved, ["--version"], 8_000);
  if (!version.ok) {
    return { name, configured: true, installed: true, runnable: false, bin: resolved,
      error: version.stderr.trim().split("\n")[0] || "起動に失敗しました" };
  }
  return { name, configured: true, installed: true, runnable: true, bin: resolved, version: version.stdout.trim().split("\n")[0] };
}

/** What can be observed about Claude's login WITHOUT spending anything: an API
 *  key in the environment, or the subscription OAuth file's expiry. Neither
 *  proves the credential still works — the note says so. */
function observeClaudeAuth(): NonNullable<EngineProbeResult["auth"]> {
  if (process.env.ANTHROPIC_API_KEY) return { method: "api-key", note: "API キーが設定されています（有効性は初回実行時に判明）" };
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const raw = fs.readFileSync(path.join(dir, ".credentials.json"), "utf-8");
    const expiresAt = JSON.parse(raw)?.claudeAiOauth?.expiresAt;
    if (typeof expiresAt === "number" && expiresAt > 0) {
      const expired = expiresAt < Date.now();
      return { method: "oauth", expiresAt: new Date(expiresAt).toISOString(), expired,
        note: expired ? "ログインの期限が切れています（claude を一度起動すると更新されます）" : "ログイン情報があります（有効性は初回実行時に判明）" };
    }
    return { method: "unknown", note: "ログイン情報の形式を判定できませんでした" };
  } catch {
    return { method: "none", note: "ログイン情報が見つかりません（端末で claude と入力してログイン）" };
  }
}

/** `codex login status` answers with its exit code — the one engine that can
 *  be asked directly, still without spending anything. */
async function observeCodexAuth(resolvedBin: string): Promise<NonNullable<EngineProbeResult["auth"]>> {
  const status = await runBinary(resolvedBin, ["login", "status"], 8_000);
  if (status.ok) return { method: "chatgpt", note: (status.stdout.trim().split("\n")[0] || "ログイン済み") };
  return { method: "none", note: "未ログインです（端末で codex login を実行）" };
}

async function probeOnboardingEngines(config: JinnConfig): Promise<EngineProbePayload> {
  const key = engineProbeKey(config);
  if (engineProbeCache && engineProbeCache.key === key && Date.now() - engineProbeCache.at < ENGINE_PROBE_TTL_MS) {
    return engineProbeCache.value;
  }
  if (engineProbeInFlight && engineProbeInFlight.key === key) return engineProbeInFlight.promise;
  const promise = (async () => {
    const [claude, codex, gemini] = await Promise.all([
      probeEngine("claude", config.engines.claude?.bin),
      probeEngine("codex", config.engines.codex?.bin),
      probeEngine("gemini", config.engines.gemini?.bin),
    ]);
    if (claude.runnable) claude.auth = observeClaudeAuth();
    if (codex.runnable && codex.bin) codex.auth = await observeCodexAuth(codex.bin);
    const value: EngineProbePayload = {
      default: config.engines.default, probedAt: new Date().toISOString(),
      engines: [claude, codex, ...(gemini.configured ? [gemini] : [])],
    };
    // Only the newest config's probe may become "the" cache; a probe that ran
    // under a config since replaced must not resurrect a stale answer.
    if (!engineProbeCache || engineProbeCache.key === key || engineProbeInFlight?.key === key) {
      engineProbeCache = { key, at: Date.now(), value };
    }
    return value;
  })();
  engineProbeInFlight = { key, promise };
  promise.finally(() => { if (engineProbeInFlight?.promise === promise) engineProbeInFlight = null; });
  return promise;
}

/** Exposed for tests: forget the cached probe. */
export function _resetEngineProbeCache(): void {
  engineProbeCache = null;
  engineProbeInFlight = null;
}

interface SlackVerifyResult {
  ok: boolean;
  bot: { ok: boolean; team?: string; user?: string; error?: string };
  app: { ok: boolean; error?: string };
}

async function slackApi(method: string, token: string): Promise<{ ok: boolean; error?: string; [key: string]: unknown }> {
  try {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      logger.warn(`[onboarding] Slack ${method} answered HTTP ${response.status}`);
      return { ok: false, error: `http_${response.status}` };
    }
    const payload = await response.json() as { ok?: boolean; error?: string; [key: string]: unknown };
    return { ...payload, ok: payload.ok === true };
  } catch (err) {
    // The raw message (DNS, TLS, timeout details) goes to the log; the client
    // gets a stable, non-leaky code.
    logger.warn(`[onboarding] Slack ${method} request failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: "network_error" };
  }
}

async function verifySlackTokens(botToken: string, appToken: string): Promise<SlackVerifyResult> {
  const [bot, app] = await Promise.all([
    slackApi("auth.test", botToken),
    slackApi("apps.connections.open", appToken),
  ]);
  const botResult = bot.ok
    ? { ok: true, team: typeof bot.team === "string" ? bot.team : undefined, user: typeof bot.user === "string" ? bot.user : undefined }
    : { ok: false, error: bot.error ?? "auth.test failed" };
  const appResult = app.ok ? { ok: true } : { ok: false, error: app.error ?? "apps.connections.open failed" };
  return { ok: botResult.ok && appResult.ok, bot: botResult, app: appResult };
}

interface ConfigPatchOutcome {
  status: "ok" | "partial";
  connectorsReload?: { started: string[]; stopped: string[]; errors: string[] };
  connectorsReloadError?: string;
}

/** Merge a patch into config.yaml and reload connectors — the same steps
 *  PUT /api/config performs, callable from a server-side flow that has to
 *  read the outcome and possibly undo the write. */
async function writeConfigPatchAndReload(context: ApiContext, patch: Record<string, unknown>): Promise<ConfigPatchOutcome> {
  let existing: Record<string, unknown> = {};
  try {
    existing = (yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>) || {};
  } catch { /* first write */ }
  const merged = deepMerge(existing, patch);
  context.suppressNextConnectorReload?.();
  fs.writeFileSync(CONFIG_PATH, yaml.dump(merged));
  invalidateModelRegistry();
  _resetEngineProbeCache();
  if (!context.reloadAllConnectors) return { status: "ok" };
  try {
    const reload = await context.reloadAllConnectors();
    context.config = context.getConfig();
    context.emit("connectors:reloaded", reload);
    if (reload.errors.length > 0) context.clearSuppressNextConnectorReload?.();
    return { status: reload.errors.length > 0 ? "partial" : "ok", connectorsReload: reload };
  } catch (err) {
    context.clearSuppressNextConnectorReload?.();
    return { status: "ok", connectorsReloadError: err instanceof Error ? err.message : String(err) };
  }
}

interface SlackConnectResult {
  ok: boolean;
  stage?: "verify" | "reload";
  error?: string;
  /** What was on disk before this attempt: an existing Slack block, or none.
   *  Tells the caller what a rollback means here — "the old connection is
   *  back" vs "the attempt was undone and Slack is unconfigured again". */
  previous?: "config" | "none";
  /** True only when the pre-attempt state is fully back: the file (the old
   *  block restored, or removed again for previous:"none") AND the live
   *  connectors settled on it without a Slack error — the old connector
   *  running again for "config", nothing left to run for "none". Never true
   *  when the second reload reported a failure. */
  rolledBack?: boolean;
  /** What the rollback achieved, separately: the file, and the live
   *  connector. running is always false for previous:"none" — there is no
   *  previous connector to bring back. */
  restored?: { disk: boolean; running: boolean };
  rollbackError?: string;
  /** Set when the on-disk Slack block was changed by someone else between our
   *  write and the rollback — we leave their value alone. */
  rollbackSkipped?: string;
  team?: string;
  user?: string;
  bot?: SlackVerifyResult["bot"];
  app?: SlackVerifyResult["app"];
}

function slackFailure(outcome: ConfigPatchOutcome): string | null {
  if (outcome.connectorsReloadError) return outcome.connectorsReloadError;
  const errors = outcome.connectorsReload?.errors ?? [];
  const slack = errors.find((line) => /slack/i.test(line));
  if (slack) return slack;
  if (outcome.status === "partial" && errors.length > 0) return errors.join(" | ");
  return null;
}

function readSlackBlock(): Record<string, unknown> | null {
  try {
    const current = (yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as { connectors?: { slack?: Record<string, unknown> } }) || {};
    return current.connectors?.slack ?? null;
  } catch {
    return null;
  }
}

async function connectSlack(context: ApiContext, botToken: string, appToken: string): Promise<SlackConnectResult> {
  const verified = await verifySlackTokens(botToken, appToken);
  if (!verified.ok) return { ok: false, stage: "verify", error: "token verification failed", bot: verified.bot, app: verified.app };

  // Snapshot → write → reload → (rollback) is ONE critical section: a PUT
  // /api/config or a second connect waits for it, so the snapshot we would
  // restore can never be older than what a concurrent writer put down.
  return withConfigLock(async () => {
    const previousSlack = readSlackBlock();
    const previous = previousSlack ? ("config" as const) : ("none" as const);
    const outcome = await writeConfigPatchAndReload(context, { connectors: { slack: { botToken, appToken } } });
    const failure = slackFailure(outcome);
    if (!failure) return { ok: true, team: verified.bot.team, user: verified.bot.user };

    // The connector did not come up on tokens Slack itself accepted. Put the
    // previous configuration back (or remove the block if there was none) —
    // but only if the block on disk is still OURS: an out-of-band editor may
    // have written something else meanwhile, and that is theirs to keep.
    const onDisk = readSlackBlock();
    if (onDisk?.botToken !== botToken || onDisk?.appToken !== appToken) {
      logger.warn(`[onboarding] Slack connect failed (${failure}) but the Slack config changed concurrently — leaving it as is`);
      return { ok: false, stage: "reload", error: failure, previous, rolledBack: false,
        restored: { disk: false, running: false }, rollbackSkipped: "config changed concurrently" };
    }
    logger.warn(`[onboarding] Slack connect failed after save (${failure}) — ${previous === "config" ? "restoring previous Slack config" : "removing the Slack block again"}`);
    let rollback: ConfigPatchOutcome;
    try {
      rollback = await writeConfigPatchAndReload(context, { connectors: { slack: previousSlack ?? null } });
    } catch (err) {
      const rollbackError = err instanceof Error ? err.message : String(err);
      logger.error(`[onboarding] Slack rollback write failed: ${rollbackError}`);
      return { ok: false, stage: "reload", error: failure, previous, rolledBack: false,
        restored: { disk: false, running: false }, rollbackError };
    }
    // The rollback is only a rollback if the live side settled on the restored
    // file: the previous connector came back up (previous:"config"), or the
    // removal reload finished without a Slack error (previous:"none"). A
    // partial/errored second reload is reported as such in both cases — the
    // file is back, the connectors are not known to be.
    const rollbackFailure = slackFailure(rollback);
    if (rollbackFailure) {
      logger.error(`[onboarding] Slack rollback wrote the previous config but the connectors did not settle on it: ${rollbackFailure}`);
      return { ok: false, stage: "reload", error: failure, previous, rolledBack: false,
        restored: { disk: true, running: false }, rollbackError: rollbackFailure };
    }
    return { ok: false, stage: "reload", error: failure, previous, rolledBack: true, restored: { disk: true, running: previous === "config" } };
  });
}
