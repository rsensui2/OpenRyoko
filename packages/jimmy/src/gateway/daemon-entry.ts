/**
 * Entry point for the daemon child process.
 * Spawned by lifecycle.ts startDaemon().
 */
import { loadConfig } from "../shared/config.js";
import { installProcessSafetyNet } from "../shared/process-safety-net.js";
import { startForeground } from "./lifecycle.js";

const config = loadConfig();
// stdio is ignored in daemon mode, so a fault that escapes every handler would
// otherwise end the daemon without a trace. Installed after the config is read:
// a config that cannot be loaded should still stop the daemon.
installProcessSafetyNet();
startForeground(config).catch((err) => {
  console.error("Daemon failed to start:", err);
  process.exit(1);
});
