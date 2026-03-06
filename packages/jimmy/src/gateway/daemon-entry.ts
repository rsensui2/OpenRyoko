/**
 * Entry point for the daemon child process.
 * Spawned by lifecycle.ts startDaemon().
 */
import { loadConfig } from "../shared/config.js";
import { startForeground } from "./lifecycle.js";

const config = loadConfig();
startForeground(config).catch((err) => {
  console.error("Daemon failed to start:", err);
  process.exit(1);
});
