import type { JinnConfig } from "./types.js";

type EngineBlock = { bin: string; model: string; effortLevel?: string; childEffortOverride?: string };

/**
 * The `engines.<name>` block a session of `engine` runs with. An optional
 * engine that is not configured falls back to the Claude block, as before.
 */
export function engineConfigFor(config: JinnConfig, engine: string | undefined): EngineBlock {
  switch (engine) {
    case "codex": return config.engines.codex;
    case "gemini": return config.engines.gemini ?? config.engines.claude;
    case "antigravity": return config.engines.antigravity ?? config.engines.claude;
    default: return config.engines.claude;
  }
}
