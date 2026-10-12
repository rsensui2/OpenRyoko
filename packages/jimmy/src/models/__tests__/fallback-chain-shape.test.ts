import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_PATH, CRON_JOBS, JINN_HOME, ORG_DIR } from "../../shared/paths.js";
import { invalidateModelRegistry, setDiscoveredModels } from "../../shared/models.js";
import type { JinnConfig } from "../../shared/types.js";
import { ModelManagement } from "../service.js";

/**
 * `engines.<name>.fallback` is hand-editable YAML. The session layer treats a
 * chain that is not a list as no chain (and the gateway warns about it at
 * startup). Model management read the same field as if it were always a list,
 * so one stray scalar there broke `/api/models` and the Slack model controls.
 */

let config: JinnConfig;
const make = () => new ModelManagement({ getConfig: () => config, onConfig: (next) => { config = next; },
  discover: vi.fn(async () => []), notify: vi.fn(async () => true) });

/** Put a chain of any shape on both engines, in memory and in the file `act` edits. */
function withChains(codexChain: unknown, claudeChain: unknown): void {
  (config.engines.codex as unknown as { fallback: unknown }).fallback = codexChain;
  (config.engines.claude as unknown as { fallback: unknown }).fallback = claudeChain;
  fs.writeFileSync(CONFIG_PATH, yaml.dump(config));
}

beforeEach(() => {
  fs.rmSync(path.join(JINN_HOME, "models"), { force: true, recursive: true });
  fs.rmSync(ORG_DIR, { force: true, recursive: true });
  fs.mkdirSync(ORG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(CRON_JOBS), { recursive: true });
  fs.writeFileSync(CRON_JOBS, "[]");
  config = { engines: { default: "codex", codex: { bin: "codex", model: "gpt-5.6-sol" }, claude: { bin: "claude", model: "claude-opus-5" } },
    gateway: { host: "127.0.0.1", port: 0 }, connectors: {}, logging: { file: false, stdout: false, level: "error" } };
  fs.writeFileSync(CONFIG_PATH, yaml.dump(config));
  invalidateModelRegistry();
  setDiscoveredModels("codex", []);
  setDiscoveredModels("claude", []);
});

describe("model management — a fallback chain that is not a list", () => {
  it.each([
    ["a number", 5],
    ["a mapping", { claude: true }],
    ["a boolean", true],
    ["a bare engine name", "claude"],
  ])("reports fallback as off for %s instead of failing the whole snapshot", (_label, chain) => {
    withChains(chain, ["codex"]);

    const snapshot = make().snapshot();

    expect(snapshot.fallbackEnabled).toBe(false);
    expect(snapshot.engines.map((engine) => engine.engine)).toEqual(["codex", "claude"]);
  });

  it("still reports fallback as on when both chains are well formed", () => {
    withChains(["claude"], ["codex"]);

    expect(make().snapshot().fallbackEnabled).toBe(true);
  });

  it.each([
    ["a number", 5],
    ["a mapping", { claude: true }],
    ["a bare engine name", "claude"],
  ])("replaces %s with a proper chain when fallback is switched on", async (_label, chain) => {
    withChains(chain, chain);
    const service = make();

    await service.act({ action: "fallback", enabled: true });

    expect(config.engines.codex.fallback).toEqual(["claude"]);
    expect(config.engines.claude.fallback).toEqual(["codex"]);
    expect(service.snapshot().fallbackEnabled).toBe(true);
  });

  it("keeps the other engines a well-formed chain already named when fallback is switched on", async () => {
    withChains(["gemini"], ["codex", "gemini"]);

    await make().act({ action: "fallback", enabled: true });

    expect(config.engines.codex.fallback).toEqual(["claude", "gemini"]);
    expect(config.engines.claude.fallback).toEqual(["codex", "gemini"]);
  });
});
