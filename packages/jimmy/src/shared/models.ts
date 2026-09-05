import type {
  JinnConfig,
  ModelInfo,
  ModelRegistry,
  EngineRegistryEntry,
  EffortMechanism,
  EngineModelsConfig,
} from "./types.js";

/**
 * Model + capability registry — the single source of truth for which engines and
 * models exist and what they support (effort levels). Built from the
 * optional `models:` block in config.yaml; when that block is absent (or an engine
 * is missing from it) the entry combines `engines.<name>.model` with built-in
 * model capabilities so existing configs keep working. An explicit `models:`
 * block remains authoritative; custom models can be added without code changes.
 */

/** Engines registered in this build (mirrors server.ts engine map). */
export const ENGINE_NAMES = ["claude", "codex", "gemini"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

export function isKnownEngine(engine: string): engine is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(engine);
}

const EFFORT_MECHANISM: Record<EngineName, EffortMechanism> = {
  claude: "claude-flag",
  codex: "codex-config",
  gemini: "none",
};

/** Conservative per-engine defaults used when synthesizing (no `models:` block). */
const SYNTH_DEFAULTS: Record<EngineName, { supportsEffort: boolean; effortLevels: string[]; fallbackModel: string }> = {
  claude: { supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"], fallbackModel: "claude-opus-5" },
  codex: { supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"], fallbackModel: "gpt-5.6-sol" },
  gemini: { supportsEffort: false, effortLevels: [], fallbackModel: "gemini-2.5-pro" },
};

/** Published capabilities, not a guarantee of access on the connected account.
 * https://developers.openai.com/api/docs/models/gpt-6-astra
 * https://platform.claude.com/docs/en/models/fable-5-1/overview
 * https://code.claude.com/docs/en/model-config#adjust-effort-level */
const BUILTIN_MODELS: Partial<Record<EngineName, ModelInfo[]>> = {
  claude: [{
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    contextWindow: 1_000_000,
  }],
  codex: [{
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    supportsEffort: true,
    effortLevels: ["low", "medium", "high", "xhigh", "max"],
    contextWindow: 1_050_000,
  }],
};

/**
 * Whether a Claude model supports the `xhigh` effort level. `xhigh` landed on
 * Opus 4.7 and Sonnet 5; Haiku-tier and *older* Opus/Sonnet (Opus ≤4.6,
 * Sonnet ≤4.6) reject it. The bare aliases `opus`/`sonnet` resolve to the
 * latest model, which supports it. Anything unrecognized is treated as
 * unsupported (conservative), so `resolveEffort` clamps it instead of passing
 * a broken `--effort xhigh` to the CLI.
 */
function claudeSupportsXhigh(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (id.includes("haiku")) return false;
  if (id === "opus" || id === "sonnet") return true; // aliases → latest model
  if (/opus-4-(?:[7-9]|\d\d)/.test(id)) return true; // Opus 4.7+ (incl. 4.10+)
  if (/opus-(?:[5-9]|\d\d)/.test(id)) return true; //  Opus 5+
  if (/sonnet-(?:[5-9]|\d\d)/.test(id)) return true; // Sonnet 5+
  return false;
}

/**
 * Effort levels for a synthesized Claude model. Offering `xhigh` on a model
 * that rejects it would let a config default flow through as `--effort xhigh`
 * and break the run, so narrow by capability.
 */
function claudeEffortLevels(modelId: string): string[] {
  const base = ["low", "medium", "high"];
  return claudeSupportsXhigh(modelId) ? [...base, "xhigh"] : base;
}

/** Effort levels a synthesized (no `models:` block) entry gives a specific model. */
function synthEffortLevels(engine: EngineName, modelId: string): string[] {
  const known = BUILTIN_MODELS[engine]?.find((model) => model.id === modelId);
  if (known) return [...known.effortLevels];
  const d = SYNTH_DEFAULTS[engine];
  if (!d.supportsEffort) return [];
  return engine === "claude" ? claudeEffortLevels(modelId) : [...d.effortLevels];
}

function isEngineName(engine: string): engine is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(engine);
}

let cached: ModelRegistry | null = null;

/** Clear the cached registry. Call on config reload / PUT /api/config. */
export function invalidateModelRegistry(): void {
  cached = null;
}

/** Resolve the registry (cached). Pass the current config; cache is keyed by
 *  invalidation, not by config identity — call invalidateModelRegistry() to refresh. */
export function getModelRegistry(config: JinnConfig): ModelRegistry {
  if (!cached) cached = buildRegistry(config);
  return cached;
}

/**
 * Valid effort levels for a session's engine+model, from the registry.
 * Returns [] when the engine/model doesn't support effort (e.g. gemini) or
 * the engine is unknown. `modelId` defaults to the engine's default model.
 */
export function effortLevelsForModel(config: JinnConfig, engine: string, modelId?: string): string[] {
  const entry = getModelRegistry(config)[engine];
  if (!entry) return [];

  const exact = modelId ? entry.models.find((m) => m.id === modelId) : undefined;
  if (exact) return exact.supportsEffort ? [...exact.effortLevels] : [];

  // modelId not in the registry (e.g. a session overrides the engine model to
  // one that isn't the config default). For a SYNTHESIZED engine (no explicit
  // `models:` block) compute levels for THIS model rather than borrowing the
  // default model's — otherwise a haiku session inherits opus's `xhigh` and
  // passes an unsupported `--effort xhigh` through. When a `models:` block
  // exists the user declared exact levels, so keep the default-model fallback.
  if (modelId && isEngineName(engine) && !config.models?.[engine]) {
    return synthEffortLevels(engine, modelId);
  }

  const fallback = entry.models.find((m) => m.id === entry.defaultModel) ?? entry.models[0];
  return fallback?.supportsEffort ? [...fallback.effortLevels] : [];
}

/** Context window (tokens) for a session's engine+model, or undefined if unknown. */
export function contextWindowForModel(config: JinnConfig, engine: string, modelId?: string): number | undefined {
  const entry = getModelRegistry(config)[engine];
  if (!entry) return undefined;
  const model =
    (modelId ? entry.models.find((m) => m.id === modelId) : undefined) ??
    entry.models.find((m) => m.id === entry.defaultModel) ??
    entry.models[0];
  return model?.contextWindow;
}

/** Build the registry without touching the cache (used by getModelRegistry + tests). */
export function buildRegistry(config: JinnConfig): ModelRegistry {
  const synthesized = synthesizeFromEngineConfig(config);
  const block = config.models;
  if (!block) return synthesized;

  const registry: ModelRegistry = {};
  for (const name of ENGINE_NAMES) {
    const engineBlock = block[name];
    registry[name] = engineBlock
      ? fromEngineModelsConfig(name, engineBlock)
      : synthesized[name]; // engine omitted from the block → keep the synthesized entry
  }
  return registry;
}

/** Keep the configured default first and add built-in models without duplicates. */
export function synthesizeFromEngineConfig(config: JinnConfig): ModelRegistry {
  const registry: ModelRegistry = {};
  for (const name of ENGINE_NAMES) {
    const defaults = SYNTH_DEFAULTS[name];
    const engineCfg = (config.engines as unknown as Record<string, { model?: string } | undefined>)[name];
    const modelId = engineCfg?.model || defaults.fallbackModel;
    const builtins = BUILTIN_MODELS[name] ?? [];
    const known = builtins.find((model) => model.id === modelId);
    const model: ModelInfo = {
      id: modelId,
      label: known?.label ?? modelId,
      supportsEffort: known?.supportsEffort ?? defaults.supportsEffort,
      effortLevels: synthEffortLevels(name, modelId),
      ...(known?.contextWindow !== undefined ? { contextWindow: known.contextWindow } : {}),
    };
    registry[name] = {
      name,
      available: true,
      defaultModel: modelId,
      effortMechanism: EFFORT_MECHANISM[name],
      models: [model, ...builtins.filter((candidate) => candidate.id !== modelId)
        .map((candidate) => ({ ...candidate, effortLevels: [...candidate.effortLevels] }))],
    };
  }
  return registry;
}

function fromEngineModelsConfig(name: EngineName, block: EngineModelsConfig): EngineRegistryEntry {
  const models: ModelInfo[] = (block.models ?? []).map((m) => {
    const supportsEffort = m.supportsEffort ?? false;
    return {
      id: m.id,
      label: m.label || m.id,
      supportsEffort,
      effortLevels: supportsEffort ? (m.effortLevels ?? []) : [],
      ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
    };
  });
  const defaultModel = block.default || models[0]?.id || SYNTH_DEFAULTS[name].fallbackModel;
  return {
    name,
    available: true,
    defaultModel,
    effortMechanism: block.effortMechanism ?? EFFORT_MECHANISM[name],
    models,
  };
}
