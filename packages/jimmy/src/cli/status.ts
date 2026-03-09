import { getStatus } from "../gateway/lifecycle.js";
import { loadConfig } from "../shared/config.js";
import { JIMMY_HOME, PID_FILE } from "../shared/paths.js";
import fs from "node:fs";

export async function runStatus(): Promise<void> {
  if (!fs.existsSync(JIMMY_HOME)) {
    console.log("Gateway is not set up. Run \"jimmy setup\" first.");
    return;
  }

  const status = getStatus();

  if (!status.running) {
    console.log("Gateway: stopped");
    if (status.pid) {
      console.log(`  Stale PID file found (PID ${status.pid}). Process is not alive.`);
    }
    return;
  }

  console.log("Gateway: running");
  console.log(`  PID: ${status.pid}`);

  // Try to get uptime from PID file mtime
  try {
    const stat = fs.statSync(PID_FILE);
    const uptimeMs = Date.now() - stat.mtimeMs;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    console.log(`  Uptime: ${hours}h ${minutes}m ${seconds}s`);
  } catch {
    // ignore
  }

  // Try to get live stats from the gateway
  try {
    const config = loadConfig();
    const url = `http://${config.gateway.host}:${config.gateway.port}/api/status`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      console.log(`  Port: ${config.gateway.port}`);
      if (data.sessions !== undefined) {
        console.log(`  Active sessions: ${data.sessions}`);
      }
      if (data.uptime !== undefined) {
        console.log(`  Server uptime: ${data.uptime}s`);
      }
    }
  } catch {
    // Gateway not responding to HTTP, that's fine
    try {
      const config = loadConfig();
      console.log(`  Port: ${config.gateway.port} (not responding to HTTP)`);
    } catch {
      // no config
    }
  }
}
