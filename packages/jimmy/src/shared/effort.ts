import { logger } from "./logger.js";
import type { Employee, Session } from "./types.js";

const DEFAULT_EFFORT = "medium";

/**
 * Resolve the effort level for a session.
 *
 * Valid effort levels come from the model registry (`validLevels`) for the
 * session's engine+model — NOT a hardcoded set — so e.g. codex's `xhigh`
 * validates and passes through instead of being silently dropped. Unknown or
 * unsupported levels are dropped with a logged warning (graceful degradation),
 * never a silent pass or a hard throw.
 *
 * For child sessions (has parentSessionId), resolution chain:
 *   1. config.engines.<engine>.childEffortOverride — global cost-control knob
 *   2. session.effortLevel — COO's per-task judgment (from API body)
 *   3. employee.effortLevel — employee YAML default
 *   4. config.engines.<engine>.effortLevel — engine fallback
 *
 * Workflow attempts carry their already-resolved effort in the session even
 * though they have no parent session. Honor that value before engine defaults.
 * For other non-child sessions (COO's own), use engine effortLevel directly.
 *
 * When the engine/model has no effort concept (validLevels empty, e.g.
 * Gemini), returns the default without warnings — effort is just ignored.
 */
export function resolveEffort(
  engineConfig: { effortLevel?: string; childEffortOverride?: string },
  session: Pick<Session, "parentSessionId" | "effortLevel"> & Partial<Pick<Session, "workflowProvenance">>,
  employee: Pick<Employee, "effortLevel"> | null | undefined,
  validLevels: string[],
): string {
  if (validLevels.length === 0) return DEFAULT_EFFORT;
  const isValid = (level: string) => validLevels.includes(level);

  if (session.workflowProvenance?.kind === "phase" && session.effortLevel) {
    if (isValid(session.effortLevel)) return session.effortLevel;
    logger.warn(`Invalid workflow effortLevel "${session.effortLevel}" (valid: ${validLevels.join(", ")}), skipping`);
  }

  if (session.parentSessionId) {
    const override = engineConfig.childEffortOverride;
    if (override) {
      if (isValid(override)) return override;
      logger.warn(`Invalid childEffortOverride "${override}" (valid: ${validLevels.join(", ")}), skipping`);
    }

    const requested = session.effortLevel;
    if (requested) {
      if (isValid(requested)) return requested;
      logger.warn(`Invalid effortLevel "${requested}" on session (valid: ${validLevels.join(", ")}), skipping`);
    }

    const empDefault = employee?.effortLevel;
    if (empDefault) {
      if (isValid(empDefault)) return empDefault;
      logger.warn(`Invalid effortLevel "${empDefault}" on employee (valid: ${validLevels.join(", ")}), skipping`);
    }
  }

  // Non-child sessions (COO) or fallback
  const engineDefault = engineConfig.effortLevel;
  if (engineDefault && isValid(engineDefault)) return engineDefault;
  if (engineDefault) {
    logger.warn(`Invalid effortLevel "${engineDefault}" in engine config (valid: ${validLevels.join(", ")}), defaulting to "${DEFAULT_EFFORT}"`);
  }
  return DEFAULT_EFFORT;
}
