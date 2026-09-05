/** work-items shim — the todo-status event feed contract with an inert
 *  implementation: no Todo subsystem means no status events, ever. The types
 *  are upstream's, so a later work-items port swaps the factory, not callers. */
import type { WorkItemSource, WorkItemStatus } from './store.js';

export interface WorkflowTodoStatusEvent {
  id: string;
  workItemId: string;
  fromStatus: WorkItemStatus | null;
  toStatus: WorkItemStatus;
  actor: string | null;
  armedAsDelegate: string | null;
  quotaWindowDecided: boolean;
  armedAsRecovery?: boolean;
  item: {
    source: WorkItemSource;
    department: string | null;
    assignee: string | null;
    labels: Array<{ id: string; name: string }>;
    live: { assignee: string | null; parentId: string | null; status: WorkItemStatus } | null;
  };
}

export interface WorkflowTodoEventClaimOutcome {
  workflowId: string;
  outcome: 'started' | 'duplicate' | 'suppressed' | 'superseded' | 'deferred-then-superseded' | 'failed';
  runId?: string;
  detail: string;
}

export type WorkflowTodoEventClaim =
  | { state: 'acquired'; definitionIds: string[]; deferred?: boolean }
  | { state: 'busy' }
  | { state: 'processed'; outcomes: WorkflowTodoEventClaimOutcome[] };

export interface WorkflowTodoEventFeed {
  claimEvent(eventId: string, definitionIds: string[]): WorkflowTodoEventClaim;
  completeEvent(eventId: string, outcomes: WorkflowTodoEventClaimOutcome[]): void;
  deferEvent(eventId: string, definitionIds: string[], outcomes: WorkflowTodoEventClaimOutcome[]): void;
  releaseEvent(eventId: string): void;
  listPendingEvents(limit?: number): WorkflowTodoStatusEvent[];
}

export interface WorkflowTodoEventFeedOptions {
  ownerId?: string;
  now?: () => Date;
  leaseMs?: number;
}

export function createWorkflowTodoEventFeed(_options: WorkflowTodoEventFeedOptions = {}): WorkflowTodoEventFeed {
  return {
    claimEvent: () => ({ state: 'busy' }),
    completeEvent: () => {},
    deferEvent: () => {},
    releaseEvent: () => {},
    listPendingEvents: () => [],
  };
}
