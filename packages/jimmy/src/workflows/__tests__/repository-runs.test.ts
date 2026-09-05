import { Buffer } from 'node:buffer';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as workflows from '../index.js';
import type { JsonValue, WorkflowDefinition } from '../model.js';
import {
  WorkflowRepository,
  WorkflowRepositoryError,
  type CreateRunInput,
  type CursorPage,
  type RunListQuery,
  type WorkflowRunSummary,
  type WorkflowRunTransaction,
} from '../repository.js';
import { openWorkflowDatabase } from '../repository-migrations.js';
import type {
  ResolvedEmployeeConfig,
  WorkflowAttemptRecord,
  WorkflowNodeRunRecord,
  WorkflowRunDetail,
  WorkflowRunRecord,
} from '../runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const START = '2026-07-21T10:00:00.000Z';

let root: string;
let db: Database.Database;
let repository: WorkflowRepository;
let now: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jinn-workflow-runs-'));
  db = openWorkflowDatabase(join(root, 'workflows.db'));
  now = START;
  repository = new WorkflowRepository(db, () => now);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function authoredDefinition(id = 'content-flow', title = 'Content flow'): WorkflowDefinition {
  const created = repository.createDefinition({ id, title });
  return repository.saveDefinition({
    ...created,
    nodes: [
      { id: 'start', type: 'trigger', name: 'Start', config: { kind: 'manual' } },
      { id: 'event-start', type: 'trigger', name: 'Event start', config: { kind: 'event', eventName: 'content.ready' } },
      { id: 'draft', type: 'employee', name: 'Draft content', config: { employee: { source: 'fixed', value: 'writer' }, prompt: 'Draft the content.' } },
      { id: 'pause', type: 'wait', name: 'Pause', config: { mode: 'duration', minutes: 5 } },
      { id: 'approve', type: 'approval', name: 'Approve', config: { description: 'Approve the draft.' } },
      { id: 'finish', type: 'end', name: 'Finish', config: { result: 'success' } },
    ],
    edges: [],
  }, created.revision);
}

function calledDefinition(id = 'child-flow'): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: 'Child flow' });
  return repository.saveDefinition({ ...created,
    nodes: [
      { id: 'start', type: 'trigger', name: 'Called', config: { kind: 'workflow-call' } },
      { id: 'write', type: 'employee', name: 'Write', config: { employee: { source: 'fixed', value: 'writer' }, prompt: 'Write.' } },
      { id: 'finish', type: 'end', name: 'Finish', config: { result: 'success' } },
    ],
    edges: [{ id: 'to-write', from: { nodeId: 'start', port: 'success' }, to: { nodeId: 'write', port: 'input' } },
      { id: 'finish', from: { nodeId: 'write', port: 'success' }, to: { nodeId: 'finish', port: 'input' } }],
  }, created.revision);
}

function createRun(overrides: Partial<CreateRunInput> = {}): WorkflowRunRecord {
  return repository.createRun({
    workflowId: 'content-flow',
    input: { topic: 'release' },
    trigger: { nodeId: 'start', kind: 'manual', payload: { source: 'operator' } },
    ...overrides,
  });
}

function resolved(employeeId = 'writer'): ResolvedEmployeeConfig {
  return { employeeId, engine: 'codex', model: 'model-name', effort: 'high', timeoutMinutes: 30,
    retry: { attempts: 2, delaySeconds: 10, backoff: 'fixed' } };
}

function expectRepositoryError(action: () => unknown, code: WorkflowRepositoryError['code']): WorkflowRepositoryError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WorkflowRepositoryError);
  expect(thrown).toMatchObject({ name: 'WorkflowRepositoryError', code });
  return thrown as WorkflowRepositoryError;
}

function repositoryErrorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof WorkflowRepositoryError ? error.code : `raw:${String(error)}`;
  }
}

function tableCounts(): Record<string, number> {
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  return {
    runs: count('workflow_runs'),
    nodes: count('workflow_node_runs'),
    attempts: count('workflow_attempts'),
    approvals: count('workflow_approvals'),
  };
}

