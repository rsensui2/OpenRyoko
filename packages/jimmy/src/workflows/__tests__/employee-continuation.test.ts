import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { continuationPrompt, resolveEmployeeContinuation } from '../employee-continuation.js';
import type { EmployeeNode, WorkflowDefinition, WorkflowNode } from '../model.js';
import { workflowDefinitionSchema } from '../model.js';
import { openWorkflowDatabase } from '../repository-migrations.js';
import { WorkflowRepository } from '../repository.js';
import type { ResolvedEmployeeConfig, WorkflowRunDetail, WorkflowRunRecord } from '../runtime.js';
import { validateExecutableWorkflow } from '../validation.js';

const CONFIG: ResolvedEmployeeConfig = {
  employeeId: 'worker', engine: 'codex', model: 'gpt',
  retry: { attempts: 1, delaySeconds: 0, backoff: 'fixed' },
};

function nodes(continueFrom?: { nodeId: string; prompt: string }): WorkflowNode[] {
  return [
    { id: 'start', type: 'trigger', name: 'Start', config: { kind: 'manual' } },
    { id: 'first', type: 'employee', name: 'First', config: { employee: { source: 'fixed', value: 'worker' }, prompt: 'Do the work.' } },
    { id: 'second', type: 'employee', name: 'Second', config: {
      employee: { source: 'fixed', value: 'worker' }, prompt: 'Do the work again.', ...(continueFrom ? { continueFrom } : {}) } },
    { id: 'finish', type: 'end', name: 'Finish', config: { result: 'success' } },
  ];
}

