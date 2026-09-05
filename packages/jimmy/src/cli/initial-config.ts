import fs from "node:fs";
import path from "node:path";
import { TEMPLATE_DIR } from "../shared/paths.js";
import { getPackageVersion } from "../shared/version.js";

/** The packaged template's file name is config.default.yaml — keep this
 *  lookup in sync with template/, or fresh setups lose the documented
 *  defaults (mcp, portal, connectors guidance). */
export const CONFIG_TEMPLATE_PATH = path.join(TEMPLATE_DIR, "config.default.yaml");

/**
 * Build the config.yaml contents for a fresh setup: the packaged template
 * with the package version stamped and the interactive choices applied.
 * The template ships in the npm package (`files` includes `template/`), so
 * a missing file means a corrupt install — fail loudly instead of silently
 * generating a divergent config.
 */
export function buildInitialConfig(
  chosenEngine: "claude" | "codex",
  chosenName: string,
): string {
  if (!fs.existsSync(CONFIG_TEMPLATE_PATH)) {
    throw new Error(
      `config テンプレートが見つかりません: ${CONFIG_TEMPLATE_PATH}\n` +
        `パッケージが壊れている可能性があります。npm install -g openryoko で再インストールしてください。`,
    );
  }
  let source = fs.readFileSync(CONFIG_TEMPLATE_PATH, "utf-8");

  // Replacer functions throughout — replacement *strings* would expand
  // `$&`-style patterns hidden in user-provided names.
  source = source.replace(/version:\s*"[^"]*"/, () => `version: "${getPackageVersion()}"`);
  source = source.replace(/default:\s*claude/, () => `default: ${chosenEngine}`);

  if (chosenName !== "Ryoko") {
    // JSON.stringify yields a valid YAML double-quoted scalar for any name,
    // including quotes and backslashes.
    const quoted = JSON.stringify(chosenName);
    if (source.includes("portalName: Ryoko")) {
      source = source.replace("portalName: Ryoko", () => `portalName: ${quoted}`);
    } else {
      source = source.replace("portal: {}", () => `portal:\n  portalName: ${quoted}`);
    }
  }

  return source;
}
