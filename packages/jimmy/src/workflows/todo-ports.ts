import type { TodoRunHandoff, TodoRunOutcome } from "../work-items/runs.js";
import type { WorkflowError } from "./runtime.js";

/**
 * What a Todo-bound Workflow run owes the Todo it runs for, expressed as ports
 * the runner calls and the gateway implements. They live here rather than in
 * `runner.ts` because they are a CONTRACT with the Todos side, not runner
 * mechanics — and because `work-items/` must stay importable from the gateway
 * without pulling the runner in. `runner.ts` re-exports all of them, so no
 * caller had to move.
 *
 * Every port is optional at the runner's options level: absent means no Todo
 * surface, and the run still executes.
 */


/** Where a bound Todo sits when a run is reporting its own lifecycle. */
export type WorkflowRunReflection = "executing" | "in_review" | "blocked";

export interface WorkflowTodoApprovalMirror {
  request(input: { todoId: string; request: string; ref: string; options?: string[]; approver?: string }): void;
  /** Wake the routed employee when a run parks on their decision. Called once,
   *  on the transition into parked. Root and operator-only gates stay on Todos. */
  notifyParked(input: {
    todoId: string; workflowId: string; runId: string; nodeId: string; request: string; ref: string;
  }): void;
}

export interface WorkflowTodoSessionLink {
  link(input: { todoId: string; sessionId: string }): void;
  /** Start the bound Todo's run row for this attempt. Idempotent per session,
   *  so a re-entered dispatch adds no second row. */
  openRun(input: { todoId: string; sessionId: string; startedAt: string }): void;
  /** Settle the run this attempt opened. A session with no open run — an
   *  attempt that never dispatched, or one already settled by the path that
   *  reached the terminal state first — is a no-op, not a failure. */
  closeRun(input: {
    sessionId: string; outcome: TodoRunOutcome; endedAt: string;
    summary?: string; handoff?: TodoRunHandoff; error?: string;
  }): void;
}

export interface WorkflowTodoLifecycle {
  reflect(input: { todoId: string; status: WorkflowRunReflection; workflowId: string; runId: string; nodeId: string }): void;
  recordApprovalDecision(input: {
    todoId: string; workflowId: string; runId: string; nodeId: string;
    decision: "approve" | "reject"; decidedBy: string; choice?: string; note?: string;
  }): void;
  complete(input: {
    todoId: string; workflowId: string; runId: string; nodeId: string;
    approvedBy: string; approvedAt: string;
  }): void;
  /** Write onto the bound Todo why a run settled failed: which node died, the
   *  error, and the run id. Factual, no LLM call. */
  recordFailure(input: { todoId: string; workflowId: string; runId: string; nodeId: string; error: WorkflowError }): void;
  /** Send the work round again from a rejection that carried feedback (see
   *  `WorkflowRevisionRequest`). The run has already stopped when this is called. */
  requestRevision(input: WorkflowRevisionRequest): void;
}

/** Where a re-armed Todo has to land for the workflow's own trigger to fire it
 *  again, or the reason no re-arm can fire at all. `actor` and `label` are the
 *  trigger's own filters, carried so the re-arm can check it would fire —
 *  `label` also has to be re-applied, because a node prompt that disarmed the
 *  Todo mid-run has taken it off. */
export type WorkflowRearmTarget =
  | { status: string; actor?: string; label?: string }
  | { unavailable: string };

/**
 * A run-bound Approval gate was rejected WITH a note. A note turns "no" into
 * "not yet — do it again with this", so the Todo goes round rather than the run
 * ending: the note becomes the current requirement, and the Todo returns to the
 * status its workflow's trigger fires on.
 */
export interface WorkflowRevisionRequest {
  todoId: string;
  workflowId: string;
  runId: string;
  nodeId: string;
  /** The rejecter's note, trimmed and non-empty — this IS the new instruction. */
  feedback: string;
  /** Who rejected it. Becomes the actor of the re-arm, because they decided it. */
  decidedBy: string;
  rearm: WorkflowRearmTarget;
}

/**
 * The engine/model a run's bound Todo says its NEXT attempt should use
 * (ICI-733). Read once per attempt at dispatch, so setting one never disturbs
 * an attempt already running. Absent port = no overrides (the run still
 * executes on the node's own configuration).
 */
export interface WorkflowTodoDispatchOverride {
  /** Undefined when the Todo has no dispatch preferences of its own. */
  read(todoId: string): { engine: string | null; model: string | null } | undefined;
}
