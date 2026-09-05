import { logger } from "../shared/logger.js";
import { isRateLimitMessage } from "../shared/rateLimit.js";
import { normalizeTodoRunHandoff, type TodoRunOutcome } from "../work-items/runs.js";
import type { WorkflowNodeOutput } from "./model.js";
import type { WorkflowError, WorkflowRunDetail } from "./runtime.js";
import type { WorkflowTodoSessionLink } from "./todo-ports.js";

/**
 * What a Todo-bound run writes into that Todo's run ledger: one row per phase
 * ATTEMPT, opened when the attempt gets a session and settled when it reaches a
 * terminal state.
 *
 * Which files an attempt changed and which checks it ran are facts about the
 * ATTEMPT, so a retry has to leave the previous attempt's evidence readable
 * rather than overwrite it — which is the whole reason these are rows and not
 * fields on the Todo.
 *
 * Every write is best-effort, exactly like session attribution: the ledger is
 * evidence, and evidence must never take the run down with it.
 */

/** The four states an attempt can settle in. */
export type WorkflowAttemptTerminalStatus = "completed" | "failed" | "timed-out" | "cancelled";

/** How a terminal attempt reads in the ledger. `failed` is the only split: an
 *  employee that ran and reported a verdict left BLOCKED work, while a
 *  transport fault that produced no output is a CRASH — and an agent deciding
 *  whether to try the same thing again needs to tell those apart.
 *
 *  A quota window outranks all of it (ICI-731). The attempt did not fail, time
 *  out or get cancelled at the work: the provider turned it away, and reading
 *  the error is the only way that fact reaches the ledger — no error CODE says
 *  it, because every transport spells it differently in the message. */
export function todoRunOutcome(status: WorkflowAttemptTerminalStatus, errorCode?: string,
  errorMessage?: string): TodoRunOutcome {
  if (status === "completed") return "completed";
  if (isRateLimitMessage(errorMessage)) return "rate_limited";
  if (status === "timed-out") return "timed_out";
  if (status === "cancelled") return "abandoned";
  return errorCode === "workflow-submitted-failure" ? "blocked" : "crashed";
}

export function openTodoRun(link: WorkflowTodoSessionLink | undefined, run: WorkflowRunDetail,
  sessionId: string, startedAt: string): void {
  record(link, run, (ledger, todoId) => ledger.openRun({ todoId, sessionId, startedAt }));
}

/**
 * Settle the row of an attempt that just reached a terminal state. EVERY
 * terminal path routes through here — one that skipped it would leave an
 * attempt reading as still running forever, which is why the outcome comes from
 * `todoRunOutcome` and not from a judgement made at each call site.
 */
export function settleTodoRun(link: WorkflowTodoSessionLink | undefined, run: WorkflowRunDetail,
  attempt: { sessionId?: string }, settle: {
    status: WorkflowAttemptTerminalStatus; endedAt: string; error?: WorkflowError; output?: WorkflowNodeOutput;
    /** What a phase that submitted FAILURE reported. A success carries its
     *  handoff on `output.fields`; a failure has no output to carry it, and
     *  that report is the one the next attempt most needs to read. Deliberately
     *  NOT checked against the node's success schema on the way in: a phase that
     *  failed must not have its honest report rejected for missing an output it
     *  never got to produce. Known keys are kept, the rest dropped. */
    handoff?: unknown;
  }): void {
  const sessionId = attempt.sessionId;
  if (!sessionId) return;
  const summary = settle.output?.text ?? settle.error?.message;
  const handoff = normalizeTodoRunHandoff(settle.output?.fields ?? settle.handoff);
  record(link, run, (ledger) => ledger.closeRun({
    sessionId,
    outcome: todoRunOutcome(settle.status, settle.error?.code, settle.error?.message),
    endedAt: settle.endedAt,
    ...(summary ? { summary } : {}),
    ...(Object.keys(handoff).length > 0 ? { handoff } : {}),
    ...(settle.error ? { error: settle.error.message } : {}),
  }));
}

function record(link: WorkflowTodoSessionLink | undefined, run: WorkflowRunDetail,
  write: (ledger: WorkflowTodoSessionLink, todoId: string) => void): void {
  const todoId = run.trigger.todoId;
  if (!todoId || !link) return;
  try {
    write(link, todoId);
  } catch (error) {
    logger.warn(`Workflow run ${run.id} could not record a run on Todo ${todoId}: `
      + `${error instanceof Error ? error.message : String(error)}`);
  }
}
