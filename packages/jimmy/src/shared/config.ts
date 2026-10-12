import fs from "node:fs";
import yaml from "js-yaml";
import { ConfigSyntaxError } from "./config-error.js";
import { CONFIG_PATH } from "./paths.js";
import type { JinnConfig } from "./types.js";

export function loadConfig(): JinnConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Ryoko config not found at ${CONFIG_PATH}. Run "ryoko setup" first.`
    );
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  try {
    return yaml.load(raw) as JinnConfig;
  } catch (err) {
    // Whatever is thrown here gets logged, printed and returned by API routes
    // all over the gateway, and js-yaml's error quotes the file: see
    // ConfigSyntaxError. Fixed here, once, rather than at every caller.
    throw new ConfigSyntaxError(err);
  }
}
