import type { WorkflowAttemptCompletion } from "../shared/types.js";
import { RESTART_INTERRUPTED } from "./failure.js";
import type { ResolvedEmployeeConfig, WorkflowAttemptRecord, WorkflowError, WorkflowRunDetail } from "./runtime.js";
import type { JsonValue } from "./model.js";
import type { WorkflowRepository } from "./repository.js";
import type { WorkflowSessionExecutor } from "./session-executor.js";
import type { WorkflowTodoSessionLink } from "./todo-ports.js";
import { settleTodoRun } from "./todo-run-ledger.js";

/**
 * Replacing an attempt a gateway restart killed.
 *
 * The restart is not a fault of the work — the process the attempt lived in went
 * away — so its replacement spends no retry budget and waits out no backoff. It
 * carries the engine thread the dead session still holds, so the phase resumes
 * where it was instead of re-deriving everything it had already worked out.
 *
 * A gateway that keeps dying would re-dispatch forever, so the count of restarts
 * a node has already survived is the bound. Past it, the caller settles the run.
 */

/** How many restarts one node's work survives before the run fails instead. */
export const RESTART_REDISPATCH_CAP = 3;

/** Restarts kept killing the same node. Re-dispatching again would be a loop, so
 *  the run stops and says how many of them it survived. */
export function restartExhaustedFailure(nodeId: string, attempt: number, restarts: number): WorkflowError {
  return { code: "workflow-attempt-restart-exhausted", nodeId, attempt, retryable: false,
    message: `Workflow attempt was killed by ${restarts} gateway restarts; it will not be re-dispatched again.` };
}

/** How many of this node's attempts a gateway restart has killed. */
export function restartsOn(run: WorkflowRunDetail, nodeId: string): number {
  return run.attempts.filter((item) => item.nodeId === nodeId && item.error?.code === RESTART_INTERRUPTED).length;
}

export interface RestartReplacementPorts {
  repository: WorkflowRepository;
  executor: WorkflowSessionExecutor;
  todoSessions?: WorkflowTodoSessionLink;
  /** What the replacement carries, composed for a continuing or a cold turn. */
  prompt: (continued: boolean) => string;
}

/**
 * Settle the killed attempt and open its replacement in one transaction, leaving
 * it `dispatching` for the caller to send. Null at the cap: the caller settles
 * the failure instead.
 */
export function openRestartReplacement(deps: RestartReplacementPorts, run: WorkflowRunDetail,
  attempt: WorkflowAttemptRecord, error: WorkflowError, event: WorkflowAttemptCompletion): number | null {
  if (restartsOn(run, attempt.nodeId) >= RESTART_REDISPATCH_CAP) return null;
  const endedAt = event.completedAt;
  const engineSessionId = deps.executor.resumableEngineSession(event.sessionId, attempt.resolvedConfig.engine);
  // The killed session supersedes whatever the dead attempt itself continued
  // from; with no usable thread left, the replacement goes out cold.
  const { continuedFrom: _lost, ...cold } = attempt.resolvedConfig;
  const config: ResolvedEmployeeConfig = engineSessionId
    ? { ...cold, continuedFrom: { sessionId: event.sessionId, engineSessionId } } : cold;
  const promptText = deps.prompt(Boolean(config.continuedFrom));
  const replacement = deps.repository.mutateRun(run.id, run.revision, (tx) => {
    tx.setAttemptReminder(attempt.nodeId, attempt.attempt, { lastProcessedTurn: event.turn });
    tx.settleAttempt(attempt.nodeId, attempt.attempt, { status: "cancelled", sessionId: event.sessionId, error, endedAt });
    tx.setNodeStatus(attempt.nodeId, "dispatching", { activated: true, input: attempt.input, startedAt: endedAt,
      resolvedConfig: config as unknown as Record<string, JsonValue> });
    tx.setRunStatus("running");
    return tx.createAttempt({ nodeId: attempt.nodeId, resolvedConfig: config, input: attempt.input, promptText });
  });
  settleTodoRun(deps.todoSessions, run, attempt, { status: "cancelled", endedAt, error });
  return replacement.attempt;
}
