import type { JsonValue, WorkflowDefinition, WorkflowNode, WorkflowNodeOutput } from './model.js';

export const WORKFLOW_RUN_STATUSES = ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as const;
export const WORKFLOW_NODE_RUN_STATUSES = [
  'pending', 'ready', 'dispatching', 'running', 'waiting', 'completed', 'failed', 'skipped', 'cancelled',
] as const;
export const WORKFLOW_ATTEMPT_STATUSES = [
  'dispatching', 'running', 'completed', 'failed', 'timed-out', 'cancelled',
] as const;

export type WorkflowRunStatus = typeof WORKFLOW_RUN_STATUSES[number];
export type WorkflowNodeRunStatus = typeof WORKFLOW_NODE_RUN_STATUSES[number];
export type WorkflowAttemptStatus = typeof WORKFLOW_ATTEMPT_STATUSES[number];

export interface ResolvedEmployeeConfig {
  employeeId: string;
  engine: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  retry: { attempts: number; delaySeconds: number; backoff: 'fixed' | 'exponential' };
  timeoutMinutes?: number;
  /** The completed attempt session whose engine thread this attempt continues.
   *  Absent means the attempt was dispatched cold. */
  continuedFrom?: { sessionId: string; engineSessionId: string };
  /** The engine this node's own precedence resolved to, when it could not serve
   *  the turn and a fallback chain covered for it. Absent means `engine` is what
   *  the node asked for. */
  substitutedFrom?: { engine: string; reason: string };
}

export interface WorkflowError {
  code: string;
  message: string;
  retryable: boolean;
  nodeId?: string;
  attempt?: number;
  details?: Record<string, JsonValue>;
}

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  workflowTitle: string;
  definitionRevision: number;
  definition: WorkflowDefinition;
  input: Record<string, JsonValue>;
  trigger: {
    nodeId: string;
    kind: 'manual' | 'schedule' | 'event' | 'todo-status' | 'workflow-call';
    fireId?: string;
    payload: Record<string, JsonValue>;
    /** The Todo this run is bound to: set by a `todo-status` trigger to the
     *  Todo that fired it, so parked gates and comments land on THAT Todo
     *  instead of minting a new one. Exposed to nodes as `{{ run.todoId }}`. */
    todoId?: string;
  };
  status: WorkflowRunStatus;
  revision: number;
  idempotencyKey?: string;
  invocationSessionId?: string;
  cancelRequestedAt?: string;
  startedAt: string;
  endedAt?: string;
  error?: WorkflowError;
}

export interface WorkflowNodeRunRecord {
  runId: string;
  nodeId: string;
  nodeType: WorkflowNode['type'];
  status: WorkflowNodeRunStatus;
  activated: boolean;
  resolvedConfig?: Record<string, JsonValue>;
  input?: JsonValue;
  output?: WorkflowNodeOutput;
  error?: WorkflowError;
  resumeAt?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface WorkflowAttemptRecord {
  runId: string;
  nodeId: string;
  attempt: number;
  sessionId?: string;
  status: WorkflowAttemptStatus;
  resolvedConfig: ResolvedEmployeeConfig;
  input: JsonValue;
  /** The final composed prompt handed to the session (interpolated + contract block). */
  promptText?: string;
  output?: WorkflowNodeOutput;
  error?: WorkflowError;
  startedAt: string;
  endedAt?: string;
  remindersSent: number;
  /** Immediate nudges spent on turns that ended on narration. Counted apart from
   *  `remindersSent` so the time ladder is still whole once they run out. */
  stopNudgesSent: number;
  nextReminderAt?: string;
  extensions: number;
  lastExtensionReason?: string;
  pendingOutputError?: string;
  lastProcessedTurn: number;
}

export interface WorkflowApprovalRecord {
  runId: string;
  nodeId: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  approverRef?: string;
  decidedAt?: string;
  decidedBy?: string;
  decision?: 'approve' | 'reject';
  reason?: string;
}

export interface WorkflowChildRunSummary {
  runId: string;
  workflowId: string;
  nodeId: string;
  /** Absent on a run an attempt session started: that is a single spawn, not one item of a batch. */
  itemIndex?: number;
  status: WorkflowRunStatus;
  startedAt: string;
  endedAt?: string;
  endOutput?: Record<string, JsonValue>;
  /** The engine session this child ran in, when it had one — what makes a single
   *  iteration round separately readable from its caller's run detail. */
  sessionId?: string;
  error?: WorkflowError;
}

/** A Workflow Call child, which is always one item of its node's batch. */
export type WorkflowFanoutChildSummary = WorkflowChildRunSummary & { itemIndex: number };

export interface WorkflowRunDetail extends WorkflowRunRecord {
  nodeRuns: WorkflowNodeRunRecord[];
  attempts: WorkflowAttemptRecord[];
  approvals: WorkflowApprovalRecord[];
  childRuns: WorkflowChildRunSummary[];
}
