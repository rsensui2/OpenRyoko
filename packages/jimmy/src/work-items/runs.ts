/** work-items shim — run-ledger types and the handoff normalizer, verbatim
 *  from upstream. The ledger itself is not ported; the Workflow runtime only
 *  writes through the optional todo ports, which OpenRyoko leaves absent. */

export const TODO_RUN_OUTCOMES = ['completed', 'blocked', 'crashed', 'timed_out', 'abandoned', 'rate_limited'] as const;
export type TodoRunOutcome = (typeof TODO_RUN_OUTCOMES)[number];

/** What an attempt hands the next one. Everything is optional — the platform
 *  stores and surfaces what the attempt reported, it never invents it. */
export interface TodoRunHandoff {
  changedFiles?: string[];
  verification?: string;
  retryNotes?: string;
  residualRisk?: string;
}

const HANDOFF_NOTES = [
  { key: 'verification', wire: 'verification' },
  { key: 'retryNotes', wire: 'retry_notes' },
  { key: 'residualRisk', wire: 'residual_risk' },
] as const;

export function normalizeTodoRunHandoff(value: unknown): TodoRunHandoff {
  const source = asRecord(value);
  if (!source) return {};
  const handoff: TodoRunHandoff = {};
  const files = stringList(source.changedFiles ?? source.changed_files);
  if (files.length > 0) handoff.changedFiles = files;
  for (const note of HANDOFF_NOTES) {
    const reported = source[note.key] ?? source[note.wire];
    if (typeof reported === 'string' && reported.length > 0) handoff[note.key] = reported;
  }
  return handoff;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
