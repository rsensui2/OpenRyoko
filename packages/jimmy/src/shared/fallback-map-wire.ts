/**
 * The sentences an `engines.<name>.fallbackModelMap` problem is reported in.
 *
 * Two surfaces have to say the same thing about the same broken entry: the config
 * loader, refusing a file that is already on disk, and the Settings model-map
 * editor, refusing a save before that file is ever written. An operator who reads
 * one and then the other must not have to work out that they are the same problem,
 * so the sentence is written once here and both sides render it.
 *
 * This module is a pure leaf on purpose — no imports at all. `packages/web` aliases
 * it as `@jinn/fallback-map-wire` and bundles it for real (unlike `@jinn/workflow-wire`,
 * which is types-only and never resolves at build time), so anything reachable from
 * here would have to survive Rollup with no Node polyfills. Keeping the import list
 * empty is what makes that safe rather than merely true today.
 */

/** The config path an operator edits to fix a whole map. */
export function modelMapPath(engine: string): string {
  return `engines.${engine}.fallbackModelMap`;
}

/** The config path of one entry within a map, keyed the way YAML spells it. */
export function modelMapEntryPath(engine: string, model: string): string {
  return `${modelMapPath(engine)}["${model}"]`;
}

/** What a config value turned out to be, phrased for the operator reading the error. */
export function shapeOf(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** The map itself is a scalar or a list where a mapping belongs. */
export function mapNotAMappingProblem(engine: string, value: unknown): string {
  return `${modelMapPath(engine)} must be a mapping of model id to model id (got ${shapeOf(value)})`;
}

/** A key that is not a model id. YAML hands every key over as a string, so the
 *  only way to write a non-id key is to leave it blank. */
export function blankSourceProblem(engine: string): string {
  return `${modelMapPath(engine)} has a blank model id as a key`;
}

/** A key carrying a character no model id has — a discovery line pasted whole. */
export function malformedSourceProblem(engine: string, model: string): string {
  return `${modelMapPath(engine)} has a key that is not a model id (got ${JSON.stringify(model)})`;
}

/** The value side of one entry is not a model id. */
export function targetNotAModelIdProblem(engine: string, model: string, value: unknown): string {
  return `${modelMapEntryPath(engine, model)} must be a nonempty model id (got ${shapeOf(value)})`;
}

/** The value side of one entry carries one. `shapeOf` cannot say this: a
 *  tab-joined `id\tlabel` composite is a perfectly nonempty string. */
export function malformedTargetProblem(engine: string, model: string, value: string): string {
  return (
    `${modelMapEntryPath(engine, model)} must be a model id with no control characters ` +
    `(got ${JSON.stringify(value)})`
  );
}

/** One entry, named the way both the loader and the editor need to talk about it. */
export interface UnservedTarget {
  /** The engine whose map holds the entry. */
  engine: string;
  /** The model id the entry keys on — the pin that was set when the swap happened. */
  model: string;
  /** The model id the entry names. */
  target: string;
  /** The engine standing in, which does not serve `target`. */
  substitute: string;
}

/**
 * An entry that can never fire: the engine taking the turn over does not serve the
 * model the map names for it. The editor renders this verbatim beside the row and
 * refuses the save; the runtime appends what it does instead, below.
 */
export function unservedTargetProblem({ engine, model, target, substitute }: UnservedTarget): string {
  return (
    `${modelMapEntryPath(engine, model)} maps to "${target}", ` +
    `which engine "${substitute}" does not serve`
  );
}

/** The same problem, found at swap time rather than at save time, so it also says
 *  which model the turn ends up on. */
export function unservedTargetWarning(entry: UnservedTarget): string {
  return `${unservedTargetProblem(entry)} — running ${entry.substitute} on its own default model instead.`;
}

/**
 * The same entry found at swap time. The map is the fault here, not the CLI that
 * refused the argv, so the sentence names the file the operator edits — the
 * incident this guards against was read as an antigravity failure for an hour.
 */
export function malformedTargetWarning({ engine, model, target, substitute }: UnservedTarget): string {
  return (
    `${modelMapEntryPath(engine, model)} in config.yaml maps to ${JSON.stringify(target)}, ` +
    `which is not a model id — running ${substitute} on its own default model instead.`
  );
}
