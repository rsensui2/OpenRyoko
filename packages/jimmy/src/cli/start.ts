import fs from "node:fs";
import { JIMMY_HOME } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { startForeground, startDaemon } from "../gateway/lifecycle.js";

export async function runStart(opts: { daemon?: boolean }): Promise<void> {
  if (!fs.existsSync(JIMMY_HOME)) {
    console.error(
      `Error: ${JIMMY_HOME} does not exist. Run "jimmy setup" first.`
    );
    process.exit(1);
  }

  const config = loadConfig();

  if (opts.daemon) {
    startDaemon(config);
    console.log("Gateway started in background.");
  } else {
    console.log(
      `Starting gateway on ${config.gateway.host}:${config.gateway.port}...`
    );
    await startForeground(config);
  }
}
