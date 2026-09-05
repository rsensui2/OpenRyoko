import {
  blankSourceProblem,
  malformedSourceProblem,
  malformedTargetProblem,
  malformedTargetWarning,
  mapNotAMappingProblem,
  targetNotAModelIdProblem,
  unservedTargetWarning,
} from "./fallback-map-wire.js";
import { logger } from "./logger.js";
import { isSpellableModelId } from "./model-id.js";
import { ENGINE_NAMES, isKnownEngine, type EngineName } from "./models.js";
import type { JinnConfig, ModelRegistry } from "./types.js";

const KNOWN_ENGINES = ENGINE_NAMES.join(", ");

/**
 * Problems with the `fallback` chains under an `engines` mapping (empty = valid).
 * Unknown names and self-references are refused because a chain naming a typo would
 * fail silently — it simply never fires — rather than loudly. Cycles across engines
 * are deliberately accepted: they are how "either of these two" reads in config, and
 * the runtime walker carries a visited set.
 */
export function validateEngineFallbackChains(engines: Record<string, unknown>): string[] {
  const problems: string[] = [];

  for (const name of ENGINE_NAMES) {
    const section = engines[name];
    if (typeof section !== "object" || section === null || Array.isArray(section)) continue;

    const chain = (section as { fallback?: unknown }).fallback;
    if (chain === undefined) continue;
    if (!Array.isArray(chain)) {
      problems.push(`engines.${name}.fallback must be a list of engine names (got ${typeof chain})`);
      continue;
    }

    chain.forEach((entry, index) => {
      if (typeof entry !== "string") {
        problems.push(`engines.${name}.fallback[${index}] must be a string (got ${typeof entry})`);
      } else if (entry === name) {
        problems.push(`engines.${name}.fallback must not name ${name} itself`);
      } else if (!isKnownEngine(entry)) {
        problems.push(`engines.${name}.fallback[${index}] "${entry}" is not a known engine (${KNOWN_ENGINES})`);
      }
    });
  }

  return problems;
}

/** A YAML mapping, as opposed to a scalar, a list, or a key left with no value. */
function isYamlMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Problems with the entries of one engine's map, which is already a mapping. */
function modelMapEntryProblems(engine: string, map: Record<string, unknown>): string[] {
  const problems: string[] = [];

  for (const [from, to] of Object.entries(map)) {
    // YAML hands every key over as a string, so a blank one is the only way to
    // write a key with no id in it at all — and a control character is the only
    // way to write one that LOOKS like an id and can never match.
    if (!from.trim()) {
      problems.push(blankSourceProblem(engine));
    } else if (!isSpellableModelId(from)) {
      problems.push(malformedSourceProblem(engine, from));
    }
    if (typeof to !== "string" || !to.trim()) {
      problems.push(targetNotAModelIdProblem(engine, from, to));
    } else if (!isSpellableModelId(to)) {
      problems.push(malformedTargetProblem(engine, from, to));
    }
  }

  return problems;
}

/**
 * Problems with the `fallbackModelMap` tables under an `engines` mapping (empty = valid).
 * The map is read with the pinned model as the key at the moment of a swap, so an entry
 * that is not a model id on both sides is one that can never match — refused here rather
 * than left to look like a mapping that simply never fires.
 */
export function validateEngineFallbackModelMaps(engines: Record<string, unknown>): string[] {
  const problems: string[] = [];

  for (const name of ENGINE_NAMES) {
    const section = engines[name];
    if (!isYamlMapping(section)) continue;

    const map = section.fallbackModelMap;
    if (map === undefined) continue;
    if (!isYamlMapping(map)) {
      problems.push(mapNotAMappingProblem(name, map));
      continue;
    }

    problems.push(...modelMapEntryProblems(name, map));
  }

  return problems;
}

/**
 * The model a turn should run on once its engine has been substituted.
 *
 * `undefined` is the floor rule and the default answer: drop the pin, let the
 * substitute's own configured default apply. A model id belongs to exactly one
 * provider, so carrying one across a swap is how a codex pin reached Anthropic and
 * came back `model_not_found`. `engines.<from>.fallbackModelMap` is the only way a
 * pin survives — and only when the substitute actually serves what the map names,
 * because a map that could name anything would just spell the same bug in config.
 * An entry validation never saw, because it predates the check or was written by
 * hand, is refused here too rather than handed to a CLI as an argv.
 */
export function resolveSubstituteModel(
  config: JinnConfig,
  registry: ModelRegistry,
  { from, to, model }: { from: string; to: string; model: string | null | undefined },
): string | undefined {
  if (!model) return undefined;

  const mapped = config.engines[from as EngineName]?.fallbackModelMap?.[model];
  if (!mapped) return undefined;
  if (!isSpellableModelId(mapped)) {
    logger.warn(malformedTargetWarning({ engine: from, model, target: mapped, substitute: to }));
    return undefined;
  }
  if (registry[to]?.models.some((candidate) => candidate.id === mapped)) return mapped;

  logger.warn(unservedTargetWarning({ engine: from, model, target: mapped, substitute: to }));
  return undefined;
}

// Warn once per mapped engine: loadConfig() runs again on every config hot-reload, so
// one legacy config would otherwise repeat itself through the whole gateway lifetime.
const warnedLegacyFallbackEngines = new Set<string>();

/**
 * Map the deprecated `sessions.rateLimitStrategy: "fallback"` / `sessions.fallbackEngine`
 * pair onto `engines.claude.fallback`, in place. An explicit chain always wins, an
 * explicit empty one included — that is an operator saying "no fallback" in the current
 * spelling. Both legacy keys are left on the config so whatever still reads them keeps
 * behaving exactly as it did.
 */
export function applyLegacyFallbackMigration(
  config: JinnConfig,
  warn: (message: string) => void = console.warn,
): void {
  if (config.sessions?.rateLimitStrategy !== "fallback") return;
  if (config.engines.claude.fallback !== undefined) return;

  const engine: EngineName = config.sessions.fallbackEngine ?? "codex";
  config.engines.claude.fallback = [engine];

  if (warnedLegacyFallbackEngines.has(engine)) return;
  warnedLegacyFallbackEngines.add(engine);
  warn(
    `sessions.rateLimitStrategy and sessions.fallbackEngine are deprecated — ` +
      `write engines.claude.fallback: [${engine}] instead.`,
  );
}

function fallbackChain(config: JinnConfig, engine: string): EngineName[] {
  return config.engines[engine as EngineName]?.fallback ?? [];
}

/**
 * The first engine in `from`'s chain that `isUsable` accepts, continuing through the
 * chain of every engine it rejects. What "usable" means belongs to the caller — the
 * session runtime asks for registered and installed.
 *
 * The visited set is what makes the cycles the validator deliberately allows safe, and
 * it holds `from` from the start so the engine that just failed is never its own answer.
 */
export function resolveFallbackEngine(
  config: JinnConfig,
  from: string,
  isUsable: (engine: EngineName) => boolean,
): EngineName | null {
  const visited = new Set<string>([from]);
  const queue = [...fallbackChain(config, from)];

  for (let i = 0; i < queue.length; i++) {
    const candidate = queue[i];
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    if (isUsable(candidate)) return candidate;
    queue.push(...fallbackChain(config, candidate));
  }

  return null;
}
