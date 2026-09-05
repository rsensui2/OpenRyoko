import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { JinnConfig, Connector, Employee } from "../shared/types.js";
import { loadConfig } from "../shared/config.js";
import { invalidateModelRegistry } from "../shared/models.js";
import { configureLogger, logger } from "../shared/logger.js";
import { initDb, scheduleFtsBackfill, recoverStaleSessions, recoverStaleWorkflowAttemptSessions, recoverStaleQueueItems, getInterruptedSessions, listSessions, updateSession, getSession } from "../sessions/registry.js";
import { SessionManager, type RouteOptions } from "../sessions/manager.js";
import { ClaudeEngine } from "../engines/claude.js";
import { CodexEngine } from "../engines/codex.js";
import { GeminiEngine } from "../engines/gemini.js";
import { InteractiveClaudeEngine } from "../engines/claude-interactive.js";
import { PtyLifecycleManager } from "../engines/pty-lifecycle.js";
import type { PtyViewEngine } from "../engines/pty-view-engine.js";
import { attachPtyWebSocket } from "./pty-ws.js";
import { HookRegistry } from "./hook-registry.js";
import { startStatusReconciler } from "./status-reconciler.js";
import { writeGatewayInfo } from "./gateway-info.js";
import { cleanupSessionSettings, seedTrust } from "../shared/claude-settings.js";
import { GATEWAY_INFO_FILE, HOOK_RELAY_SCRIPT, CLAUDE_SETTINGS_DIR, JINN_HOME } from "../shared/paths.js";
import { handleApiRequest, resumePendingWebQueueItems, type ApiContext } from "./api.js";
import { openWorkflowDatabase } from "../workflows/repository-migrations.js";
import { WorkflowRepository } from "../workflows/repository.js";
import { WorkflowService } from "../workflows/service.js";
import { WorkflowSessionExecutor } from "../workflows/session-executor.js";
import { getMessages } from "../sessions/registry.js";
import { getModelRegistry } from "../shared/models.js";
import { ensureFilesDir } from "./files.js";
import { ensureOwnerOnlyDirectory } from "../shared/owner-only.js";
import {
  ensureGatewayAuthToken,
  gatewayRequestNeedsAuth,
  isNetworkHost,
  shouldRequireGatewayAuth,
  validateGatewayExposure,
  verifyGatewayAuth,
} from "./auth.js";
import { initStt } from "../stt/stt.js";
import { startWatchers, stopWatchers, syncSkillSymlinks } from "./watcher.js";
import { SlackConnector } from "../connectors/slack/index.js";
import { DiscordConnector, type DiscordConnectorConfig } from "../connectors/discord/index.js";
import { RemoteDiscordConnector } from "../connectors/discord/remote.js";
import { WhatsAppConnector } from "../connectors/whatsapp/index.js";
import { TelegramConnector } from "../connectors/telegram/index.js";
import { loadJobs } from "../cron/jobs.js";
import { startScheduler, reloadScheduler, stopScheduler } from "../cron/scheduler.js";
import { scanOrg } from "./org.js";
import { createDailyDatabaseBackup } from "../sessions/backup.js";
import { getDiskSpaceStatus } from "../shared/storage-health.js";
import { requestOriginAllowed } from "./request-origin.js";
import { hostHeaderAllowed, localInterfaceHosts } from "./host-guard.js";
import { isWildcardBindHost, localGatewayUrl } from "../shared/gateway-url.js";
import { staticPathWithinRoot } from "./static-path.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Copy the hook-relay.mjs asset next to JINN_HOME so PTY-spawned Claude (running
 *  with our per-session --settings) can invoke it to POST turn hooks back to the
 *  gateway. Tries dev (src) and built (dist) layouts. Best-effort: a failure only
 *  degrades interactive turn resolution, which we log. */
function copyHookRelayAsset(): void {
  const candidates = [
    path.join(__dirname, "..", "..", "..", "assets", "hook-relay.mjs"), // dev: src/gateway → packages/jimmy/assets
    path.join(__dirname, "..", "..", "assets", "hook-relay.mjs"),       // built: dist/src/gateway → dist/assets
    path.join(__dirname, "..", "assets", "hook-relay.mjs"),
  ];
  try {
    const src = candidates.find((p) => fs.existsSync(p));
    if (!src) {
      logger.warn("hook-relay.mjs asset not found in any candidate location; interactive Claude hooks may not work");
      return;
    }
    fs.copyFileSync(src, HOOK_RELAY_SCRIPT);
  } catch (err) {
    logger.warn(`Failed to copy hook-relay.mjs: ${err instanceof Error ? err.message : err}`);
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webDir: string,
): boolean {
  if (!fs.existsSync(webDir)) return false;

  // Strip query string before resolving file path
  const urlPath = (req.url || "/").split("?")[0];
  let filePath = path.join(webDir, urlPath);
  if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");

  // Prevent directory traversal
  const resolved = path.resolve(filePath);
  if (!staticPathWithinRoot(webDir, resolved)) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    // Next.js static export produces /chat.html, /sessions.html, etc.
    // Try appending .html before falling back to index.html
    const htmlPath = resolved.endsWith("/")
      ? path.join(resolved, "index.html")
      : resolved + ".html";
    if (fs.existsSync(htmlPath) && !fs.statSync(htmlPath).isDirectory()) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(htmlPath).pipe(res);
      return true;
    }

    // SPA fallback: serve index.html for non-API, non-WS routes
    const indexPath = path.join(webDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }
    return false;
  }

  const ext = path.extname(resolved);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

export type GatewayCleanup = () => Promise<void>;

