import { describe, expect, expectTypeOf, it } from 'vitest';
import type { JsonPrimitive, JsonValue, WorkflowDefinition, WorkflowNodeOutput } from '../model.js';
import type {
  ResolvedEmployeeConfig,
  WorkflowApprovalRecord,
  WorkflowAttemptRecord,
  WorkflowAttemptStatus,
  WorkflowError,
  WorkflowNodeRunRecord,
  WorkflowNodeRunStatus,
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowRunStatus,
} from '../runtime.js';

const startedAt = '2026-07-20T00:00:00.000Z';

function definition(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: 'example-workflow',
    title: 'Example workflow',
    revision: 1,
    enabled: false,
    nodes: [],
    edges: [],
    createdAt: startedAt,
    updatedAt: startedAt,
  };
}

describe('canonical runtime and record types', () => {
  it('exports every locked runtime record shape', () => {
    const primitive: JsonPrimitive = null;
    const json: JsonValue = { primitive, list: [true, 1, 'value'] };
    const output: WorkflowNodeOutput = { text: 'Done.', fields: { result: json }, employeeId: 'worker', sessionId: 'session-1' };
    const resolved: ResolvedEmployeeConfig = {
      employeeId: 'worker',
      engine: 'codex',
      model: 'model-name',
      effort: 'high',
      retry: { attempts: 1, delaySeconds: 0, backoff: 'fixed' },
      timeoutMinutes: 30,
    };
    const error: WorkflowError = { code: 'attempt-failed', message: 'Attempt failed.', retryable: true, nodeId: 'work', attempt: 1, details: { reason: 'test' } };
    const run: WorkflowRunRecord = {
      id: 'run-1', workflowId: 'example-workflow', workflowTitle: 'Example workflow', definitionRevision: 1,
      definition: definition(), input: { topic: 'release' },
      trigger: { nodeId: 'start', kind: 'manual', payload: {} }, status: 'running', revision: 1,
      startedAt,
    };
    const nodeRun: WorkflowNodeRunRecord = {
      runId: run.id, nodeId: 'work', nodeType: 'employee', status: 'running', activated: true,
      resolvedConfig: { employeeId: resolved.employeeId }, input: run.input,
    };
    const attempt: WorkflowAttemptRecord = {
      runId: run.id, nodeId: 'work', attempt: 1, status: 'running', resolvedConfig: resolved,
      input: run.input, startedAt: run.startedAt, remindersSent: 0, stopNudgesSent: 0, extensions: 0,
      lastProcessedTurn: 0,
    };
    const approval: WorkflowApprovalRecord = {
      runId: run.id, nodeId: 'approve', status: 'approved', requestedAt: run.startedAt,
      decidedAt: run.startedAt, decidedBy: 'operator', decision: 'approve', reason: 'Looks good.',
    };
    const detail: WorkflowRunDetail = { ...run, nodeRuns: [nodeRun], attempts: [attempt], approvals: [approval], childRuns: [] };

    expect(detail).toMatchObject({ id: 'run-1', status: 'running' });
    expect(output.fields.result).toEqual(json);
    expect(error.retryable).toBe(true);
  });

  it('exports the locked status unions', () => {
    expectTypeOf<WorkflowRunStatus>().toEqualTypeOf<'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'>();
    expectTypeOf<WorkflowNodeRunStatus>().toEqualTypeOf<'pending' | 'ready' | 'dispatching' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped' | 'cancelled'>();
    expectTypeOf<WorkflowAttemptStatus>().toEqualTypeOf<'dispatching' | 'running' | 'completed' | 'failed' | 'timed-out' | 'cancelled'>();
  });
});
