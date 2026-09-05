/**
 * Deterministic config.yaml patching for migrations.
 *
 * A migration version directory may ship a `config-patch.json` describing
 * key-level changes to the instance config. Patches are applied during
 * `ryoko migrate --auto` (i.e. on `ryoko update`) so that shipped default
 * values can evolve WITHOUT clobbering values the user has customized.
 *
 * Per-op semantics (see {@link ConfigPatchOp}):
 *   - key missing              → set to `to`   (adopt the new default)
 *   - key === `from`           → set to `to`   (user still on the old default)
 *   - key defined, `from` set, current !== from → skip (user customized)
 *   - `from` omitted, key present → skip (never overwrite an existing value)
 *   - key already === `to`     → skip (no-op)
 *
 * The whole operation is idempotent: re-running it after a successful apply
 * leaves the config unchanged, because the value is now `to`, not `from`.
 */

export interface ConfigPatchOp {
  /** Dotted path into the config object, e.g. "engines.claude.effortLevel". */
  path: string;
  /** New value to write. */
  to: unknown;
  /**
   * Old shipped default. When provided, the key is only rewritten if its
   * current value still equals it. Omit to make the op insert-only (it will
   * fill in a missing key but never overwrite one the user already set).
   */
  from?: unknown;
}

export type PatchOutcome =
  | { path: string; action: "set"; from: unknown; to: unknown }
  | { path: string; action: "insert"; to: unknown }
  | { path: string; action: "skip"; reason: "customized" | "already"; current: unknown };

/** Structural equality for the primitive/plain-data values found in config.yaml. */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function getDeep(obj: unknown, segments: string[]): { found: boolean; value: unknown } {
  let cur: any = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object" || !(seg in cur)) {
      return { found: false, value: undefined };
    }
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

/**
 * Walk toward a dotted path; report whether a *defined, non-object* intermediate
 * blocks descent (e.g. `engines.claude` holds a string while the op targets
 * `engines.claude.effortLevel`). Such a value is a user customization we must
 * not clobber by materializing an object over it.
 */
function blockingParent(obj: unknown, segments: string[]): { blocked: boolean; value: unknown } {
  let cur: any = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return { blocked: false, value: undefined };
    const seg = segments[i];
    if (!(seg in cur)) return { blocked: false, value: undefined }; // missing → creatable
    cur = cur[seg];
    if (cur != null && typeof cur !== "object") return { blocked: true, value: cur };
  }
  return { blocked: false, value: undefined };
}

/** Set a dotted path on `obj`, creating intermediate objects as needed. Mutates `obj`. */
function setDeep(obj: any, segments: string[], value: unknown): void {
  let cur = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (cur[seg] == null || typeof cur[seg] !== "object") {
      cur[seg] = {};
    }
    cur = cur[seg];
  }
  cur[segments[segments.length - 1]] = value;
}

/**
 * Apply patch ops to a config object. Returns a NEW config object (the input
 * is never mutated) plus a per-op outcome log.
 */
export function applyPatchOps(
  config: unknown,
  ops: ConfigPatchOp[],
): { config: any; outcomes: PatchOutcome[] } {
  const next = structuredClone(config ?? {}) as any;
  const outcomes: PatchOutcome[] = [];

  for (const op of ops) {
    const segments = op.path.split(".");
    const { found, value: current } = getDeep(next, segments);
    const hasFrom = Object.prototype.hasOwnProperty.call(op, "from");

    if (!found || current === undefined) {
      const parent = blockingParent(next, segments);
      if (parent.blocked) {
        outcomes.push({ path: op.path, action: "skip", reason: "customized", current: parent.value });
        continue;
      }
      setDeep(next, segments, op.to);
      outcomes.push({ path: op.path, action: "insert", to: op.to });
      continue;
    }

    if (valuesEqual(current, op.to)) {
      outcomes.push({ path: op.path, action: "skip", reason: "already", current });
      continue;
    }

    if (hasFrom && valuesEqual(current, op.from)) {
      setDeep(next, segments, op.to);
      outcomes.push({ path: op.path, action: "set", from: current, to: op.to });
      continue;
    }

    // Defined, not equal to `to`, and either no `from` was given or the user
    // has diverged from the old default — never overwrite.
    outcomes.push({ path: op.path, action: "skip", reason: "customized", current });
  }

  return { config: next, outcomes };
}

/** Parse and validate a raw config-patch.json payload into typed ops. */
export function parseConfigPatch(raw: string): ConfigPatchOp[] {
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) {
    throw new Error("config-patch.json must be a JSON array of patch ops");
  }
  return data.map((op, i) => {
    if (typeof op !== "object" || op === null || typeof op.path !== "string" || !op.path) {
      throw new Error(`config-patch.json[${i}]: each op needs a non-empty string "path"`);
    }
    if (!Object.prototype.hasOwnProperty.call(op, "to")) {
      throw new Error(`config-patch.json[${i}]: each op needs a "to" value`);
    }
    const parsed: ConfigPatchOp = { path: op.path, to: op.to };
    if (Object.prototype.hasOwnProperty.call(op, "from")) parsed.from = op.from;
    return parsed;
  });
}