export async function startGateway(
  config: JinnConfig,
): Promise<GatewayCleanup> {
  const bootId = randomUUID().slice(0, 8);

  const exposure = validateGatewayExposure(config);
  if (!exposure.ok) throw new Error(exposure.error);

  // Heal legacy instances before opening config, database, hook settings or logs.
  const homePermission = ensureOwnerOnlyDirectory(JINN_HOME);
  if (homePermission.warning) {
    console.warn(`[openryoko] could not restrict ${JINN_HOME} to the current user: ${homePermission.warning}`);
  }
  const authToken = ensureGatewayAuthToken(JINN_HOME);
  const authRequired = shouldRequireGatewayAuth(config);
  const hasTrustedProxy = config.gateway.trustProxyHeaders === true && Boolean(config.gateway.trustedProxyAddresses?.length);
  if (isNetworkHost(config.gateway.host) && config.gateway.authDisabled !== true && !hasTrustedProxy) {
    console.warn("[openryoko] Network gateway authentication is enabled, but HTTP is not encrypted. Use a VPN/Tailscale tunnel or a trusted HTTPS reverse proxy; set gateway.trustProxyHeaders=true only behind that proxy.");
  }
  if (config.gateway.trustProxyHeaders === true && !(config.gateway.trustedProxyAddresses?.length)) {
    console.warn("[openryoko] gateway.trustProxyHeaders is enabled without gateway.trustedProxyAddresses; forwarded headers will be ignored.");
  }

  // Configure logging
  configureLogger({
    level: config.logging.level,
    stdout: config.logging.stdout,
    file: config.logging.file,
  });

  const gatewayName = config.portal?.portalName || "Ryoko";
  logger.info(`Starting ${gatewayName} gateway (boot ${bootId}, pid ${process.pid})...`);

  // Initialize database and recover any sessions stuck from a previous run
  const database = initDb();
  void scheduleFtsBackfill();
  const disk = getDiskSpaceStatus();
  if (disk.level === "warning" || disk.level === "critical") {
    const freeMiB = disk.freeBytes === null ? "unknown" : Math.floor(disk.freeBytes / 1024 ** 2);
    logger.warn(`Low disk space: ${freeMiB} MiB free (${disk.freePercent?.toFixed(1) ?? "unknown"}%)`);
  }
  try {
    const backup = await createDailyDatabaseBackup(database);
    if (backup.created) logger.info(`Created daily database backup: ${backup.file}`);
  } catch (error) {
    logger.warn(`Database backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  ensureFilesDir();
  const recovered = recoverStaleSessions();
  if (recovered > 0) {
    logger.info(`Recovered ${recovered} stale session(s) — marked as "interrupted" for resume`);
  }
  // Workflow attempt sessions get their own sweep: it stamps the durable
  // `gateway-restart` receipt the runtime needs to REPLACE the attempt instead
  // of spending its retry budget. recoverStaleSessions() above deliberately
  // skips workflow_kind rows so this sweep still finds them running.
  const recoveredWorkflowAttempts = recoverStaleWorkflowAttemptSessions();
  if (recoveredWorkflowAttempts > 0) {
    logger.info(`Recovered ${recoveredWorkflowAttempts} stale workflow attempt(s) — stamped gateway-restart receipts`);
  }

  // Log resumable sessions so operators know what can be picked up
  const resumable = getInterruptedSessions();
  if (resumable.length > 0) {
    logger.info(`${resumable.length} interrupted session(s) available for resume:`);
    for (const s of resumable) {
      logger.info(`  - ${s.id} (engine: ${s.engine}, employee: ${s.employee || "none"}, engineSessionId: ${s.engineSessionId})`);
    }
  }
  const recoveredQueue = recoverStaleQueueItems();
  if (recoveredQueue > 0) {
    logger.info(`Recovered ${recoveredQueue} in-flight queue item(s) from previous run — reset to pending`);
  }

  // Set up engines
  const claudeEngine = new ClaudeEngine();
  const codexEngine = new CodexEngine();
  const geminiEngine = new GeminiEngine();

  // Interactive Claude (PTY) engine — opt-in via config.engines.claude.interactive.
  // When enabled it REPLACES the headless `claude -p` engine under the "claude" key,
  // so all existing engine-config / fallback / rate-limit logic keys on "claude"
  // unchanged. It runs the genuine `claude` CLI in a PTY (no -p → cc_entrypoint=cli),
  // which bills against the Max subscription instead of metered API usage. Turns are
  // resolved via Claude Code Stop hooks relayed back through /api/internal/hook.
  const useInteractiveClaude = config.engines?.claude?.interactive === true;
  const hookSecret = randomBytes(24).toString("hex");
  let hookRegistry: HookRegistry | undefined;
  let claudeLifecycle: PtyLifecycleManager | undefined;
  let interactiveClaudeEngine: InteractiveClaudeEngine | undefined;
  if (useInteractiveClaude) {
    hookRegistry = new HookRegistry();
    claudeLifecycle = new PtyLifecycleManager({
      maxLivePtys: config.engines?.claude?.maxLivePtys ?? 8,
      onCleanup: (id) => {
        hookRegistry?.unregister(id);
        cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id);
      },
      // Never reap/evict a PTY whose claude is mid-API-call (background
      // sub-agents keep streaming after the managed turn settles). Lazily bound:
      // the engine is constructed a few lines below.
      isBusy: (id) => interactiveClaudeEngine?.isEngineBusy(id) ?? false,
    });
    // Pass the headless engine as a remote fallback so sshHost employees still run
    // over SSH (the local PTY can't), while local turns get the Max-subsidized PTY.
    interactiveClaudeEngine = new InteractiveClaudeEngine(
      claudeLifecycle,
      hookRegistry,
      claudeEngine,
      config.engines?.claude?.interactiveTurnTimeoutMs ?? 90 * 60 * 1000,
      config.engines?.claude?.autoApproveSafetyPrompts === true,
    );
    copyHookRelayAsset();
    // Pre-trust JINN_HOME in the real ~/.claude.json so PTY-spawned Claude (cwd =
    // JINN_HOME) doesn't block every turn on the interactive "trust this folder?"
    // dialog — which has no Stop hook, so the turn would hang forever.
    try {
      seedTrust(path.join(os.homedir(), ".claude.json"), JINN_HOME);
    } catch (err) {
      logger.warn(`seedTrust failed for ${JINN_HOME}: ${err instanceof Error ? err.message : err}`);
    }
    logger.info("Interactive Claude (PTY) engine enabled — Claude work turns run via PTY (Max-subsidized cc_entrypoint=cli)");
  }

  const engines = new Map<string, InstanceType<typeof ClaudeEngine> | InstanceType<typeof CodexEngine> | InstanceType<typeof GeminiEngine> | InteractiveClaudeEngine>();
  engines.set("claude", interactiveClaudeEngine ?? claudeEngine);
  engines.set("codex", codexEngine);
  engines.set("gemini", geminiEngine);

  // PTY-capable engines keyed by engine name — the /ws/pty/:sessionId handler
  // routes by session.engine so the live xterm CLI view attaches to the right one.
  // Only the interactive Claude engine exposes a PTY; absent when interactive is off.
  const ptyViewEngines: Record<string, PtyViewEngine> = {};
  if (interactiveClaudeEngine) ptyViewEngines["claude"] = interactiveClaudeEngine;

  // Derive connector names from config
  const connectorNames: string[] = [];
  if (config.connectors?.slack?.appToken && config.connectors?.slack?.botToken) {
    connectorNames.push("slack");
  }
  if (config.connectors?.discord?.botToken || config.connectors?.discord?.proxyVia) {
    connectorNames.push("discord");
  }
  if (config.connectors?.telegram?.botToken) {
    connectorNames.push("telegram");
  }
  if (config.connectors?.whatsapp) {
    connectorNames.push("whatsapp");
  }

  // Session manager
  const sessionManager = new SessionManager(config, engines, connectorNames);

  // Orphan hooks = engine activity AFTER a turn settled (background sub-agents /
  // tasks still running in the PTY). Any orphan event keeps the PTY alive; a
  // terminal Stop orphan is the final output of that background work and gets
  // delivered to the session's conversation instead of being dropped.
  hookRegistry?.setOrphanHandler((sid, hook) => {
    interactiveClaudeEngine?.noteBackgroundActivity(sid);
    void sessionManager.handleOrphanHook(sid, hook);
  });

  // Build employee registry
  let employeeRegistry = scanOrg();
  logger.info(`Loaded ${employeeRegistry.size} employee(s) from org directory`);

  // Start connectors
  const connectors: Connector[] = [];
  const connectorMap = new Map<string, Connector>();
  /** IDs of connectors created from config.connectors.instances[] (vs legacy top-level connectors) */
  const instanceConnectorIds = new Set<string>();

  // ---- Top-level connector start/stop helpers (closure over employeeRegistry, connectors, etc.) ----
  // These are defined here so they can be reused by both initial startup AND
  // reloadAllConnectors() when config.yaml changes (e.g. user saves new Slack
  // tokens via the WebUI).

  async function stopTopLevelConnectors(): Promise<{ stopped: string[]; errors: string[] }> {
    const stopped: string[] = [];
    const errors: string[] = [];
    for (const [id, connector] of [...connectorMap.entries()]) {
      // Instance-based connectors are handled by reloadConnectorInstances()
      if (instanceConnectorIds.has(id)) continue;
      try {
        await connector.stop();
        // stop() succeeded — safe to drop reference and let reload recreate.
        connectorMap.delete(id);
        const idx = connectors.indexOf(connector);
        if (idx >= 0) connectors.splice(idx, 1);
        stopped.push(id);
        logger.info(`Stopped top-level connector "${id}" for reload`);
      } catch (err) {
        // stop() FAILED. Don't drop the reference: the underlying client
        // (Slack websocket, Discord gateway, etc.) may still be live. If we
        // recreated it now, we'd have two live clients processing the same
        // events and sending duplicate replies. Better to surface a loud
        // error and require a daemon restart for recovery.
        const message = `stop() failed for top-level connector "${id}" — leaving in place to avoid duplicate replies. A full daemon restart may be required. Error: ${err instanceof Error ? err.message : err}`;
        logger.error(message);
        errors.push(message);
      }
    }
    return { stopped, errors };
  }

  async function startTopLevelConnectorsFromConfig(
    cfg: JinnConfig,
  ): Promise<{ started: string[]; errors: string[] }> {
    const started: string[] = [];
    const errors: string[] = [];

    if (
      cfg.connectors?.slack?.appToken &&
      cfg.connectors?.slack?.botToken &&
      !connectorMap.has("slack")
    ) {
      try {
        const slack = new SlackConnector(
          {
            appToken: cfg.connectors.slack.appToken,
            botToken: cfg.connectors.slack.botToken,
            allowFrom: cfg.connectors.slack.allowFrom,
            ignoreOldMessagesOnBoot: cfg.connectors.slack.ignoreOldMessagesOnBoot,
            triage: cfg.connectors.slack.triage,
            goalExtraction: cfg.connectors.slack.goalExtraction,
            agentsCanvas: cfg.connectors.slack.agentsCanvas,
          },
          {
            portalName: cfg.portal?.portalName,
            operatorName: cfg.portal?.operatorName,
            operatorAliases: cfg.portal?.operatorAliases,
            goalInjectionEnabled: (cfg.connectors.slack.employee
              ? employeeRegistry.get(cfg.connectors.slack.employee)?.engine
              : cfg.engines.default) === "claude",
          },
        );
        slack.onMessage((msg) => {
          const routeOpts: RouteOptions = {};
          if (cfg.connectors.slack?.employee) {
            const emp = employeeRegistry.get(cfg.connectors.slack.employee);
            if (emp) routeOpts.employee = emp;
          }
          sessionManager.route(msg, slack, routeOpts).catch((err) => {
            logger.error(`Slack route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await slack.start();
        connectors.push(slack);
        connectorMap.set("slack", slack);
        started.push("slack");
      } catch (err) {
        const msg = `Failed to start Slack connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    if (cfg.connectors?.discord?.proxyVia && !connectorMap.has("discord")) {
      try {
        const discord = new RemoteDiscordConnector({
          proxyVia: cfg.connectors.discord.proxyVia,
          proxyViaToken: cfg.connectors.discord.proxyViaToken,
          channelId: cfg.connectors.discord.channelId,
          respondTo: cfg.connectors.discord.respondTo,
        });
        discord.onMessage((msg) => {
          const routeOpts: RouteOptions = {};
          if (cfg.connectors.discord?.employee) {
            const emp = employeeRegistry.get(cfg.connectors.discord.employee);
            if (emp) routeOpts.employee = emp;
          }
          sessionManager.route(msg, discord, routeOpts).catch((err) => {
            logger.error(`Discord route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await discord.start();
        connectors.push(discord);
        connectorMap.set("discord", discord);
        started.push("discord");
        logger.info("Discord remote connector started");
      } catch (err) {
        const msg = `Failed to start remote Discord connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    } else if (cfg.connectors?.discord?.botToken && !connectorMap.has("discord")) {
      try {
        const discord = new DiscordConnector(cfg.connectors.discord as DiscordConnectorConfig);
        discord.onMessage((msg) => {
          const routeOpts: RouteOptions = {};
          if (cfg.connectors.discord?.employee) {
            const emp = employeeRegistry.get(cfg.connectors.discord.employee);
            if (emp) routeOpts.employee = emp;
          }
          sessionManager.route(msg, discord, routeOpts).catch((err) => {
            logger.error(`Discord route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await discord.start();
        connectors.push(discord);
        connectorMap.set("discord", discord);
        started.push("discord");
        logger.info("Discord connector started");
      } catch (err) {
        const msg = `Failed to start Discord connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    if (cfg.connectors?.telegram?.botToken && !connectorMap.has("telegram")) {
      try {
        const telegram = new TelegramConnector({
          botToken: cfg.connectors.telegram.botToken,
          allowFrom: cfg.connectors.telegram.allowFrom,
          ignoreOldMessagesOnBoot: cfg.connectors.telegram.ignoreOldMessagesOnBoot,
        });
        telegram.onMessage((msg) => {
          const routeOpts: RouteOptions = {};
          if (cfg.connectors.telegram?.employee) {
            const emp = employeeRegistry.get(cfg.connectors.telegram.employee);
            if (emp) routeOpts.employee = emp;
          }
          sessionManager.route(msg, telegram, routeOpts).catch((err) => {
            logger.error(`Telegram route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await telegram.start();
        connectors.push(telegram);
        connectorMap.set("telegram", telegram);
        started.push("telegram");
      } catch (err) {
        const msg = `Failed to start Telegram connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    if (cfg.connectors?.whatsapp && !connectorMap.has("whatsapp")) {
      try {
        const whatsapp = new WhatsAppConnector(cfg.connectors.whatsapp ?? {});
        whatsapp.onMessage((msg) => {
          const routeOpts: RouteOptions = {};
          if (cfg.connectors.whatsapp?.employee) {
            const emp = employeeRegistry.get(cfg.connectors.whatsapp.employee);
            if (emp) routeOpts.employee = emp;
          }
          sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
            logger.error(`WhatsApp route error: ${err instanceof Error ? err.message : err}`);
          });
        });
        await whatsapp.start();
        connectors.push(whatsapp);
        connectorMap.set("whatsapp", whatsapp);
        started.push("whatsapp");
        logger.info("WhatsApp connector started (scan QR code if first run)");
      } catch (err) {
        const msg = `Failed to start WhatsApp connector: ${err instanceof Error ? err.message : err}`;
        logger.error(msg);
        errors.push(msg);
      }
    }

    return { started, errors };
  }

  // Initial top-level connector startup
  await startTopLevelConnectorsFromConfig(config);

  // Process named connector instances (allows multiple connectors of the same type)
  if (config.connectors?.instances) {
    for (const instance of config.connectors.instances) {
      const { id, type, employee, ...typeConfig } = instance;
      if (!id || !type) {
        logger.warn(`Skipping connector instance without id or type`);
        continue;
      }
      if (connectorMap.has(id)) {
        logger.warn(`Duplicate connector instance id "${id}", skipping`);
        continue;
      }

      try {
        let connector: Connector;
        switch (type) {
          case "discord": {
            const discordConfig = { ...typeConfig, id } as DiscordConnectorConfig;
            const discord = new DiscordConnector(discordConfig);
            discord.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, discord, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await discord.start();
            connector = discord;
            break;
          }
          case "slack": {
            const slackConfig = { ...typeConfig, id } as any;
            const slack = new SlackConnector(slackConfig, {
              portalName: config.portal?.portalName,
              operatorName: config.portal?.operatorName,
              operatorAliases: config.portal?.operatorAliases,
              goalInjectionEnabled: (employee ? employeeRegistry.get(employee)?.engine : config.engines.default) === "claude",
            });
            slack.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, slack, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await slack.start();
            connector = slack;
            break;
          }
          case "whatsapp": {
            const whatsapp = new WhatsAppConnector({ ...typeConfig } as any);
            whatsapp.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await whatsapp.start();
            connector = whatsapp;
            break;
          }
          case "telegram": {
            const telegramConfig = { ...typeConfig, id } as any;
            const tg = new TelegramConnector(telegramConfig);
            tg.onMessage((msg) => {
              const routeOpts: RouteOptions = {};
              if (employee) {
                const emp = employeeRegistry.get(employee);
                if (emp) routeOpts.employee = emp;
              }
              sessionManager.route(msg, tg, routeOpts).catch((err) => {
                logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
              });
            });
            await tg.start();
            connector = tg;
            break;
          }
          default:
            logger.warn(`Unknown connector type "${type}" for instance "${id}"`);
            continue;
        }
        connectors.push(connector);
        connectorMap.set(id, connector);
        instanceConnectorIds.add(id);
        logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
      } catch (err) {
        logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  sessionManager.setConnectorProvider(() => connectorMap);

  // Reload connector instances from config (stop old instances, start new ones)
  /**
   * Stop only the instance-based connectors. Split out from the legacy
   * combined reload so reloadAllConnectors() can interleave: stop top-level
   * + stop instances → start top-level → start instances. That order
   * preserves boot-time precedence (top-level wins for duplicate ids).
   */
  async function stopInstanceConnectors(): Promise<{ stopped: string[]; errors: string[] }> {
    const stopped: string[] = [];
    const errors: string[] = [];
    for (const [id, connector] of [...connectorMap.entries()]) {
      if (!instanceConnectorIds.has(id)) continue;
      try {
        await connector.stop();
        // stop() succeeded — safe to drop reference and let restart create afresh.
        connectorMap.delete(id);
        instanceConnectorIds.delete(id);
        const idx = connectors.indexOf(connector);
        if (idx >= 0) connectors.splice(idx, 1);
        stopped.push(id);
        logger.info(`Stopped connector instance "${id}" for reload`);
      } catch (err) {
        // stop() FAILED. Same reasoning as stopTopLevelConnectors: leave
        // the reference in place rather than risk duplicate live clients.
        const message = `stop() failed for instance "${id}" — leaving in place to avoid duplicate replies. A full daemon restart may be required. Error: ${err instanceof Error ? err.message : err}`;
        logger.error(message);
        errors.push(message);
      }
    }
    return { stopped, errors };
  }

  async function startConfiguredInstances(
    freshConfig: JinnConfig,
  ): Promise<{ started: string[]; errors: string[] }> {
    const started: string[] = [];
    const errors: string[] = [];
    if (freshConfig.connectors?.instances) {
      for (const instance of freshConfig.connectors.instances) {
        const { id, type, employee, ...typeConfig } = instance;
        if (!id || !type) continue;
        if (connectorMap.has(id)) continue;

        try {
          let connector: Connector;
          switch (type) {
            case "discord": {
              const discordConfig = { ...typeConfig, id } as DiscordConnectorConfig;
              const discord = new DiscordConnector(discordConfig);
              discord.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, discord, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await discord.start();
              connector = discord;
              break;
            }
            case "slack": {
              const slackConfig = { ...typeConfig, id } as any;
              // Use freshConfig.portal (not the closure-captured boot-time
              // `config`) so renamed portals show up after a hot-reload.
              const slack = new SlackConnector(slackConfig, {
                portalName: freshConfig.portal?.portalName,
                operatorName: freshConfig.portal?.operatorName,
                operatorAliases: freshConfig.portal?.operatorAliases,
                goalInjectionEnabled: (employee ? employeeRegistry.get(employee)?.engine : freshConfig.engines.default) === "claude",
              });
              slack.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, slack, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await slack.start();
              connector = slack;
              break;
            }
            case "whatsapp": {
              const whatsapp = new WhatsAppConnector({ ...typeConfig } as any);
              whatsapp.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, whatsapp, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await whatsapp.start();
              connector = whatsapp;
              break;
            }
            case "telegram": {
              const telegramConfig = { ...typeConfig, id } as any;
              const tg = new TelegramConnector(telegramConfig);
              tg.onMessage((msg) => {
                const routeOpts: RouteOptions = {};
                if (employee) {
                  const emp = employeeRegistry.get(employee);
                  if (emp) routeOpts.employee = emp;
                }
                sessionManager.route(msg, tg, routeOpts).catch((err) => {
                  logger.error(`${id} route error: ${err instanceof Error ? err.message : err}`);
                });
              });
              await tg.start();
              connector = tg;
              break;
            }
            default:
              errors.push(`Unknown connector type "${type}" for instance "${id}"`);
              continue;
          }
          connectors.push(connector);
          connectorMap.set(id, connector);
          instanceConnectorIds.add(id);
          started.push(id);
          logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
        } catch (err) {
          errors.push(`Failed to start "${id}": ${err instanceof Error ? err.message : err}`);
          logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    return { started, errors };
  }

  /**
   * Backwards-compatible wrapper: stop+start instances in one call. Used by
   * the `POST /api/connectors/reload` endpoint and exposed via ApiContext
   * for any external consumer that still calls reloadConnectorInstances().
   */
  async function reloadConnectorInstances(
    preloadedConfig?: JinnConfig,
  ): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    const fresh = preloadedConfig ?? loadConfig();
    const stopRes = await stopInstanceConnectors();
    const startRes = await startConfiguredInstances(fresh);
    return {
      started: startRes.started,
      stopped: stopRes.stopped,
      errors: [...stopRes.errors, ...startRes.errors],
    };
  }

  /**
   * Stop and re-initialize ALL connectors (top-level + instance-based) from
   * the on-disk config. Called automatically when ~/.ryoko/config.yaml
   * changes via the chokidar watcher, and via POST /api/connectors/reload.
   *
   * This is what makes "save Slack tokens in WebUI → bot reconnects" work
   * without a daemon restart. Previously only instance-based connectors
   * were reloaded, so editing top-level slack tokens required `ryoko stop`
   * + `ryoko start`.
   */
  async function doReloadOnce(): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    const fresh = loadConfig();
    // Push fresh config into the SessionManager so new sessions see new
    // engines.default / portal.* / bin paths. Callers (watcher / API) are
    // responsible for updating apiContext.config too.
    currentConfig = fresh;
    invalidateModelRegistry(); // rebuild the model/capability registry from the new config
    sessionManager.setConfig(fresh);

    // Order:
    //   1. Stop old top-level + old instance connectors (clear the map).
    //   2. Start top-level FIRST (matches boot precedence: if a duplicate
    //      id exists in both forms, the legacy top-level wins).
    //   3. Start instances last — same `!connectorMap.has(...)` guard as
    //      boot, so duplicate-id instances are skipped, not the top-level.
    const stopTopRes = await stopTopLevelConnectors();
    const stopInstRes = await stopInstanceConnectors();
    const startTopRes = await startTopLevelConnectorsFromConfig(fresh);
    const startInstRes = await startConfiguredInstances(fresh);
    // Refresh the connector names baked into engine system prompts.
    sessionManager.setConnectorNames(Array.from(connectorMap.keys()));

    const result = {
      started: [...startTopRes.started, ...startInstRes.started],
      stopped: [...stopTopRes.stopped, ...stopInstRes.stopped],
      errors: [
        ...stopTopRes.errors,
        ...stopInstRes.errors,
        ...startTopRes.errors,
        ...startInstRes.errors,
      ],
    };

    // Only mark this config as "successfully applied" when no errors arose.
    // Otherwise the watcher's next event (after clearSuppressNextConnectorReload
    // in the API failure path) would diff fresh-vs-fresh and skip the retry.
    if (result.errors.length === 0) {
      lastConnectorReloadConfig = fresh;
    }
    return result;
  }

  async function reloadAllConnectors(): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    // Coalesce concurrent callers: if a reload is in flight, mark a follow-up
    // so newer config (the second caller's intent) gets picked up after the
    // current one completes — and return the in-flight promise's result.
    // Without this, two overlapping reloads can both observe an empty map
    // after their respective stop pass and start duplicate live clients.
    if (reloadInFlight) {
      pendingReload = true;
      return reloadInFlight;
    }
    reloadInFlight = (async () => {
      try {
        let result = await doReloadOnce();
        // Drain any reload requests that arrived during this run, with
        // the most recent on-disk config. Keep going until quiet.
        while (pendingReload) {
          pendingReload = false;
          result = await doReloadOnce();
        }
        return result;
      } finally {
        reloadInFlight = null;
      }
    })();
    return reloadInFlight;
  }

  // Start cron scheduler
  const cronJobs = loadJobs();
  startScheduler(cronJobs, sessionManager, config, connectorMap);
  logger.info(`Loaded ${cronJobs.length} cron job(s)`);

  // Mutable config reference for hot-reload
  let currentConfig = config;
  // Tracks the config version that was last successfully applied to connectors.
  // The watcher diffs against THIS (not currentConfig) so that a failed reload
  // does not poison the next chokidar event into thinking "nothing changed".
  let lastConnectorReloadConfig = config;

  // Single-flight gate for connector reloads: any caller that arrives while
  // one is in flight is coalesced (no duplicate clients), and any reload
  // request received during a run schedules a single follow-up so newer
  // config doesn't get lost.
  let reloadInFlight: Promise<{ started: string[]; stopped: string[]; errors: string[] }> | null = null;
  let pendingReload = false;

  // Coordination between the API config-write paths and the file watcher.
  // A writer that reloads connectors itself (PUT /api/config, the onboarding
  // Slack connect and its rollback) arms one suppression per file write, and
  // the watcher consumes one per event it skips. A COUNTER rather than a flag,
  // so two writers in flight cannot clear each other's suppression: each
  // arms and clears only its own. A safety timer drains everything in case a
  // watcher event never arrives (chokidar coalesced two writes into one
  // event, or missed it), so legitimate external edits are never suppressed
  // for long. Known limit: when chokidar coalesces N writes into one event,
  // N-1 suppressions remain until the timer drains them.
  let suppressedWatcherConnectorReloads = 0;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;
  function armSuppressDrainTimer(): void {
    if (suppressTimer) clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => {
      suppressedWatcherConnectorReloads = 0;
      suppressTimer = null;
    }, 3000);
  }
  function suppressNextConnectorReload(): void {
    suppressedWatcherConnectorReloads += 1;
    armSuppressDrainTimer();
  }
  function clearSuppressNextConnectorReload(): void {
    if (suppressedWatcherConnectorReloads > 0) suppressedWatcherConnectorReloads -= 1;
    if (suppressedWatcherConnectorReloads === 0 && suppressTimer) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
  }

  const startTime = Date.now();

  // Broadcast function (defined early so apiContext can reference it)
  const wsClients = new Set<import("ws").WebSocket>();
  const emit = (event: string, payload: unknown): void => {
    const message = JSON.stringify({ event, payload, ts: Date.now() });
    for (const client of wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (err) {
          logger.warn(`WebSocket send failed, removing dead client: ${err instanceof Error ? err.message : err}`);
          wsClients.delete(client);
        }
      }
    }
  };

  // Backstop for lost completion events: unstick sessions stuck at
  // status:"running" with no live turn (see status-reconciler.ts).
  const stopStatusReconciler = startStatusReconciler({ engines, emit });

  // --- Workflow engine (upstream port). Opt-in via config.workflows.enabled;
  // absent flag = no workflow DB, no trigger arming, no /api/workflows routes.
  // Constructed AFTER the server is listening (see below): the WorkflowService
  // constructor arms schedule triggers and a wake timer that can run recovery
  // immediately, and a recovered attempt may spawn an interactive PTY turn
  // whose Stop hook needs the gateway listening and gateway.json written.
  let workflowService: WorkflowService | undefined;

  // API context
  const apiContext: ApiContext = {
    config: currentConfig,
    sessionManager,
    startTime,
    getConfig: () => currentConfig,
    emit,
    connectors: connectorMap,
    reloadConnectorInstances,
    reloadAllConnectors,
    suppressNextConnectorReload,
    clearSuppressNextConnectorReload,
    hookRegistry,
    hookSecret: useInteractiveClaude ? hookSecret : undefined,
    authToken,
    authHome: JINN_HOME,
  };



  // NOTE: replaying pending web queue items is deferred until AFTER the server is
  // listening and gateway.json (port + hook secret) has been written — otherwise an
  // interactive (PTY) recovery turn could spawn before hook-relay.mjs can discover
  // the gateway, leaving its Stop hook undeliverable and the turn hung.

  // Resolve web UI directory — bundled into dist/web/ by postbuild script
  // At runtime __dirname is dist/src/gateway/, so ../../web resolves to dist/web/
  const webDir = path.resolve(__dirname, "..", "..", "web");

  // Loopback Host header guard.
  //
  // The gateway binds to 127.0.0.1 by default. A hostile browser tab can still
  // target local services through DNS rebinding, so reject requests whose
  // `Host` is not loopback, a local interface, or explicitly configured.
  const configuredHost = config.gateway.host || "127.0.0.1";
  const interfaceHosts = localInterfaceHosts();
  const connectUrl = localGatewayUrl(configuredHost, config.gateway.port || 7777);
  const configuredAllowedHosts = Array.isArray(currentConfig.gateway.allowedHosts) ? currentConfig.gateway.allowedHosts : [];
  const ignoredWildcardAllowedHosts = configuredAllowedHosts.filter((host) => isWildcardBindHost(host));
  if (ignoredWildcardAllowedHosts.length > 0) {
    logger.warn(
      `Ignoring wildcard value(s) in gateway.allowedHosts (${ignoredWildcardAllowedHosts.join(", ")}). `
        + `Wildcard bind addresses are never safe Host allowlist entries; connect to ${connectUrl} instead.`,
    );
  }
  // Publish the *connectable* URL to every child process we spawn (engine CLIs
  // inherit process.env via buildChildEnv). Skills and scripts should read
  // $RYOKO_GATEWAY_URL rather than hard-coding a host they can get wrong.
  process.env.RYOKO_GATEWAY_URL = connectUrl;
  function hostIsAllowed(req: http.IncomingMessage): boolean {
    return hostHeaderAllowed(req.headers.host, configuredHost, currentConfig.gateway.allowedHosts, interfaceHosts);
  }

  // A silent 421 is how this guard bites: a cron script gets an empty body, the
  // run is still recorded "success", and the Slack post just never happens. Say
  // out loud what was rejected and what to use instead — but only once per
  // distinct Host, so a hostile tab in a retry loop can't flood the log.
  const warnedRejectedHosts = new Set<string>();
  function warnHostRejected(hostHeader: string | undefined): void {
    const key = (hostHeader || "<missing>").toLowerCase().replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
    if (warnedRejectedHosts.has(key)) return;
    if (warnedRejectedHosts.size >= 50) return;
    warnedRejectedHosts.add(key);
    logger.warn(
      `host_not_allowed: rejected Host="${key}". `
        + `Connect to ${connectUrl} instead. Real proxy hostnames may be added to gateway.allowedHosts; wildcard bind addresses cannot.`,
    );
  }

  // Create HTTP server
  const server = http.createServer((req, res) => {
    const url = req.url || "/";

    // Host header check before anything else — applies to both API and
    // static asset paths so a malicious cross-origin browser tab can't
    // pull session JSON either.
    if (!hostIsAllowed(req)) {
      warnHostRejected(req.headers.host);
      res.writeHead(421, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "host_not_allowed",
        host: req.headers.host ?? null,
        hint: `Use ${connectUrl} — "${configuredHost}" is the bind address, not a connectable host. `
          + `Real proxy hostnames may be added to gateway.allowedHosts; wildcard bind addresses cannot.`,
      }));
      return;
    }

    const origin = req.headers.origin as string | undefined;
    if (!requestOriginAllowed(origin, req.headers.host, configuredHost)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "origin_not_allowed" }));
      return;
    }

    // The request has already passed the active Origin guard above. Reflecting
    // here enables legitimate same-origin/cross-spelling loopback clients.
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = url.split("?")[0];
    if (
      gatewayRequestNeedsAuth(authRequired, req.method, pathname)
      && !verifyGatewayAuth(req.headers, authToken, JINN_HOME)
    ) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="OpenRyoko"',
      });
      res.end(JSON.stringify({ error: "Missing or invalid gateway authentication" }));
      return;
    }

    // API routes
    if (url.startsWith("/api/")) {
      handleApiRequest(req, res, apiContext);
      return;
    }

    // Static files for web UI
    if (!serveStatic(req, res, webDir)) {
      if (url === "/" || url === "/index.html") {
        res.writeHead(503, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Web UI not built</h1><p>Run <code>pnpm build</code> from the project root to build the web UI.</p></body></html>");
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    }
  });

  // WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  // Dedicated WS server for per-session PTY streams (/ws/pty/:sessionId) — kept
  // separate from the global broadcast `wss` so its sockets aren't added to the
  // broadcast client set.
  const ptyWss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    logger.info(`WebSocket client connected (${wsClients.size} total)`);

    ws.on("close", () => {
      wsClients.delete(ws);
      logger.info(`WebSocket client disconnected (${wsClients.size} total)`);
    });

    ws.on("error", (err) => {
      logger.error(`WebSocket error: ${err.message}`);
      wsClients.delete(ws);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const reqUrl = req.url || "";
    // DNS-rebinding / cross-host guard — mirror the HTTP request path so a WS
    // upgrade can't bypass it. Applies to both /ws and /ws/pty.
    if (!hostIsAllowed(req)) { warnHostRejected(req.headers.host); socket.destroy(); return; }
    if (!requestOriginAllowed(req.headers.origin, req.headers.host, configuredHost)) { socket.destroy(); return; }
    if (authRequired && !verifyGatewayAuth(req.headers, authToken, JINN_HOME)) { socket.destroy(); return; }
    if (reqUrl === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    // Dedicated per-session PTY channel for the live xterm CLI view. Routes to the
    // session's OWN engine — no claude fallback (codex/gemini have no PTY view, and
    // the FE hides the CLI toggle for them, so this only refuses stragglers).
    const ptyMatch = reqUrl.split("?")[0].match(/^\/ws\/pty\/([^/]+)$/);
    if (ptyMatch) {
      // /ws/pty forwards stdin to the PTY — reject cross-site browser origins.
      let sessionId: string;
      try { sessionId = decodeURIComponent(ptyMatch[1]); } catch { socket.destroy(); return; }
      const ptySession = getSession(sessionId);
      const ptyEngine = ptySession ? ptyViewEngines[ptySession.engine] : undefined;
      if (!ptyEngine) { socket.destroy(); return; }
      ptyWss.handleUpgrade(req, socket, head, (ws) => {
        attachPtyWebSocket(ws, sessionId, ptyEngine);
      });
      return;
    }
    socket.destroy();
  });


  // Sync skill symlinks to .claude/skills/ and .agents/skills/
  syncSkillSymlinks();

  // Initialize STT model symlinks
  try {
    initStt();
  } catch (err) {
    logger.warn(`STT init skipped: ${err instanceof Error ? err.message : err}`);
  }

  // Start file watchers
  startWatchers({
    onConfigReload: () => {
      try {
        const previous = currentConfig;
        const previousWorkflowsEnabled = Boolean(currentConfig.workflows?.enabled);
        currentConfig = loadConfig();
        invalidateModelRegistry(); // rebuild the model/capability registry from the reloaded config
        apiContext.config = currentConfig;
        // Workflow engine is boot-time wiring. Disable takes effect immediately
        // (dispose stops schedule triggers and the runner; routes disappear with
        // the context entry); enable requires a restart.
        const workflowsEnabled = Boolean(currentConfig.workflows?.enabled);
        if (previousWorkflowsEnabled && !workflowsEnabled && workflowService) {
          try { workflowService.dispose(); } catch { /* best effort */ }
          try { apiContext.workflowDatabase?.close(); } catch { /* best effort */ }
          workflowService = undefined;
          apiContext.workflowService = undefined;
          apiContext.workflowDatabase = undefined;
          apiContext.workflowRepository = undefined;
          logger.info("Workflow engine disabled via config reload");
        } else if (!previousWorkflowsEnabled && workflowsEnabled && !workflowService) {
          logger.warn("config.workflows.enabled was turned on — restart the gateway to start the Workflow engine");
        }
        // Propagate the fresh config into SessionManager so new sessions
        // pick up edits to engines.default / portal.* / engine bin paths
        // even when the connectors block didn't change.
        sessionManager.setConfig(currentConfig);
        logger.info("Config reloaded successfully");
        emit("config:reloaded", {});

        // If the API just wrote this file (PUT /api/config) it has already
        // triggered reloadAllConnectors itself and may still be mid-reconnect.
        // Skip our reload to avoid stop→start→stop→start churn and the
        // race that comes with two overlapping reloads.
        if (suppressedWatcherConnectorReloads > 0) {
          suppressedWatcherConnectorReloads -= 1;
          if (suppressedWatcherConnectorReloads === 0 && suppressTimer) {
            clearTimeout(suppressTimer);
            suppressTimer = null;
          }
          logger.debug("Skipping watcher-triggered connector reload (an API write just reloaded connectors itself)");
          return;
        }

        // External edits to ~/.ryoko/config.yaml (vim, ryoko CLI, etc.) need
        // a connector refresh when either:
        //   (a) the connectors block changed, OR
        //   (b) portal.portalName/operatorName changed — Slack connectors
        //       capture those at construction so the live ones would keep
        //       triaging with the old portal identity until restart.
        //
        // Diff against lastConnectorReloadConfig (NOT `previous`) so that a
        // failed previous reload doesn't poison this comparison: if the
        // last successful reload was config v1 and we've since written v2
        // unsuccessfully, comparing v2-vs-v2 would skip the retry.
        const baseline = lastConnectorReloadConfig;
        const portalNamesChanged =
          baseline.portal?.portalName !== currentConfig.portal?.portalName ||
          baseline.portal?.operatorName !== currentConfig.portal?.operatorName;
        const connectorsChanged =
          JSON.stringify(baseline.connectors ?? null) !==
          JSON.stringify(currentConfig.connectors ?? null);
        if (connectorsChanged || portalNamesChanged) {
          reloadAllConnectors()
            .then((result) => {
              logger.info(
                `Connectors reloaded after config change — started=[${result.started.join(",")}] stopped=[${result.stopped.join(",")}] errors=${result.errors.length}`,
              );
              emit("connectors:reloaded", result);
            })
            .catch((err) => {
              logger.error(
                `reloadAllConnectors failed: ${err instanceof Error ? err.message : err}`,
              );
            });
        }
      } catch (err) {
        logger.error(
          `Failed to reload config: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    onCronReload: () => {
      const updatedJobs = loadJobs();
      reloadScheduler(updatedJobs);
      logger.info(`Cron jobs reloaded (${updatedJobs.length} job(s))`);
      emit("cron:reloaded", {});
    },
    onOrgChange: () => {
      employeeRegistry = scanOrg();
      logger.info(`Org directory changed, reloaded ${employeeRegistry.size} employee(s)`);
      emit("org:changed", {});
    },
    onSkillsChange: () => {
      logger.info("Skills changed, notifying clients");
      emit("skills:changed", {});
    },
  });

  // Start listening
  const port = config.gateway.port || 7777;
  const host = config.gateway.host || "127.0.0.1";

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const msg = `Port ${port} is already in use.`;
        logger.error(msg);
        console.error(`\nError: ${msg}`);
        console.error(`\nTry: ryoko start -p ${port + 1}`);
        console.error(`Or update the port in config.yaml\n`);
        process.exit(1);
      }
      reject(err);
    });
    server.listen(port, host, () => {
      logger.info(`${gatewayName} gateway listening on ${host}:${port} (boot ${bootId})`);
      if (isWildcardBindHost(host)) {
        // Wildcard/network binds are the case people get wrong: they copy the
        // bind address into a client URL and get 421'd by the guard above.
        logger.info(`Local clients must connect to ${localGatewayUrl(host, port)} — not http://${host}:${port}`);
      }
      resolve();
    });
  });

  // Publish gateway connection info (port + hook secret + pid) so hook-relay.mjs —
  // spawned by the interactive Claude PTY — can discover where to POST turn hooks.
  if (useInteractiveClaude) {
    try {
      writeGatewayInfo(GATEWAY_INFO_FILE, { port, pid: process.pid, secret: hookSecret });
    } catch (err) {
      logger.warn(`Failed to write ${GATEWAY_INFO_FILE}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Replay any pending web queue items (e.g. gateway restart mid-run). Deferred to
  // here so the server is listening and gateway.json exists before any interactive
  // recovery turn spawns — so hook-relay.mjs can deliver its Stop hook.
  resumePendingWebQueueItems(apiContext);

  // Workflow engine start, deferred to gateway readiness: constructing the
  // service arms schedule triggers and its wake timer, and both recovery paths
  // below can spawn engine turns — including interactive PTY turns whose Stop
  // hook needs the gateway listening and gateway.json written (same reason
  // resumePendingWebQueueItems above is deferred). The employee provider must
  // be wired before the first dispatch, and recover() must see the
  // redispatched sessions, so the order inside this block matters.
  if (currentConfig.workflows?.enabled) {
    sessionManager.setEmployeeProvider((id) => employeeRegistry.get(id));
    const workflowDatabase = openWorkflowDatabase();
    const workflowRepository = new WorkflowRepository(workflowDatabase);
    apiContext.workflowDatabase = workflowDatabase;
    apiContext.workflowRepository = workflowRepository;
    workflowService = new WorkflowService({
      repository: workflowRepository,
      executor: new WorkflowSessionExecutor(sessionManager, (id) => {
        const session = getSession(id);
        if (!session) return null;
        const finalText = [...getMessages(id)].reverse().find((message) => message.role === "assistant")?.content;
        return { session, ...(finalText ? { finalText } : {}) };
      }),
      employees: () => employeeRegistry,
      models: () => getModelRegistry(currentConfig),
      engineFallback: { chainFor: (engine) => (currentConfig.engines as unknown as Record<string, { fallback?: string[] } | undefined>)[engine]?.fallback ?? [] },
      sessionSpend: (sessionIds) => sessionIds.reduce((sum, id) => sum + (getSession(id)?.totalCost ?? 0), 0),
      readTranscript: (id) => getMessages(id).map(({ id: messageId, role, content, timestamp }) => ({ id: messageId, role, content, timestamp })),
      onChange: ({ workflowId, runId }) => emit("workflow:changed", { entity: "workflow-run", workflowId, runId }),
      onDefinitionChange: ({ workflowId, revision }) => emit("workflow:changed", { entity: "workflow-definition", id: workflowId, revision }),
    });
    apiContext.workflowService = workflowService;
    logger.info("Workflow engine enabled (config.workflows.enabled)");
    sessionManager.redispatchPendingWorkflowAttempts();
    try {
      await workflowService.recover(new Date().toISOString());
    } catch (error) {
      logger.error(`Workflow recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Notify connected WebSocket clients about interrupted sessions available for resume
  if (resumable.length > 0) {
    // Small delay to let WebSocket clients connect after server starts
    setTimeout(() => {
      emit("sessions:interrupted", {
        count: resumable.length,
        sessions: resumable.map((s) => ({
          id: s.id,
          engine: s.engine,
          employee: s.employee,
          title: s.title,
          lastActivity: s.lastActivity,
        })),
      });
    }, 1000);
  }

  // Prevent macOS from sleeping while the gateway is running
  let caffeinate: ChildProcess | null = null;
  if (process.platform === "darwin") {
    caffeinate = spawn("caffeinate", ["-s"], {
      stdio: "ignore",
      detached: false,
    });
    caffeinate.unref();
    caffeinate.on("error", (err) => {
      logger.warn(`caffeinate failed to start: ${err.message}`);
      caffeinate = null;
    });
    logger.info("caffeinate started — macOS sleep prevention active");
  }

  // Return cleanup function
  return async () => {
    logger.info("Gateway cleanup starting...");

    // Stop caffeinate
    if (caffeinate && caffeinate.exitCode === null) {
      caffeinate.kill();
      logger.info("caffeinate stopped");
    }

    // Mark all running sessions as "interrupted" before killing engine processes.
    // This preserves their engine_session_id so they can be resumed on next startup.
    // Workflow attempts get the SAME sweep the next boot would run: it cancels
    // their internal queue rows and stamps the durable `gateway-restart`
    // receipt in one transaction. A plain interrupt receipt would classify as
    // `attempt-stop` on the next boot (workflowAttemptInterruptionCause's
    // fallback) — an operator stop, which is not retryable — and a graceful
    // shutdown would fail the runs it merely paused.
    const stoppedWorkflowAttempts = recoverStaleWorkflowAttemptSessions();
    if (stoppedWorkflowAttempts > 0) {
      logger.info(`Marked ${stoppedWorkflowAttempts} workflow attempt(s) with gateway-restart receipts for replacement on next boot`);
    }
    const runningSessions = listSessions({ status: "running" });
    for (const session of runningSessions) {
      if (session.workflowProvenance?.kind === "phase") continue; // handled by the sweep above
      updateSession(session.id, {
        status: "interrupted",
        lastActivity: new Date().toISOString(),
        lastError: "Interrupted: gateway shutting down gracefully",
      });
      logger.info(`Marked session ${session.id} as interrupted for resume`);
    }

    // Terminate live engine subprocesses after marking sessions. When interactive
    // is active, interactiveClaudeEngine.killAll() also kills its headless fallback
    // (the same claudeEngine), so call only one to avoid a redundant double-kill.
    if (interactiveClaudeEngine) {
      interactiveClaudeEngine.killAll();
      claudeLifecycle?.dispose();
      try { stopStatusReconciler(); } catch { /* best effort */ }
      try { hookRegistry?.dispose(); } catch { /* best effort */ }
      try { fs.rmSync(GATEWAY_INFO_FILE, { force: true }); } catch { /* best effort */ }
    } else {
      claudeEngine.killAll();
    }
    codexEngine.killAll();

    // Stop workflow triggers/runner before cron
    try { workflowService?.dispose(); } catch { /* best effort */ }

    // Stop cron scheduler
    stopScheduler();

    // Stop connectors
    for (const connector of connectors) {
      try {
        await connector.stop();
      } catch (err) {
        logger.error(`Failed to stop ${connector.name} connector: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Stop watchers
    await stopWatchers();

    // Close WebSocket connections
    for (const client of wsClients) {
      client.close(1001, "Server shutting down");
    }
    wsClients.clear();

    // Close the per-session PTY WS sockets + server too (separate from `wss`).
    for (const client of ptyWss.clients) {
      try { client.close(1001, "Server shutting down"); } catch { /* already closing */ }
    }

    // Close WebSocket servers
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => ptyWss.close(() => resolve()));

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info("Gateway shutdown complete");
  };
}
