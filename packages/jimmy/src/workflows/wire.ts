/**
 * The Workflow HTTP wire contract, expressed off the canonical schemas and
 * records rather than restated beside them.
 *
 * There is no serializer layer: `json()` in `gateway/route-helpers.ts` is a bare
 * `JSON.stringify` of whatever the repository returned. So the repository types
 * *are* what goes over the wire. What this module declares rather than
 * re-exports is only what no canonical module already names: the run-detail
 * projections from `gateway/workflow-api.ts`, the two list-endpoint shapes,
 * and the trigger-kind alias the schema keeps private.
 *
 * Every line is `export type`, and that is load-bearing rather than stylistic:
 * `model.ts` value-imports `node:util/types` through `normalizeJson()`.
 * `packages/web` consumes this module and its Vite config carries no Node
 * polyfills, so dropping the `type` keyword on one line is a Rollup failure,
 * not a warning. For the same reason nothing here reaches the storage layer:
 * the two list-endpoint shapes are declared below and the repository imports
 * them back, rather than this module importing the module that owns the DB.
 */
import type { WorkflowAttemptRecord, WorkflowRunDetail, WorkflowRunRecord, WorkflowRunStatus } from './runtime.js';

export type {
  Binding,
  ConditionPredicate,
  JsonValue,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeOutput,
  WorkflowOutputSchema,
} from './model.js';

export type {
  ResolvedEmployeeConfig,
  WorkflowApprovalRecord,
  WorkflowAttemptStatus,
  WorkflowChildRunSummary,
  WorkflowError,
  WorkflowNodeRunRecord,
  WorkflowNodeRunStatus,
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowRunStatus,
} from './runtime.js';

export type { WorkflowValidationIssue } from './issues.js';

/** `GET /api/workflows` — the definition list. `description` and `retiredAt` are
 *  normalized to `null` here where the definition leaves them absent. */
export interface WorkflowDefinitionSummary {
  id: string; title: string; description: string | null; revision: number; enabled: boolean;
  retiredAt: string | null; createdAt: string; updatedAt: string;
}

/** `GET /api/workflows/:id/runs` — the run list. */
export interface WorkflowRunSummary {
  id: string; workflowId: string; workflowTitle: string; definitionRevision: number; status: WorkflowRunStatus;
  trigger: { nodeId: string; kind: WorkflowTriggerKind };
  startedAt: string; endedAt: string | null;
  currentOrFailingNode: {
    nodeId: string; label: string; employeeId: string | null; state: 'current' | 'failing';
  } | null;
}

/** How a run was started. The schema keeps the trigger arms private, and the
 *  run record is the surface that carries the kind, so it is the handle. */
export type WorkflowTriggerKind = WorkflowRunRecord['trigger']['kind'];

/** An attempt as every route sends it: `withoutAttemptInput()` drops `input`,
 *  which always repeats the value already on the attempt's own node run. */
export type WorkflowAttemptWire = Omit<WorkflowAttemptRecord, 'input'>;

/** `GET /api/workflows/:id/runs/:runId?view=full` — `fullRunDetail()`. */
export type WorkflowRunDetailWire = Omit<WorkflowRunDetail, 'attempts'> & {
  attempts: WorkflowAttemptWire[];
  spendUsd: number;
};

/** The same route without `?view=full` — `leanRunDetail()`. The definition
 *  snapshot and the interpolated prompts are both immutable once written, so
 *  polling carries them forward from one full fetch instead of re-sending. */
export type WorkflowRunLeanWire = Omit<WorkflowRunDetailWire, 'definition' | 'attempts'> & {
  attempts: Omit<WorkflowAttemptWire, 'promptText'>[];
};

/** What the run routes that own no projection return. `POST /runs`, the
 *  approval decision, cancel, rerun and retry all send `service.*()` verbatim,
 *  so their bodies carry `attempts[].input` and no `spendUsd` — unlike the read
 *  route beside them. Typed as it behaves; reconciling the two is ICI-1190. */
export type WorkflowRunDetailUnprojectedWire = WorkflowRunDetail;
