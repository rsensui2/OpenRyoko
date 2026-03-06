import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { JimmyConfig } from "../shared/types.js";
import { loadConfig } from "../shared/config.js";
import { configureLogger, logger } from "../shared/logger.js";
import { initDb } from "../sessions/registry.js";
import { SessionManager } from "../sessions/manager.js";
import { ClaudeEngine } from "../engines/claude.js";
import { CodexEngine } from "../engines/codex.js";
import { handleApiRequest, type ApiContext } from "./api.js";
import { startWatchers, stopWatchers } from "./watcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  let filePath = path.join(webDir, req.url || "/");
  if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");

  // Prevent directory traversal
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(webDir))) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
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
  config: JimmyConfig,
): Promise<GatewayCleanup> {
  // Configure logging
  configureLogger({
    level: config.logging.level,
    stdout: config.logging.stdout,
    file: config.logging.file,
  });

  logger.info("Starting Jimmy gateway...");

  // Initialize database
  initDb();

  // Set up engines
  const engines = new Map<string, InstanceType<typeof ClaudeEngine> | InstanceType<typeof CodexEngine>>();
  engines.set("claude", new ClaudeEngine());
  engines.set("codex", new CodexEngine());

  // Session manager
  const sessionManager = new SessionManager(config, engines);

  // Mutable config reference for hot-reload
  let currentConfig = config;

  const startTime = Date.now();

  // API context
  const apiContext: ApiContext = {
    config: currentConfig,
    sessionManager,
    startTime,
    getConfig: () => currentConfig,
  };

  // Resolve web UI directory (may not exist yet)
  const webDir = path.resolve(__dirname, "..", "..", "web");

  // Create HTTP server
  const server = http.createServer((req, res) => {
    const url = req.url || "/";

    // CORS headers for development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (url.startsWith("/api/")) {
      handleApiRequest(req, res, apiContext);
      return;
    }

    // Static files for web UI
    if (!serveStatic(req, res, webDir)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  // WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    logger.info(`WebSocket client connected (${clients.size} total)`);

    ws.on("close", () => {
      clients.delete(ws);
      logger.info(`WebSocket client disconnected (${clients.size} total)`);
    });

    ws.on("error", (err) => {
      logger.error(`WebSocket error: ${err.message}`);
      clients.delete(ws);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // Broadcast function
  const emit = (event: string, payload: unknown): void => {
    const message = JSON.stringify({ event, payload, ts: Date.now() });
    for (const client of clients) {
      if (client.readyState === 1) {
        // WebSocket.OPEN
        client.send(message);
      }
    }
  };

  // Start file watchers
  startWatchers({
    onConfigReload: () => {
      try {
        currentConfig = loadConfig();
        apiContext.config = currentConfig;
        logger.info("Config reloaded successfully");
        emit("config:reloaded", {});
      } catch (err) {
        logger.error(
          `Failed to reload config: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    onCronReload: () => {
      logger.info("Cron jobs reloaded");
      emit("cron:reloaded", {});
      // TODO: integrate with cron scheduler in Task 6.1
    },
    onOrgChange: () => {
      logger.info("Org directory changed");
      emit("org:changed", {});
      // TODO: integrate with employee registry in Task 7.1
    },
  });

  // Start listening
  const port = config.gateway.port || 7777;
  const host = config.gateway.host || "127.0.0.1";

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      logger.info(`Jimmy gateway listening on http://${host}:${port}`);
      resolve();
    });
  });

  // Return cleanup function
  return async () => {
    logger.info("Gateway cleanup starting...");

    // Stop watchers
    await stopWatchers();

    // Close WebSocket connections
    for (const client of clients) {
      client.close(1001, "Server shutting down");
    }
    clients.clear();

    // Close WebSocket server
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info("Gateway shutdown complete");
  };
}
