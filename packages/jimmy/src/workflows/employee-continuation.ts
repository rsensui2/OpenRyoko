/**
 * Which completed attempt an Employee node continues from, if any.
 *
 * A rework round is its own node, so it dispatches a brand new session that
 * re-reads everything its predecessor already knows. `continueFrom` names the
 * node whose engine session it should pick up instead. Two places to look, in
 * order: this run — the ordinary rework case — then the newest earlier run of
 * the same Workflow for the same Todo, which is the re-arm case.
 */

import { logger } from '../shared/logger.js';
import type { EmployeeNode } from './model.js';
import type { WorkflowRepository } from './repository.js';
import type { WorkflowAttemptRecord, WorkflowRunDetail } from './runtime.js';

export interface EmployeeContinuationOptions {
  repository: Pick<WorkflowRepository, 'findContinuationAttempt'>;
  /** Null for any candidate that cannot actually be resumed on `engine`. */
  resumableEngineSession: (sessionId: string, engine: string) => string | null;
}

/** The prompt an attempt is dispatched with: the delta when it continues something, the node's own brief when it starts cold. */
export function continuationPrompt(node: EmployeeNode, continued: boolean): string {
  return continued && node.config.continueFrom ? node.config.continueFrom.prompt : node.config.prompt;
}

function inRunCandidate(run: WorkflowRunDetail, nodeId: string): WorkflowAttemptRecord | undefined {
  return run.attempts.filter((attempt) => attempt.nodeId === nodeId
    && attempt.status === 'completed' && attempt.sessionId).at(-1);
}

/**
 * Resolve the engine session this attempt continues, or null to dispatch cold.
 * Null is a normal outcome — the first round of a run has nothing to continue —
 * so it is reported at info level rather than raised.
 */
export function resolveEmployeeContinuation(
  run: WorkflowRunDetail,
  node: EmployeeNode,
  engine: string,
  options: EmployeeContinuationOptions,
): { sessionId: string; engineSessionId: string } | null {
  const target = node.config.continueFrom?.nodeId;
  if (!target) return null;
  const candidates = [
    () => inRunCandidate(run, target),
    // Without a Todo there is nothing tying two runs together, so cross-run
    // continuation simply does not apply — never fall back to "any prior run".
    () => (run.trigger.todoId
      ? options.repository.findContinuationAttempt({ workflowId: run.workflowId, nodeId: target,
        todoId: run.trigger.todoId, runId: run.id, runStartedAt: run.startedAt })
      : null),
  ];
  for (const candidate of candidates) {
    const attempt = candidate();
    // The engine the attempt actually ran on, read off what it persisted. Its
    // session is mutable — an employee switched since keeps the same session row
    // and records a ref for the new engine, which is not this thread.
    if (!attempt?.sessionId || attempt.resolvedConfig.engine !== engine) continue;
    const engineSessionId = options.resumableEngineSession(attempt.sessionId, engine);
    if (engineSessionId) return { sessionId: attempt.sessionId, engineSessionId };
  }
  logger.info(`Workflow ${run.workflowId} run ${run.id} node ${node.id} dispatches cold: no resumable ${engine} attempt of ${target} to continue.`);
  return null;
}