function decodeCursor(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('WorkflowRepository Task 11 contract', () => {
  it('persists and reloads an Astra attempt using max effort', () => {
    authoredDefinition();
    const run = createRun();
    repository.mutateRun(run.id, 1, (tx) => {
      tx.setRunStatus('running');
      tx.setNodeStatus('draft', 'dispatching', { activated: true, startedAt: START });
      tx.createAttempt({
        nodeId: 'draft', input: {},
        resolvedConfig: { ...resolved(), model: 'gpt-6-astra', effort: 'max' },
      });
    });
    expect(repository.getAttempt(run.id, 'draft', 1)?.resolvedConfig)
      .toMatchObject({ engine: 'codex', model: 'gpt-6-astra', effort: 'max' });
    expect(repository.getRun(run.workflowId, run.id)?.attempts[0].resolvedConfig.effort).toBe('max');
  });

  it('exposes the ten run methods and exact public contract shapes', () => {
    expectTypeOf(repository.createRun).parameter(0).toEqualTypeOf<CreateRunInput>();
    expectTypeOf(repository.createRun).returns.toEqualTypeOf<WorkflowRunRecord>();
    expectTypeOf(repository.getRun).returns.toEqualTypeOf<WorkflowRunDetail | null>();
    expectTypeOf(repository.listRuns).parameter(1).toEqualTypeOf<RunListQuery>();
    expectTypeOf(repository.listRuns).returns.toEqualTypeOf<CursorPage<WorkflowRunSummary>>();
    expectTypeOf(repository.findRunByIdempotency).returns.toEqualTypeOf<WorkflowRunRecord | null>();
    expectTypeOf(repository.mutateRun).parameter(2).toEqualTypeOf<(tx: WorkflowRunTransaction) => unknown>();
    expectTypeOf(repository.getAttempt).returns.toEqualTypeOf<WorkflowAttemptRecord | null>();
    expectTypeOf(repository.listAttempts).returns.toEqualTypeOf<WorkflowAttemptRecord[]>();
    expectTypeOf(repository.findAttemptBySessionId).returns.toEqualTypeOf<WorkflowAttemptRecord | null>();
    expectTypeOf(repository.listRecoverableRuns).returns.toEqualTypeOf<WorkflowRunRecord[]>();
    expectTypeOf(repository.listDueWaits).returns.toEqualTypeOf<WorkflowNodeRunRecord[]>();
    expectTypeOf(repository.listDueReminders).returns.toEqualTypeOf<WorkflowAttemptRecord[]>();
    expectTypeOf(repository.nextDueReminder).returns.toEqualTypeOf<{
      runId: string; nodeId: string; attempt: number; nextReminderAt: string;
    } | null>();
    expectTypeOf(repository.nextDueTimeout).returns.toEqualTypeOf<string | null>();
  });

  it('exports one public repository and the same error without exposing helpers', () => {
    expect(workflows.WorkflowRepository).toBe(WorkflowRepository);
    expect(workflows.WorkflowRepositoryError).toBe(WorkflowRepositoryError);
    expect(Object.keys(workflows).filter((name) => name.endsWith('Repository'))).toEqual(['WorkflowRepository']);
    expect(Object.keys(workflows)).not.toContain('RunRepository');

    const repositorySource = readFileSync(join(HERE, '..', 'repository.ts'), 'utf8');
    const helpers = ['repository-support.ts', 'repository-runs.ts', 'repository-run-transaction.ts'];
    for (const helper of helpers) {
      const source = readFileSync(join(HERE, '..', helper), 'utf8');
      expect(source).not.toMatch(/BEGIN\s+(?:IMMEDIATE|TRANSACTION)/i);
      expect(source).not.toContain('.transaction(');
      expect(repositorySource).toContain(`./${helper.replace(/\.ts$/, '.js')}`);
    }
  });
});

describe('run creation and idempotency', () => {
  it('lists child runs by caller in item order, with the End output and the session of each round', () => {
    const parentDefinition = authoredDefinition();
    const childDefinition = calledDefinition();
    const parent = repository.createRun({ workflowId: parentDefinition.id, input: {},
      trigger: { nodeId: 'start', kind: 'manual', payload: {} } });
    const children = [2, 0, 1, 3].map((itemIndex) => repository.createRun({
      workflowId: childDefinition.id, input: { topic: `item-${itemIndex}` },
      trigger: { nodeId: 'start', kind: 'workflow-call', payload: {
        caller: { workflowId: parent.workflowId, runId: parent.id, nodeId: 'draft' }, itemIndex,
      } }, idempotencyKey: `${parent.id}:draft:${itemIndex}`,
    }));
    // Round 0 is still running and round 1 failed, each with a session on its attempt and nothing in its node
    // output; round 2 finished and carries one in its output; round 3 finished without ever dispatching.
    for (const child of children) {
      const itemIndex = child.trigger.payload.itemIndex as number;
      repository.mutateRun(child.id, child.revision, (tx) => {
        tx.setNodeStatus('start', 'completed', { activated: true, startedAt: now, endedAt: now });
        if (itemIndex < 3) {
          tx.createAttempt({ nodeId: 'write', resolvedConfig: resolved(), input: {} });
          tx.settleAttempt('write', 1, { status: 'running', sessionId: `session-${itemIndex}` });
        }
        if (itemIndex === 0) return tx.setRunStatus('running', {});
        if (itemIndex === 1) return tx.setRunStatus('failed', { endedAt: now, error: { code: 'engine-down', message: 'Engine down.', retryable: true } });
        if (itemIndex === 2) {
          tx.settleAttempt('write', 1, { status: 'completed', output: { text: '', fields: {} }, endedAt: now });
          tx.setNodeStatus('write', 'completed', { activated: true, startedAt: now, endedAt: now, output: { text: '', fields: {}, sessionId: 'session-2' } });
        }
        tx.setNodeStatus('finish', 'completed', { activated: true, startedAt: now, endedAt: now, output: { text: '', fields: { result: `done-${itemIndex}` } } });
        tx.setRunStatus('completed', { endedAt: now });
      });
    }

    expect(repository.listChildRuns(parent.id, 'draft').map((round) => [round.itemIndex, round.runId,
      round.workflowId, round.status, round.endOutput?.result, round.sessionId])).toEqual([
      [0, children[1]!.id, childDefinition.id, 'running', undefined, 'session-0'],
      [1, children[2]!.id, childDefinition.id, 'failed', undefined, 'session-1'],
      [2, children[0]!.id, childDefinition.id, 'completed', 'done-2', 'session-2'],
      [3, children[3]!.id, childDefinition.id, 'completed', 'done-3', undefined],
    ]);
  });

  it('freezes the exact definition, input, and trigger and initializes every authored node', () => {
    const definition = authoredDefinition();
    const input = Object.assign(Object.create(null), { topic: 'release' }) as Record<string, JsonValue>;
    const run = repository.createRun({
      workflowId: definition.id,
      input,
      trigger: { nodeId: 'event-start', kind: 'event', fireId: 'fire-1', payload: { ok: true } },
      idempotencyKey: 'request-1',
      invocationSessionId: 'caller-1',
    });

    expect(run).toMatchObject({
      workflowId: definition.id,
      workflowTitle: definition.title,
      definitionRevision: definition.revision,
      definition,
      input: { topic: 'release' },
      trigger: { nodeId: 'event-start', kind: 'event', fireId: 'fire-1', payload: { ok: true } },
      status: 'pending',
      revision: 1,
      idempotencyKey: 'request-1',
      invocationSessionId: 'caller-1',
      startedAt: START,
    });
    expect(run.id).toMatch(/^run_[0-9a-f-]{36}$/);
    expect(run).not.toHaveProperty('endedAt');
    expect(repository.getRun(definition.id, run.id)?.nodeRuns).toEqual(definition.nodes.map((node) => ({
      runId: run.id,
      nodeId: node.id,
      nodeType: node.type,
      status: 'pending',
      activated: false,
    })));
    expect(input).toEqual({ topic: 'release' });

    now = '2026-07-21T10:05:00.000Z';
    repository.saveDefinition({ ...definition, title: 'Changed title', nodes: definition.nodes.map((node) => (
      node.id === 'draft' ? { ...node, name: 'Changed node label' } : node
    )) }, definition.revision);
    expect(repository.getRun(definition.id, run.id)).toMatchObject({
      workflowTitle: 'Content flow',
      definitionRevision: definition.revision,
      definition,
    });
  });

  it('returns an equivalent idempotent replay without writes and rejects conflicting reuse once', () => {
    authoredDefinition();
    const request: CreateRunInput = {
      workflowId: 'content-flow',
      input: { topic: 'release' },
      trigger: { nodeId: 'event-start', kind: 'event', fireId: 'same-fire', payload: { nested: { ok: true } } },
      idempotencyKey: 'same-request',
      invocationSessionId: 'caller-1',
    };
    const original = repository.createRun(request);
    const before = tableCounts();
    now = '2026-07-21T11:00:00.000Z';
    expect(repository.createRun(request)).toEqual(original);
    expect(tableCounts()).toEqual(before);

    const conflicts: CreateRunInput[] = [
      { ...request, input: { topic: 'different' } },
      { ...request, trigger: { ...request.trigger, payload: { nested: { ok: false } } } },
      { ...request, invocationSessionId: 'caller-2' },
    ];
    for (const conflict of conflicts) {
      expectRepositoryError(() => repository.createRun(conflict), 'idempotency-conflict');
    }
    expect(tableCounts()).toEqual(before);
    expect(repository.findRunByIdempotency('content-flow', 'same-request')).toEqual(original);
    expect(repository.findRunByIdempotency('content-flow', 'missing-request')).toBeNull();
  });

  it('requires the current definition revision for an idempotent replay', () => {
    const definition = authoredDefinition();
    const request: CreateRunInput = {
      workflowId: definition.id, input: {}, idempotencyKey: 'stable-key',
      trigger: { nodeId: 'start', kind: 'manual', payload: {} },
    };
    repository.createRun(request);
    repository.saveDefinition({ ...definition, title: 'New revision' }, definition.revision);
    const before = tableCounts();
    expectRepositoryError(() => repository.createRun(request), 'idempotency-conflict');
    expect(tableCounts()).toEqual(before);
  });

  it('fails closed when the current definition is missing or corrupt before replay', () => {
    const definition = authoredDefinition();
    const request: CreateRunInput = {
      workflowId: 'content-flow', input: {}, idempotencyKey: 'stable-key',
      trigger: { nodeId: 'start', kind: 'manual', payload: {} },
    };
    repository.createRun(request);
    db.prepare("UPDATE workflow_definitions SET definition_json = '{' WHERE id = ?").run('content-flow');
    expectRepositoryError(() => repository.createRun(request), 'corrupt-record');
    db.prepare('UPDATE workflow_definitions SET definition_json = ? WHERE id = ?').run(JSON.stringify(definition), 'content-flow');
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM workflow_definitions WHERE id = ?').run('content-flow');
    db.pragma('foreign_keys = ON');
    expectRepositoryError(() => repository.createRun(request), 'not-found');
  });
});

describe('atomic run mutations', () => {
  it('persists dispatching attempts with deterministic next numbers and settles them', () => {
    authoredDefinition();
    const run = createRun();
    let first!: WorkflowAttemptRecord;
    repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setRunStatus('running');
      tx.setNodeStatus('draft', 'dispatching', {
        activated: true,
        resolvedConfig: { employeeId: 'writer' },
        input: { topic: 'release' },
        startedAt: START,
      });
      first = tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: { topic: 'release' },
        promptText: 'Draft the release notes.\n\n---\nContract block.' });
    });
    expect(first).toMatchObject({
      runId: run.id, nodeId: 'draft', attempt: 1, status: 'dispatching', startedAt: START,
      promptText: 'Draft the release notes.\n\n---\nContract block.',
    });
    expect(repository.getAttempt(run.id, 'draft', 1)).toEqual(first);

    now = '2026-07-21T10:01:00.000Z';
    repository.mutateRun(run.id, 2, (tx) => {
      tx.settleAttempt('draft', 1, { status: 'running', sessionId: 'session-1' });
    });
    const running = repository.findAttemptBySessionId('session-1');
    expect(running).toMatchObject({ status: 'running', sessionId: 'session-1' });

    now = '2026-07-21T10:02:00.000Z';
    repository.mutateRun(run.id, 3, (tx) => {
      tx.settleAttempt('draft', 1, {
        status: 'completed', output: { text: 'Done.', fields: { ok: true } }, endedAt: now,
      });
      tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: { topic: 'retry' } });
    });
    expect(repository.listAttempts(run.id, 'draft').map(({ attempt, status }) => ({ attempt, status }))).toEqual([
      { attempt: 1, status: 'completed' },
      { attempt: 2, status: 'dispatching' },
    ]);
    // promptText is optional: the second attempt was created without one.
    expect(repository.getAttempt(run.id, 'draft', 2)?.promptText).toBeUndefined();
  });

  it('persists reminder state and reads due attempts in deterministic order', () => {
    authoredDefinition();
    const run = createRun();
    repository.mutateRun(run.id, run.revision, (tx) => {
      tx.setNodeStatus('draft', 'dispatching', { activated: true, startedAt: START });
      tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: {} });
    });
    repository.mutateRun(run.id, 2, (tx) => {
      tx.settleAttempt('draft', 1, { status: 'running', sessionId: 'session-reminder' });
      tx.setAttemptReminder('draft', 1, {
        remindersSent: 2,
        nextReminderAt: '2026-07-21T10:15:00.000Z',
        extensions: 1,
        lastExtensionReason: 'Waiting for review.',
        pendingOutputError: 'Field "score" must be a number.',
      });
    });

    expect(repository.getAttempt(run.id, 'draft', 1)).toMatchObject({
      remindersSent: 2,
      nextReminderAt: '2026-07-21T10:15:00.000Z',
      extensions: 1,
      lastExtensionReason: 'Waiting for review.',
      pendingOutputError: 'Field "score" must be a number.',
    });
    expect(repository.listDueReminders('2026-07-21T10:15:00.000Z', 100)).toEqual([
      expect.objectContaining({ runId: run.id, nodeId: 'draft', attempt: 1 }),
    ]);
    expect(repository.listDueReminders('2026-07-21T10:14:59.999Z', 100)).toEqual([]);
    expect(repository.nextDueReminder()).toEqual({
      runId: run.id,
      nodeId: 'draft',
      attempt: 1,
      nextReminderAt: '2026-07-21T10:15:00.000Z',
    });
  });

  it('reads the earliest running attempt timeout and ignores attempts without one', () => {
    const createRunningAttempt = (id: string, startedAt: string, timeoutMinutes?: number) => {
      now = startedAt;
      authoredDefinition(id, id);
      const run = createRun({ workflowId: id });
      const config = resolved();
      if (timeoutMinutes === undefined) delete config.timeoutMinutes;
      else config.timeoutMinutes = timeoutMinutes;
      repository.mutateRun(run.id, run.revision, (tx) => {
        tx.setRunStatus('running');
        tx.setNodeStatus('draft', 'dispatching', { activated: true, startedAt });
        tx.createAttempt({ nodeId: 'draft', resolvedConfig: config, input: {} });
      });
      repository.mutateRun(run.id, 2, (tx) => {
        tx.settleAttempt('draft', 1, { status: 'running', sessionId: `session-${id}` });
      });
      return run;
    };

    expect(repository.nextDueTimeout()).toBeNull();
    createRunningAttempt('unbounded-flow', '2026-07-21T10:00:00.000Z');
    expect(repository.nextDueTimeout()).toBeNull();
    const later = createRunningAttempt('later-flow', '2026-07-21T10:01:00.000Z', 30);
    const earlier = createRunningAttempt('earlier-flow', '2026-07-21T10:05:00.000Z', 10);
    expect(repository.nextDueTimeout()).toBe('2026-07-21T10:15:00.000Z');

    const timeoutError = { code: 'workflow-timeout', message: 'Workflow attempt timed out.', retryable: true };
    repository.mutateRun(earlier.id, 3, (tx) => {
      tx.settleAttempt('draft', 1, { status: 'timed-out', error: timeoutError, endedAt: '2026-07-21T10:15:00.000Z' });
    });
    expect(repository.nextDueTimeout()).toBe('2026-07-21T10:31:00.000Z');
    repository.mutateRun(later.id, 3, (tx) => {
      tx.settleAttempt('draft', 1, { status: 'timed-out', error: timeoutError, endedAt: '2026-07-21T10:31:00.000Z' });
    });
    expect(repository.nextDueTimeout()).toBeNull();
  });

  it('rolls back atomically, bumps once when changed, never bumps a no-op, and rejects stale revisions', () => {
    authoredDefinition();
    const run = createRun();
    const result = repository.mutateRun(run.id, 1, (tx) => {
      tx.setRunStatus('running');
      tx.setNodeStatus('start', 'completed', { activated: true, startedAt: START, endedAt: START });
      tx.setNodeStatus('draft', 'ready', { activated: true });
      return 'mutated';
    });
    expect(result).toBe('mutated');
    expect(repository.getRun(run.workflowId, run.id)?.revision).toBe(2);

    repository.mutateRun(run.id, 2, (tx) => {
      tx.setRunStatus('running');
      tx.setNodeStatus('draft', 'ready', { activated: true });
    });
    expect(repository.getRun(run.workflowId, run.id)?.revision).toBe(2);
    expectRepositoryError(() => repository.mutateRun(run.id, 1, () => undefined), 'revision-conflict');

    const before = repository.getRun(run.workflowId, run.id);
    expect(() => repository.mutateRun(run.id, 2, (tx) => {
      tx.setRunStatus('failed', { endedAt: now, error: { code: 'failed', message: 'Failed.', retryable: false } });
      tx.setNodeStatus('draft', 'failed', {
        error: { code: 'failed', message: 'Failed.', retryable: false, nodeId: 'draft' }, endedAt: now,
      });
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(repository.getRun(run.workflowId, run.id)).toEqual(before);

    db.exec(`CREATE TRIGGER reject_node_update BEFORE UPDATE ON workflow_node_runs
      BEGIN SELECT RAISE(ABORT, 'forced SQL fault'); END`);
    expect(() => repository.mutateRun(run.id, 2, (tx) => {
      tx.setRunStatus('failed', { endedAt: START, error: { code: 'failed', message: 'Failed.', retryable: false } });
      tx.setNodeStatus('draft', 'failed');
    })).toThrow('forced SQL fault');
    db.exec('DROP TRIGGER reject_node_update');
    expect(repository.getRun(run.workflowId, run.id)).toEqual(before);
  });

  it('persists complete approval audit records', () => {
    authoredDefinition();
    const run = createRun();
    repository.mutateRun(run.id, 1, (tx) => {
      tx.putApproval({
        nodeId: 'approve', status: 'approved', requestedAt: START, approverRef: 'operator',
        decidedAt: START, decidedBy: 'operator', decision: 'approve', reason: 'Reviewed.',
      });
    });
    expect(repository.getRun(run.workflowId, run.id)?.approvals).toEqual([{
      runId: run.id, nodeId: 'approve', status: 'approved', requestedAt: START, approverRef: 'operator',
      decidedAt: START, decidedBy: 'operator', decision: 'approve', reason: 'Reviewed.',
    }]);
  });

  it('rejects incomplete attempt settlements without changing the run', () => {
    authoredDefinition();
    const run = createRun();
    repository.mutateRun(run.id, 1, (tx) => {
      tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: {} });
    });
    const before = repository.getRun(run.workflowId, run.id);
    expectRepositoryError(() => repository.mutateRun(run.id, 2, (tx) => {
      tx.settleAttempt('draft', 1, { status: 'completed', endedAt: START } as never);
    }), 'bad-input');
    expect(repository.getRun(run.workflowId, run.id)).toEqual(before);
  });

  it('closes mutation scopes, rejects nesting, and rolls async work back', async () => {
    authoredDefinition();
    const run = createRun();
    let escaped!: WorkflowRunTransaction;
    expect(repository.mutateRun(run.id, 1, (tx) => {
      escaped = tx;
      return { ok: true };
    })).toEqual({ ok: true });
    expectRepositoryError(() => escaped.setRunStatus('running'), 'bad-input');

    expectRepositoryError(() => repository.mutateRun(run.id, 1, () => (
      repository.mutateRun(run.id, 1, () => undefined)
    )), 'bad-input');
    expect(() => repository.mutateRun(run.id, 1, () => { throw new Error('callback'); })).toThrow('callback');

    let continuation!: Promise<void>;
    expectRepositoryError(() => repository.mutateRun(run.id, 1, (tx) => {
      tx.setRunStatus('running');
      continuation = (async () => {
        await Promise.resolve();
        tx.setRunStatus('failed', { endedAt: START, error: { code: 'late', message: 'Late.', retryable: false } });
      })();
      return continuation as never;
    }), 'bad-input');
    await expect(continuation).rejects.toMatchObject({ code: 'bad-input' });

    expectRepositoryError(() => repository.mutateRun(run.id, 1, (tx) => {
      tx.setRunStatus('running');
      return { then: () => undefined } as never;
    }), 'bad-input');
    expect(repository.getRun(run.workflowId, run.id)).toMatchObject({ revision: 1, status: 'pending' });
    repository.mutateRun(run.id, 1, (tx) => tx.setRunStatus('running'));
  });

  it('enforces attempt ownership and legal lifecycle transitions', () => {
    authoredDefinition();
    const run = createRun();
    repository.mutateRun(run.id, 1, (tx) => {
      tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: {} });
    });
    expectRepositoryError(() => repository.mutateRun(run.id, 2, (tx) => {
      tx.settleAttempt('draft', 1, {
        status: 'completed', output: { text: 'Skipped running.', fields: {} }, endedAt: START,
      });
    }), 'bad-input');
    expectRepositoryError(() => repository.mutateRun(run.id, 2, (tx) => {
      tx.settleAttempt('draft', 1, {
        status: 'dispatching', error: { code: 'bad', message: 'Bad.', retryable: false }, endedAt: START,
      } as never);
    }), 'bad-input');

    repository.mutateRun(run.id, 2, (tx) => tx.settleAttempt('draft', 1, {
      status: 'running', sessionId: 'owner-session',
    }));
    expectRepositoryError(() => repository.mutateRun(run.id, 3, (tx) => {
      tx.settleAttempt('draft', 1, {
        status: 'completed', sessionId: 'foreign-session', output: { text: 'Done.', fields: {} }, endedAt: START,
      });
    }), 'bad-input');
    const terminal = { status: 'completed' as const, sessionId: 'owner-session', output: { text: 'Done.', fields: {} }, endedAt: START };
    repository.mutateRun(run.id, 3, (tx) => tx.settleAttempt('draft', 1, terminal));
    repository.mutateRun(run.id, 4, (tx) => tx.settleAttempt('draft', 1, terminal));
    expectRepositoryError(() => repository.mutateRun(run.id, 4, (tx) => {
      tx.settleAttempt('draft', 1, { status: 'running', sessionId: 'owner-session' });
    }), 'bad-input');

    repository.mutateRun(run.id, 4, (tx) => {
      tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: {} });
    });
    repository.mutateRun(run.id, 5, (tx) => tx.settleAttempt('draft', 2, {
      status: 'failed', error: { code: 'spawn-failed', message: 'Spawn failed.', retryable: true }, endedAt: START,
    }));
    expect(repository.getAttempt(run.id, 'draft', 2)).toMatchObject({ status: 'failed' });
    expect(repository.getAttempt(run.id, 'draft', 2)).not.toHaveProperty('sessionId');
  });

  it('rejects session ownership claims from another attempt in the same or a different run', () => {
    authoredDefinition();
    const first = createRun({ idempotencyKey: 'first-owner' });
    repository.mutateRun(first.id, 1, (tx) => {
      tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: {} });
      tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: {} });
    });
    repository.mutateRun(first.id, 2, (tx) => tx.settleAttempt('draft', 1, {
      status: 'running', sessionId: 'shared-session',
    }));
    const beforeSameRun = repository.getRun(first.workflowId, first.id);
    expectRepositoryError(() => repository.mutateRun(first.id, 3, (tx) => tx.settleAttempt('draft', 2, {
      status: 'running', sessionId: 'shared-session',
    })), 'bad-input');
    expect(repository.getRun(first.workflowId, first.id)).toEqual(beforeSameRun);

    const second = createRun({ idempotencyKey: 'second-owner' });
    repository.mutateRun(second.id, 1, (tx) => {
      tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: {} });
    });
    const beforeCrossRun = repository.getRun(second.workflowId, second.id);
    expectRepositoryError(() => repository.mutateRun(second.id, 2, (tx) => tx.settleAttempt('draft', 1, {
      status: 'running', sessionId: 'shared-session',
    })), 'bad-input');
    expect(repository.getRun(second.workflowId, second.id)).toEqual(beforeCrossRun);
  });

  it('validates mutation payloads before scoped SQL and preserves stored corruption typing', () => {
    authoredDefinition();
    const run = createRun();
    const invalidActions: Array<(tx: WorkflowRunTransaction) => unknown> = [
      (tx: WorkflowRunTransaction) => tx.createAttempt({ nodeId: 'draft', resolvedConfig: { employeeId: 'writer' } as never, input: {} }),
      (tx: WorkflowRunTransaction) => tx.setRunStatus('failed', { endedAt: START, error: { code: 'bad' } as never }),
      (tx: WorkflowRunTransaction) => tx.setNodeStatus('draft', 'completed', { output: { fields: 1 } as never, endedAt: START }),
      (tx: WorkflowRunTransaction) => tx.putApproval({ nodeId: 'approve', status: 'approved', requestedAt: START } as never),
    ];
    for (const action of invalidActions) {
      const prepare = vi.spyOn(db, 'prepare');
      expectRepositoryError(() => repository.mutateRun(run.id, 1, action), 'bad-input');
      expect(prepare).toHaveBeenCalledTimes(1);
      prepare.mockRestore();
    }
    expect(repository.getRun(run.workflowId, run.id)).toMatchObject({ revision: 1, status: 'pending' });
    db.prepare("UPDATE workflow_node_runs SET status = 'unknown' WHERE run_id = ? AND node_id = 'draft'").run(run.id);
    expectRepositoryError(() => repository.mutateRun(run.id, 1, (tx) => tx.setNodeStatus('draft', 'ready')), 'corrupt-record');
  });
});

