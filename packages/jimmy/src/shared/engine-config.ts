import type { JinnConfig } from "./types.js";

type EngineBlock = { bin: string; model: string; effortLevel?: string; childEffortOverride?: string };

/** Used when config.yaml has no `engines.antigravity` block: agy on PATH with its
 *  default model — so picking the engine needs no hand-written config. */
export const ANTIGRAVITY_DEFAULTS: EngineBlock = { bin: "agy", model: "gemini-3.8-flash-medium" };

/**
 * The `engines.<name>` block a session of `engine` runs with. An unconfigured
 * Gemini falls back to the Claude block, as before; Antigravity to its defaults.
 */
export function engineConfigFor(config: JinnConfig, engine: string | undefined): EngineBlock {
  switch (engine) {
    case "codex": return config.engines.codex;
    case "gemini": return config.engines.gemini ?? config.engines.claude;
    case "antigravity": return config.engines.antigravity ?? ANTIGRAVITY_DEFAULTS;
    default: return config.engines.claude;
  }
}
