import { logger } from "../shared/logger.js";
import type { WorkflowTodoEventClaimOutcome, WorkflowTodoEventFeed, WorkflowTodoStatusEvent }
  from "../work-items/workflow-event-feed.js";
import type { TriggerNode, WorkflowDefinition } from "./model.js";

/**
 * What becomes of a Todo event once the trigger filters have spoken: which
 * definitions are told why they did not run, and whether the event is sealed or
 * put back for the next drain.
 *
 * It sits beside the trigger service rather than inside it because the service's
 * own job is indexing triggers, claiming work, and starting runs, and none of
 * that needs to know how a decline is worded or when an event may be put back.
 */

export interface IndexedTrigger { definition: WorkflowDefinition; trigger: TriggerNode }
/** Which filter refused a Todo event, and why. The `filter` half exists because
 *  `label` is the one refusal that can be a race rather than a decision. */
export interface TodoMismatch { filter: "label" | "other"; reason: string }
export interface TodoCandidate extends IndexedTrigger { mismatch: TodoMismatch | undefined }
/** Definition id to the newer event that superseded this one for that definition. */
export type SupersededBy = ReadonlyMap<string, string>;
export const NOTHING_SUPERSEDED: SupersededBy = new Map();

/** Whether the Todo is still sitting where this event put it. Once it has moved
 *  on the event is stale, whatever a later write does to the Todo. */
export function stillWhereTheEventLeftIt(event: WorkflowTodoStatusEvent): boolean {
  return event.item.live?.status === event.toStatus;
}
/** Record WHY a candidate did not run. A Todo event that a filter refused, or
 *  that a newer event superseded, otherwise completes silently, which is
 *  indistinguishable from a broken trigger. A `label` refusal is provisional:
 *  `settle` may defer the event on it, and whatever settles the event later
 *  overwrites what is recorded here. */
export function declinedOutcomes(event: WorkflowTodoStatusEvent, candidates: ReadonlyArray<TodoCandidate>,
  superseded: SupersededBy, deferred: boolean): WorkflowTodoEventClaimOutcome[] {
  const outcomes: WorkflowTodoEventClaimOutcome[] = [];
  for (const item of candidates) {
    const workflowId = item.definition.id;
    const winner = superseded.get(workflowId);
    let declined: WorkflowTodoEventClaimOutcome | undefined;
    if (item.mismatch !== undefined) {
      declined = { workflowId, outcome: "suppressed", detail: `Todo event ${event.id} suppressed: ${item.mismatch.reason}.` };
    } else if (winner !== undefined) {
      // An event held back for its label and then beaten once it qualified is a
      // different story from one that never qualified, and the ledger has to say
      // which of the two happened.
      declined = deferred
        ? { workflowId, outcome: "deferred-then-superseded",
          detail: `Todo event ${event.id} waited for its label, then was superseded by ${winner},`
            + ` a newer ${event.toStatus} event on ${event.workItemId}.` }
        : { workflowId, outcome: "superseded",
          detail: `Todo event ${event.id} superseded by ${winner}, a newer ${event.toStatus} event on ${event.workItemId}.` };
    }
    if (declined === undefined) continue;
    logger.info(`Workflow ${workflowId}: ${declined.detail}`);
    outcomes.push(declined);
  }
  return outcomes;
}

/**
 * Close the event, or put it back for the next drain.
 *
 * Labels are read when the event DRAINS, and the drain is kicked by the status
 * write, so a Todo labelled a moment after it moved is judged unlabelled — a
 * race, not a decision, and sealing the event there is what leaves the Todo
 * sitting at its arming status with nothing armed and nothing that will ever
 * look again. `todoMismatch` judges `label` last, so a label refusal means every
 * other filter on that definition was satisfied and the label alone is missing.
 *
 * Deferral therefore sits UPSTREAM of supersession: while a definition is
 * waiting on its label it is not in the running for this event, so it can
 * neither be declined as superseded nor beat a newer event. When the label
 * lands it re-enters the supersession gate on the next drain, as a fresh
 * arrival would.
 *
 * Only the definitions the label refused go back in. The event is shared by
 * every definition bound to the status, and the ones that just started must not
 * be considered again when the label lands, or they run twice.
 */
export function settle(feed: WorkflowTodoEventFeed, event: WorkflowTodoStatusEvent,
  candidates: ReadonlyArray<TodoCandidate>, outcomes: WorkflowTodoEventClaimOutcome[]): void {
  const waiting = candidates.filter((item) => item.mismatch?.filter === "label");
  if (waiting.length === 0 || !stillWhereTheEventLeftIt(event)) {
    feed.completeEvent(event.id, outcomes);
    return;
  }
  feed.deferEvent(event.id, waiting.map((item) => item.definition.id), outcomes);
}

/** Refuse every candidate that survived the filters for the same reason, and
 *  close the event on it. What that reason can be is the caller's business. */
export function suppressAll(feed: WorkflowTodoEventFeed, event: WorkflowTodoStatusEvent,
  runnable: ReadonlyArray<IndexedTrigger>, outcomes: WorkflowTodoEventClaimOutcome[], reason: string): number {
  for (const item of runnable) {
    const detail = `Todo event ${event.id} suppressed: ${reason}.`;
    logger.info(`Workflow ${item.definition.id}: ${detail}`);
    outcomes.push({ workflowId: item.definition.id, outcome: "suppressed", detail });
  }
  feed.completeEvent(event.id, outcomes);
  return 0;
}