function definition(continueFrom?: { nodeId: string; prompt: string }): WorkflowDefinition {
  return {
    schemaVersion: 1, id: 'flow', title: 'Flow', revision: 1, enabled: false, nodes: nodes(continueFrom),
    edges: [
      { id: 'a', from: { nodeId: 'start', port: 'success' }, to: { nodeId: 'first', port: 'input' } },
      { id: 'b', from: { nodeId: 'first', port: 'success' }, to: { nodeId: 'second', port: 'input' } },
      { id: 'c', from: { nodeId: 'second', port: 'success' }, to: { nodeId: 'finish', port: 'input' } },
    ],
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function node(id: 'first' | 'second', continueFrom?: { nodeId: string; prompt: string }): EmployeeNode {
  return nodes(continueFrom).find((item) => item.id === id) as EmployeeNode;
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;

function run(input: {
  runId: string; todoId?: string; startedAt?: string;
  attempts?: Array<{ nodeId: string; status: string; sessionId?: string }>;
}): WorkflowRunDetail {
  const startedAt = input.startedAt ?? '2026-08-01T00:00:00.000Z';
  return {
    id: input.runId, workflowId: 'flow', workflowTitle: 'Flow', definitionRevision: 1, definition: definition(),
    input: {}, trigger: { nodeId: 'start', kind: 'manual', payload: {}, ...(input.todoId ? { todoId: input.todoId } : {}) },
    status: 'running', revision: 1, startedAt, nodeRuns: [], approvals: [], childRuns: [],
    attempts: (input.attempts ?? []).map((attempt, index) => ({
      runId: input.runId, nodeId: attempt.nodeId, attempt: index + 1, status: attempt.status, resolvedConfig: CONFIG,
      input: {}, startedAt, remindersSent: 0, extensions: 0, lastProcessedTurn: 0,
      ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
    })),
  } as unknown as WorkflowRunDetail;
}

/** The instant a millisecond either side of a stored run, so a test can place the
 *  run it is resolving for either side of one the repository stamped itself. */
const before = (instant: string) => new Date(Date.parse(instant) - 1).toISOString();
const after = (instant: string) => new Date(Date.parse(instant) + 1).toISOString();

/** Records a completed attempt of `first` in a run of `flow` bound to `todoId`. */
function priorRun(input: {
  runId: string; todoId?: string; sessionId: string; status?: string; engine?: string;
}): WorkflowRunRecord {
  const created = repository.createRun({
    workflowId: 'flow', input: {}, idempotencyKey: input.runId,
    trigger: { nodeId: 'start', kind: 'manual', payload: {}, ...(input.todoId ? { todoId: input.todoId } : {}) },
  }, definition());
  const dispatched = repository.mutateRun(created.id, created.revision, (tx) => {
    tx.setNodeStatus('first', 'dispatching', { activated: true });
    tx.createAttempt({ nodeId: 'first', resolvedConfig: { ...CONFIG, engine: input.engine ?? CONFIG.engine }, input: {} });
    tx.settleAttempt('first', 1, { status: 'running', sessionId: input.sessionId });
    return tx;
  }) && repository.getRun('flow', created.id)!;
  const endedAt = '2026-08-01T01:00:00.000Z';
  repository.mutateRun(created.id, dispatched.revision, (tx) => {
    tx.settleAttempt('first', 1, input.status === 'failed'
      ? { status: 'failed', endedAt, error: { code: 'boom', message: 'Attempt failed.', retryable: false } }
      : { status: 'completed', endedAt, output: { text: 'done', fields: {} } });
  });
  return created;
}

const always = (id: string) => `engine-of-${id}`;
const never = () => null;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-continuation-'));
  database = openWorkflowDatabase(path.join(root, 'workflows.db'));
  repository = new WorkflowRepository(database);
  repository.createDefinition({ id: 'flow', title: 'Flow' });
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('continueFrom validation', () => {
  it('accepts a definition naming an existing node and rejects an unknown one', () => {
    const known = definition({ nodeId: 'first', prompt: 'Continue.' });
    expect(workflowDefinitionSchema.safeParse(known).success).toBe(true);
    expect(validateExecutableWorkflow(known)).toEqual({ ok: true, issues: [] });

    const unknown = definition({ nodeId: 'ghost', prompt: 'Continue.' });
    expect(validateExecutableWorkflow(unknown)).toEqual({ ok: false, issues: [
      { code: 'unknown-continue-node', message: 'Continuation references an unknown node.', nodeId: 'second', path: 'nodes.2.config.continueFrom.nodeId' },
    ] });
  });

  it('leaves a definition without the field valid', () => {
    expect(validateExecutableWorkflow(definition())).toEqual({ ok: true, issues: [] });
  });
});

describe('resolving an employee continuation', () => {
  const options = (resumable: (sessionId: string, engine: string) => string | null) =>
    ({ repository, resumableEngineSession: resumable });

  it('is null for a node that does not declare one', () => {
    const detail = run({ runId: 'run-1', attempts: [{ nodeId: 'first', status: 'completed', sessionId: 'session-1' }] });
    expect(resolveEmployeeContinuation(detail, node('second'), 'codex', options(always))).toBeNull();
  });

  it('prefers the newest completed attempt of the named node in this run', () => {
    const detail = run({ runId: 'run-1', todoId: 'PLA-1', attempts: [
      { nodeId: 'first', status: 'completed', sessionId: 'session-old' },
      { nodeId: 'first', status: 'completed', sessionId: 'session-new' },
    ] });
    expect(resolveEmployeeContinuation(detail, node('second', { nodeId: 'first', prompt: 'Continue.' }), 'codex', options(always)))
      .toEqual({ sessionId: 'session-new', engineSessionId: 'engine-of-session-new' });
  });

  it('falls back to a prior run of the same Workflow bound to the same Todo', () => {
    const prior = priorRun({ runId: 'prior', todoId: 'PLA-1', sessionId: 'session-prior' });
    const detail = run({ runId: 'run-2', todoId: 'PLA-1', startedAt: after(prior.startedAt) });
    expect(resolveEmployeeContinuation(detail, node('second', { nodeId: 'first', prompt: 'Continue.' }), 'codex', options(always)))
      .toEqual({ sessionId: 'session-prior', engineSessionId: 'engine-of-session-prior' });
  });

  it.each([
    ['a prior run bound to a different Todo', { todoId: 'PLA-999', status: 'completed' }, 'PLA-1'],
    ['a prior run bound to no Todo', { status: 'completed' }, 'PLA-1'],
    ['an attempt that did not complete', { todoId: 'PLA-1', status: 'failed' }, 'PLA-1'],
    ['a completed attempt of another engine', { todoId: 'PLA-1', status: 'completed', engine: 'claude' }, 'PLA-1'],
  ])('never selects %s', (_label, prior: { todoId?: string; status?: string; engine?: string }, todoId) => {
    const stored = priorRun({ runId: 'prior', sessionId: 'session-prior', ...prior });
    const detail = run({ runId: 'run-2', todoId, startedAt: after(stored.startedAt) });
    expect(resolveEmployeeContinuation(detail, node('second', { nodeId: 'first', prompt: 'Continue.' }), 'codex', options(always))).toBeNull();
  });

  it('never selects a run of the same Todo that started after this one', () => {
    const later = priorRun({ runId: 'later', todoId: 'PLA-1', sessionId: 'session-from-later-run' });
    const detail = run({ runId: 'run-2', todoId: 'PLA-1', startedAt: before(later.startedAt) });
    expect(resolveEmployeeContinuation(detail, node('second', { nodeId: 'first', prompt: 'Continue.' }), 'codex', options(always))).toBeNull();
  });

  it('never selects a candidate this run cannot resume on its own engine', () => {
    const detail = run({ runId: 'run-1', todoId: 'PLA-1', attempts: [{ nodeId: 'first', status: 'completed', sessionId: 'session-1' }] });
    expect(resolveEmployeeContinuation(detail, node('second', { nodeId: 'first', prompt: 'Continue.' }), 'claude', options(never))).toBeNull();
  });

  it('never selects an in-run attempt that ran on another engine, however resumable its session looks', () => {
    // The attempt ran on codex. Its session has since switched to claude and holds
    // a claude thread — a ref that belongs to no round of this node.
    const detail = run({ runId: 'run-1', todoId: 'PLA-1', attempts: [{ nodeId: 'first', status: 'completed', sessionId: 'session-1' }] });
    expect(resolveEmployeeContinuation(detail, node('second', { nodeId: 'first', prompt: 'Continue.' }), 'claude', options(always))).toBeNull();
  });

  it('does not look across runs when this run is bound to no Todo', () => {
    const prior = priorRun({ runId: 'prior', todoId: 'PLA-1', sessionId: 'session-prior' });
    const detail = run({ runId: 'run-2', startedAt: after(prior.startedAt) });
    expect(resolveEmployeeContinuation(detail, node('second', { nodeId: 'first', prompt: 'Continue.' }), 'codex', options(always))).toBeNull();
  });
});

describe('the prompt an attempt goes out with', () => {
  it('is the delta when it continues something and the node brief otherwise', () => {
    const continuing = node('second', { nodeId: 'first', prompt: 'Only the findings.' });
    expect(continuationPrompt(continuing, true)).toBe('Only the findings.');
    expect(continuationPrompt(continuing, false)).toBe('Do the work again.');
    expect(continuationPrompt(node('second'), true)).toBe('Do the work again.');
  });
});