describe('history, recovery, and wait readers', () => {
  it('lists stable cursor pages with inclusive filters and frozen current/failing projections', () => {
    const definition = authoredDefinition('content-flow', 'Content Pipeline');
    const oldest = createRun({ idempotencyKey: 'old', trigger: { nodeId: 'start', kind: 'manual', payload: {} } });
    repository.mutateRun(oldest.id, 1, (tx) => {
      tx.setRunStatus('running');
      tx.setNodeStatus('draft', 'running', { activated: true, resolvedConfig: { employeeId: 'resolved-writer' } });
    });
    now = '2026-07-21T11:00:00.000Z';
    const failed = createRun({ idempotencyKey: 'failed', trigger: { nodeId: 'event-start', kind: 'event', payload: {} } });
    repository.mutateRun(failed.id, 1, (tx) => {
      tx.setRunStatus('failed', { endedAt: now, error: { code: 'node-failed', message: 'Failed.', retryable: false } });
      tx.setNodeStatus('draft', 'failed', {
        activated: true, resolvedConfig: { employeeId: 'failed-writer' },
        error: { code: 'node-failed', message: 'Failed.', retryable: false }, endedAt: now,
      });
    });
    now = '2026-07-21T12:00:00.000Z';
    const newest = createRun({ idempotencyKey: 'new', trigger: { nodeId: 'start', kind: 'manual', payload: {} } });

    const first = repository.listRuns(definition.id, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([newest.id, failed.id]);
    expect(decodeCursor(first.nextCursor!)).toEqual({
      version: 1, endpoint: 'workflow-runs', startedAt: failed.startedAt, id: failed.id,
    });
    expect(repository.listRuns(definition.id, { limit: 2, cursor: first.nextCursor! }).items.map((item) => item.id))
      .toEqual([oldest.id]);
    expect(repository.listRuns(definition.id, { status: 'failed' }).items[0]?.currentOrFailingNode).toEqual({
      nodeId: 'draft', label: 'Draft content', employeeId: 'failed-writer', state: 'failing',
    });
    expect(repository.listRuns(definition.id, { triggerKind: 'manual', startedFrom: START, startedTo: START }).items[0])
      .toMatchObject({ id: oldest.id, currentOrFailingNode: {
        nodeId: 'draft', label: 'Draft content', employeeId: 'resolved-writer', state: 'current',
      } });
    expect(repository.listRuns(definition.id, { text: 'pipeline' }).items).toHaveLength(3);
    expect(repository.listRuns(definition.id, { text: failed.id }).items.map((item) => item.id)).toEqual([failed.id]);
  });

  it('defaults to 50, accepts 100, and rejects malformed run queries and cursors', () => {
    authoredDefinition();
    for (let index = 0; index < 101; index += 1) {
      now = new Date(Date.UTC(2026, 6, 21, 0, index)).toISOString();
      createRun({ idempotencyKey: `request-${index}` });
    }
    expect(repository.listRuns('content-flow', {}).items).toHaveLength(50);
    expect(repository.listRuns('content-flow', { limit: 100 }).items).toHaveLength(100);
    for (const query of [
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { status: 'unknown' }, { triggerKind: 'unknown' },
      { startedFrom: '2026-07-21T00:00:00Z' }, { startedTo: 'invalid' }, { text: 1 }, { extra: true },
    ]) {
      expectRepositoryError(() => repository.listRuns('content-flow', query as RunListQuery), 'bad-input');
    }
    const cursor = repository.listRuns('content-flow', { limit: 1 }).nextCursor!;
    for (const invalid of [
      '', 'not-base64!', Buffer.from(JSON.stringify({ ...decodeCursor(cursor), endpoint: 'workflow-definitions' })).toString('base64url'),
    ]) {
      expectRepositoryError(() => repository.listRuns('content-flow', { cursor: invalid }), 'bad-cursor');
    }
  });

  it('validates date ranges before SQL and searches frozen node labels without spoofed employees', () => {
    authoredDefinition();
    const run = createRun();
    const prepare = vi.spyOn(db, 'prepare');
    expectRepositoryError(() => repository.listRuns('content-flow', {
      startedFrom: '2026-07-22T00:00:00.000Z', startedTo: START,
    }), 'bad-input');
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();

    repository.mutateRun(run.id, 1, (tx) => {
      tx.setNodeStatus('draft', 'ready', { activated: true });
    });
    expect(repository.listRuns('content-flow', { text: 'draft content' }).items.map((item) => item.id)).toEqual([run.id]);

    const spoofed = createRun({ idempotencyKey: 'spoofed' });
    repository.mutateRun(spoofed.id, 1, (tx) => {
      tx.setNodeStatus('start', 'ready', { activated: true, resolvedConfig: { employeeId: 'spoofed' } });
    });
    expect(repository.listRuns('content-flow', { text: spoofed.id }).items[0]?.currentOrFailingNode).toEqual({
      nodeId: 'start', label: 'Start', employeeId: null, state: 'current',
    });
  });

  it('returns recoverable runs and due waits in deterministic order with inclusive deadlines', () => {
    authoredDefinition();
    const pending = createRun({ idempotencyKey: 'pending' });
    now = '2026-07-21T10:01:00.000Z';
    const waiting = createRun({ idempotencyKey: 'waiting' });
    repository.mutateRun(waiting.id, 1, (tx) => {
      tx.setRunStatus('waiting');
      tx.setNodeStatus('pause', 'waiting', { activated: true, resumeAt: '2026-07-21T10:05:00.000Z' });
    });
    now = '2026-07-21T10:02:00.000Z';
    const completed = createRun({ idempotencyKey: 'completed' });
    repository.mutateRun(completed.id, 1, (tx) => tx.setRunStatus('completed', { endedAt: now }));

    expect(repository.listRecoverableRuns().map((run) => run.id)).toEqual([pending.id, waiting.id]);
    expect(repository.listDueWaits('2026-07-21T10:05:00.000Z', 1)).toEqual([
      expect.objectContaining({ runId: waiting.id, nodeId: 'pause', status: 'waiting' }),
    ]);
    expect(repository.listDueWaits('2026-07-21T10:04:59.999Z', 100)).toEqual([]);
  });
});

describe('validation and corrupt storage', () => {
  it('rejects public inputs before the write lock while valid contention remains SQLITE_BUSY', () => {
    authoredDefinition();
    const blocker = openWorkflowDatabase(join(root, 'workflows.db'));
    db.pragma('busy_timeout = 0');
    blocker.exec('BEGIN IMMEDIATE');
    try {
      expectRepositoryError(() => repository.createRun({
        workflowId: 'Invalid', input: {}, trigger: { nodeId: 'start', kind: 'manual', payload: {} },
      }), 'bad-input');
      expectRepositoryError(() => repository.mutateRun('bad id', 1, () => undefined), 'bad-input');
      expectRepositoryError(() => repository.listDueWaits('not-an-instant', 10), 'bad-input');
      expect(() => createRun({ idempotencyKey: 'contended' })).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  });

  it('rejects proxy callbacks before traps or lock access', () => {
    authoredDefinition();
    const run = createRun();
    const blocker = openWorkflowDatabase(join(root, 'workflows.db'));
    db.pragma('busy_timeout = 0');
    blocker.exec('BEGIN IMMEDIATE');
    let traps = 0;
    const proxy = new Proxy(() => undefined, {
      apply: () => { traps += 1; },
      get: () => { traps += 1; },
      ownKeys: () => { traps += 1; return []; },
    });
    const revoked = Proxy.revocable(() => undefined, {});
    revoked.revoke();
    const prepare = vi.spyOn(db, 'prepare');
    try {
      for (const callback of [proxy, revoked.proxy, {}]) {
        expectRepositoryError(() => repository.mutateRun(run.id, 1, callback as never), 'bad-input');
      }
      expect(traps).toBe(0);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      blocker.exec('ROLLBACK');
      blocker.close();
    }
  });

  it('maps corrupt run, node, attempt, and approval rows to corrupt-record errors', () => {
    authoredDefinition();
    const corruptRun = createRun({ idempotencyKey: 'corrupt-run' });
    db.prepare("UPDATE workflow_runs SET definition_json = '{' WHERE id = ?").run(corruptRun.id);
    expectRepositoryError(() => repository.getRun('content-flow', corruptRun.id), 'corrupt-record');

    const corruptNode = createRun({ idempotencyKey: 'corrupt-node' });
    db.prepare("UPDATE workflow_node_runs SET status = 'unknown' WHERE run_id = ? AND node_id = 'draft'").run(corruptNode.id);
    expectRepositoryError(() => repository.getRun('content-flow', corruptNode.id), 'corrupt-record');

    const corruptActivation = createRun({ idempotencyKey: 'corrupt-activation' });
    db.prepare("UPDATE workflow_node_runs SET activated = 2 WHERE run_id = ? AND node_id = 'draft'").run(corruptActivation.id);
    expectRepositoryError(() => repository.getRun('content-flow', corruptActivation.id), 'corrupt-record');

    const corruptAttempt = createRun({ idempotencyKey: 'corrupt-attempt' });
    repository.mutateRun(corruptAttempt.id, 1, (tx) => {
      tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: {} });
    });
    db.prepare("UPDATE workflow_attempts SET resolved_config_json = '{' WHERE run_id = ?").run(corruptAttempt.id);
    expectRepositoryError(() => repository.listAttempts(corruptAttempt.id, 'draft'), 'corrupt-record');

    const corruptApproval = createRun({ idempotencyKey: 'corrupt-approval' });
    repository.mutateRun(corruptApproval.id, 1, (tx) => {
      tx.putApproval({ nodeId: 'approve', status: 'pending', requestedAt: START });
    });
    db.prepare("UPDATE workflow_approvals SET status = 'unknown' WHERE run_id = ?").run(corruptApproval.id);
    expectRepositoryError(() => repository.getRun('content-flow', corruptApproval.id), 'corrupt-record');

    const corruptTrigger = createRun({ idempotencyKey: 'corrupt-trigger' });
    db.prepare("UPDATE workflow_runs SET trigger_json = '{' WHERE id = ?").run(corruptTrigger.id);
    expectRepositoryError(() => repository.listRuns('content-flow', { triggerKind: 'manual' }), 'corrupt-record');
  });

  it('fails closed on foreign history references and corruption hidden by list filters', () => {
    authoredDefinition();
    const run = createRun();
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO workflow_attempts
      (run_id, node_id, attempt, status, resolved_config_json, input_json, started_at)
      VALUES (?, 'ghost', 1, 'dispatching', ?, '{}', ?)`)
      .run(run.id, JSON.stringify(resolved()), START);
    db.pragma('foreign_keys = ON');
    expectRepositoryError(() => repository.getRun(run.workflowId, run.id), 'corrupt-record');
    expectRepositoryError(() => repository.listRuns(run.workflowId, {
      status: 'completed', text: 'does-not-match', startedFrom: '2026-07-22T00:00:00.000Z',
    }), 'corrupt-record');
    db.prepare("DELETE FROM workflow_attempts WHERE run_id = ? AND node_id = 'ghost'").run(run.id);
    const config = JSON.stringify(resolved());
    db.prepare(`INSERT INTO workflow_attempts
      (run_id,node_id,attempt,session_id,status,resolved_config_json,input_json,started_at) VALUES
      (?,'draft',1,'duplicate-session','running',?,'{}',?),
      (?,'draft',2,'duplicate-session','running',?,'{}',?)`).run(run.id, config, START, run.id, config, START);
    expectRepositoryError(() => repository.findAttemptBySessionId('duplicate-session'), 'corrupt-record');
    expectRepositoryError(() => repository.listRuns(run.workflowId, { text: 'does-not-match' }), 'corrupt-record');
    db.prepare("DELETE FROM workflow_attempts WHERE run_id = ? AND session_id = 'duplicate-session'").run(run.id);

    const cases = [
      ["UPDATE workflow_runs SET status = 'unknown' WHERE id = ?", "UPDATE workflow_runs SET status = 'pending' WHERE id = ?"],
      ["UPDATE workflow_runs SET trigger_json = '{' WHERE id = ?", "UPDATE workflow_runs SET trigger_json = ? WHERE id = ?"],
      ["UPDATE workflow_node_runs SET status = 'unknown' WHERE run_id = ? AND node_id = 'draft'", "UPDATE workflow_node_runs SET status = 'pending' WHERE run_id = ? AND node_id = 'draft'"],
    ] as const;
    for (const [corrupt, repair] of cases) {
      db.prepare(corrupt).run(run.id);
      expectRepositoryError(() => repository.listRuns(run.workflowId, {
        status: 'completed', text: 'does-not-match', startedFrom: '2026-07-22T00:00:00.000Z',
      }), 'corrupt-record');
      if (repair.includes('trigger_json = ?')) {
        db.prepare(repair).run(JSON.stringify(run.trigger), run.id);
      } else {
        db.prepare(repair).run(run.id);
      }
    }
  });

  it('treats a completed attempt without a session as corrupt in detail and filtered history', () => {
    authoredDefinition();
    const run = createRun();
    repository.mutateRun(run.id, 1, (tx) => {
      tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: {} });
    });
    db.prepare(`UPDATE workflow_attempts SET status='completed', output_json=?, ended_at=?
      WHERE run_id=? AND node_id='draft' AND attempt=1`).run(JSON.stringify({ text: 'Done.', fields: {} }), START, run.id);
    expect([
      repositoryErrorCode(() => repository.getRun(run.workflowId, run.id)),
      repositoryErrorCode(() => repository.listRuns(run.workflowId, {
        status: 'cancelled', text: 'not-present', startedFrom: '2026-07-22T00:00:00.000Z',
      })),
    ]).toEqual(['corrupt-record', 'corrupt-record']);
  });

  it('detects exact decoder-invalid semantics independently of list filters', () => {
    authoredDefinition();
    const run = createRun();
    repository.mutateRun(run.id, 1, (tx) => {
      tx.createAttempt({ nodeId: 'draft', resolvedConfig: resolved(), input: {} });
    });
    const hiddenListCode = () => repositoryErrorCode(() => repository.listRuns(run.workflowId, {
      status: 'cancelled', text: 'not-present', startedFrom: '2026-07-22T00:00:00.000Z',
    }));
    const outcomes: string[] = [];
    const attempt = "WHERE run_id=? AND node_id='draft' AND attempt=1";
    db.prepare(`UPDATE workflow_attempts SET resolved_config_json='{}' ${attempt}`).run(run.id);
    outcomes.push(`resolved:${hiddenListCode()}`);
    db.prepare(`UPDATE workflow_attempts SET resolved_config_json=? ${attempt}`).run(JSON.stringify(resolved()), run.id);
    for (const stamp of ['not-an-instant', '2026-07-21T10:00:00Z']) {
      db.prepare(`UPDATE workflow_attempts SET started_at=? ${attempt}`).run(stamp, run.id);
      outcomes.push(`attempt-time:${hiddenListCode()}`);
    }
    db.prepare(`UPDATE workflow_attempts SET started_at=? ${attempt}`).run(START, run.id);
    db.prepare("UPDATE workflow_node_runs SET output_json='{}' WHERE run_id=? AND node_id='draft'").run(run.id);
    outcomes.push(`node-output:${hiddenListCode()}`);
    db.prepare("UPDATE workflow_node_runs SET output_json=NULL WHERE run_id=? AND node_id='draft'").run(run.id);
    db.prepare("UPDATE workflow_runs SET error_json='{}' WHERE id=?").run(run.id);
    outcomes.push(`run-error:${hiddenListCode()}`);
    db.prepare('UPDATE workflow_runs SET error_json=NULL WHERE id=?').run(run.id);
    for (const stamp of ['not-an-instant', '2026-07-21T10:00:00Z']) {
      db.prepare('UPDATE workflow_runs SET started_at=? WHERE id=?').run(stamp, run.id);
      outcomes.push(`run-time:${hiddenListCode()}`);
    }
    db.prepare('UPDATE workflow_runs SET started_at=? WHERE id=?').run(START, run.id);
    db.prepare("UPDATE workflow_runs SET definition_json=json_set(definition_json,'$.schemaVersion',2) WHERE id=?").run(run.id);
    outcomes.push(`schema:${hiddenListCode()}`);
    expect(outcomes).toEqual([
      'resolved:corrupt-record', 'attempt-time:corrupt-record', 'attempt-time:corrupt-record',
      'node-output:corrupt-record', 'run-error:corrupt-record', 'run-time:corrupt-record',
      'run-time:corrupt-record', 'schema:corrupt-record',
    ]);
  });
});
