import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PID_FILE } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { JimmyConfig } from "../shared/types.js";
import { startGateway } from "./server.js";

export async function startForeground(config: JimmyConfig): Promise<void> {
  const cleanup = await startGateway(config);

  const shutdown = async () => {
    logger.info("Shutting down gateway...");
    await cleanup();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export function startDaemon(config: JimmyConfig): void {
  const __filename = fileURLToPath(import.meta.url);
  const entryScript = path.resolve(
    path.dirname(__filename),
    "..",
    "..",
    "dist",
    "src",
    "gateway",
    "daemon-entry.js",
  );

  // Fork a child process that will run the gateway
  const child = fork(entryScript, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });

  if (child.pid) {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));
    logger.info(`Gateway daemon started with PID ${child.pid}`);
  }

  child.unref();
}

export function stop(): boolean {
  if (!fs.existsSync(PID_FILE)) {
    logger.warn("No PID file found. Gateway may not be running.");
    return false;
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);

  try {
    process.kill(pid, "SIGTERM");
    logger.info(`Sent SIGTERM to gateway process ${pid}`);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      logger.warn(`Process ${pid} not found. Cleaning up stale PID file.`);
    } else {
      throw err;
    }
  }

  fs.unlinkSync(PID_FILE);
  return true;
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
}

export function getStatus(): GatewayStatus {
  if (!fs.existsSync(PID_FILE)) {
    return { running: false, pid: null };
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Process not alive, stale PID file
    return { running: false, pid };
  }
}
