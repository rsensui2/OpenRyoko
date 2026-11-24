import type { JinnConfig } from "./types.js";

type EngineBlock = { bin: string; model: string; effortLevel?: string; childEffortOverride?: string };

/** Used when config.yaml has no `engines.antigravity` block: agy on PATH with its
 *  default model — so picking the engine needs no hand-written config. */
export const ANTIGRAVITY_DEFAULTS: EngineBlock = { bin: "agy", model: "gemini-3.8-flash-medium" };

/**
 * The `engines.<name>` block a session of `engine` runs with. An unconfigured
 * Gemini falls back to the Claude block, as before; Antigravity to its defaults.
 */
function definedKeys<T extends object>(block: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(block ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== "")) as Partial<T>;
}

export function engineConfigFor(config: JinnConfig, engine: string | undefined): EngineBlock {
  switch (engine) {
    case "codex": return config.engines.codex;
    case "gemini": return config.engines.gemini ?? config.engines.claude;
    // A block may set only some keys (e.g. just the model); the rest come from the defaults.
    case "antigravity": return { ...ANTIGRAVITY_DEFAULTS, ...definedKeys(config.engines.antigravity) };
    default: return config.engines.claude;
  }
}
