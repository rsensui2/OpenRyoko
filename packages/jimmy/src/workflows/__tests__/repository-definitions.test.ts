import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { WorkflowDefinition, WorkflowId } from '../model.js';
import {
  WorkflowRepository,
  WorkflowRepositoryError,
  type CreateWorkflowInput,
  type CursorPage,
  type DefinitionListQuery,
  type WorkflowDefinitionSummary,
} from '../repository.js';
import { openWorkflowDatabase } from '../repository-migrations.js';
import { WorkflowService } from '../service.js';

let root: string;
let db: Database.Database;
let repository: WorkflowRepository;
let now: string;
let clockCalls: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jinn-workflow-definitions-'));
  db = openWorkflowDatabase(join(root, 'workflows.db'));
  now = '2026-07-21T00:00:00.000Z';
  clockCalls = 0;
  repository = new WorkflowRepository(db, () => {
    clockCalls += 1;
    return now;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function create(id: string, title = id): WorkflowDefinition {
  return repository.createDefinition({ id, title });
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

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function encodeCursorJson(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function repositoryOutcome(action: () => unknown): string {
  try {
    action();
    return 'accepted';
  } catch (error) {
    if (error instanceof WorkflowRepositoryError) return error.code;
    return error instanceof Error ? error.name : typeof error;
  }
}

function adversarialEnvelopes(id: string): { values: unknown[]; calls: () => number } {
  let calls = 0;
  const valid = { id, title: 'Title' };
  const symbol = { ...valid, [Symbol('extra')]: true };
  const hidden = { id };
  Object.defineProperty(hidden, 'title', { value: 'Title', enumerable: false });
  const accessor = { id };
  Object.defineProperty(accessor, 'title', { enumerable: true, get() { calls += 1; return 'Title'; } });
  const proxy = new Proxy(valid, { get() { calls += 1; throw new Error('trap'); }, ownKeys() { calls += 1; throw new Error('trap'); } });
  const revoked = Proxy.revocable(valid, {});
  revoked.revoke();
  const cycle: Record<string, unknown> = { ...valid };
  cycle.self = cycle;
  class Envelope { id = `${valid.id}-class`; title = valid.title; }
  return {
    values: [null, [], {}, { id }, { ...valid, extra: true }, symbol, hidden, accessor,
      proxy, revoked.proxy, cycle, new Envelope(), { ...valid, id: 1 }, { ...valid, title: 1 }, { ...valid, description: 1 }],
    calls: () => calls,
  };
}

function adversarialQueries(): { values: unknown[]; calls: () => number } {
  let calls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'limit', { enumerable: true, get() { calls += 1; return 1; } });
  const hidden = {};
  Object.defineProperty(hidden, 'limit', { value: 1, enumerable: false });
  const proxy = new Proxy({ limit: 1 }, { get() { calls += 1; throw new Error('trap'); } });
  const statefulTarget = { limit: 1 };
  const stateful = new Proxy(statefulTarget, { ownKeys() { calls += 1; statefulTarget.limit += 1; return ['limit']; } });
  const revoked = Proxy.revocable({ limit: 1 }, {});
  revoked.revoke();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  class Query { limit = 1; }
  return {
    values: [accessor, proxy, stateful, revoked.proxy, { limit: 1, [Symbol('extra')]: true }, hidden,
      [], new Query(), cycle, true, 1, 'Invalid ID', 1n, null, undefined, { extra: true }],
    calls: () => calls,
  };
}

function summary(definition: WorkflowDefinition): WorkflowDefinitionSummary {
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description ?? null,
    revision: definition.revision,
    enabled: definition.enabled,
    retiredAt: definition.retiredAt ?? null,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  };
}

function storedDefinitions(): string {
  return JSON.stringify(db.prepare('SELECT * FROM workflow_definitions ORDER BY id').all());
}

describe('WorkflowRepository public definition contract', () => {
  it('exports the locked Task13 service and workflow identity surface', () => {
    expectTypeOf<WorkflowId>().toEqualTypeOf<WorkflowDefinition['id']>();
    const methods = Object.getOwnPropertyNames(WorkflowService.prototype);
    for (const method of [
      'listDefinitions', 'createDefinition', 'getDefinition', 'saveDefinition', 'duplicateDefinition',
      'setRetired', 'setEnabled', 'startManual', 'fireEvent', 'getRun', 'listRuns',
      'getAttemptTranscript', 'cancelRun', 'rerun', 'recover',
    ]) expect(methods).toContain(method);
  });
  it('exposes the exact Task 10 method and page shapes', () => {
    expectTypeOf(repository.createDefinition).parameter(0).toEqualTypeOf<CreateWorkflowInput>();
    expectTypeOf(repository.listDefinitions).parameter(0).toEqualTypeOf<DefinitionListQuery>();
    expectTypeOf(repository.listDefinitions).returns.toEqualTypeOf<CursorPage<WorkflowDefinitionSummary>>();
    expectTypeOf(repository.getDefinition).returns.toEqualTypeOf<WorkflowDefinition | null>();
  });

  it('exposes every locked repository error code including the Task 11 reservation', () => {
    expectTypeOf<WorkflowRepositoryError['code']>().toEqualTypeOf<
      'not-found' | 'id-conflict' | 'revision-conflict' | 'idempotency-conflict'
      | 'retired' | 'bad-cursor' | 'bad-input' | 'corrupt-record' | 'already-submitted'
    >();
  });
});

describe('public ID validation', () => {
  it('rejects invalid IDs before prepared statements and preserves duplicate priority', () => {
    const adversarial = adversarialQueries();
    const invalidIds = [...adversarial.values, '', 'Invalid', '1workflow', 'under_score', `a${'b'.repeat(64)}`];
    const methods: Array<[string, (id: unknown) => unknown]> = [
      ['get', (id) => repository.getDefinition(id as string)],
      ['enable', (id) => repository.setEnabled(id as string, true, 1)],
      ['retire', (id) => repository.setRetired(id as string, true, 1, now)],
      ['duplicate', (id) => repository.duplicateDefinition(id as string, { id: 'copy', title: 'Copy' })],
    ];
    const prepare = vi.spyOn(db, 'prepare');
    const priority = expectRepositoryError(
      () => repository.duplicateDefinition(adversarial.values[1] as string, { id: 'Invalid', title: 'Copy' }),
      'bad-input',
    );
    expect(priority.message).toBe('Workflow definition is invalid.');
    expect(adversarial.calls()).toBe(0);
    expect(methods.flatMap(([name, method]) => invalidIds.map((id) => [name, repositoryOutcome(() => method(id))])))
      .toEqual(methods.flatMap(([name]) => invalidIds.map(() => [name, 'bad-input'])));
    expect(adversarial.calls()).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe('validation before immediate transactions', () => {
  it('rejects deterministic write inputs before contention while preserving real SQLITE_BUSY', () => {
    const saveSource = create('lock-save');
    const enableSource = create('lock-enable');
    const retireSource = create('lock-retire');
    const duplicateSource = create('lock-duplicate');
    const before = storedDefinitions();
    const canonicalNow = now;
    const adversarial = adversarialQueries();
    const cases: Array<[string, unknown, WorkflowRepositoryError['code'], () => unknown]> = [
      ['create target', canonicalNow, 'bad-input', () => repository.createDefinition({ id: 'Invalid', title: 'Title' })],
      ['duplicate target', canonicalNow, 'bad-input', () => repository.duplicateDefinition(duplicateSource.id, { id: 'Invalid', title: 'Copy' })],
      ['duplicate source accessor', canonicalNow, 'bad-input', () => repository.duplicateDefinition(adversarial.values[0] as string, { id: 'copy-a', title: 'Copy' })],
      ['duplicate source proxy', canonicalNow, 'bad-input', () => repository.duplicateDefinition(adversarial.values[1] as string, { id: 'copy-b', title: 'Copy' })],
      ['save definition', canonicalNow, 'bad-input', () => repository.saveDefinition({ ...saveSource, title: '' }, 1)],
      ['save revision', canonicalNow, 'revision-conflict', () => repository.saveDefinition(saveSource, 1.5)],
      ['enable id', canonicalNow, 'bad-input', () => repository.setEnabled('Invalid', true, 1)],
      ['enable state', canonicalNow, 'bad-input', () => repository.setEnabled(enableSource.id, 'yes' as unknown as boolean, 1)],
      ['enable revision', canonicalNow, 'revision-conflict', () => repository.setEnabled(enableSource.id, true, 1.5)],
      ['retire id', canonicalNow, 'bad-input', () => repository.setRetired('Invalid', true, 1, canonicalNow)],
      ['retire revision', canonicalNow, 'revision-conflict', () => repository.setRetired(retireSource.id, true, 1.5, canonicalNow)],
      ['retire at', canonicalNow, 'bad-input', () => repository.setRetired(retireSource.id, true, 1, 1 as unknown as string)],
      ['create clock', '2026-07-21T00:00:00Z', 'bad-input', () => create('lock-clock-create')],
      ['duplicate clock', 1, 'bad-input', () => repository.duplicateDefinition(duplicateSource.id, { id: 'lock-clock-copy', title: 'Copy' })],
      ['save clock', 'not-an-instant', 'bad-input', () => repository.saveDefinition(saveSource, 1)],
      ['enable clock', '2026-07-21T00:00:00.000+00:00', 'bad-input', () => repository.setEnabled(enableSource.id, true, 1)],
      ['retire clock', null, 'bad-input', () => repository.setRetired(retireSource.id, true, 1, canonicalNow)],
    ];
    const blocker = openWorkflowDatabase(join(root, 'workflows.db'));
    db.pragma('busy_timeout = 0');
    blocker.exec('BEGIN IMMEDIATE');
    const prepare = vi.spyOn(db, 'prepare');
    let contention: unknown;
    let prepareCalls = 0;
    let results: Array<[string, string]> = [];
    try {
      results = cases.map(([name, stamp, , action]) => {
        now = stamp as string;
        return [name, repositoryOutcome(action)];
      });
      now = canonicalNow;
      try { create('valid-under-lock'); } catch (error) { contention = error; }
    } finally {
      prepareCalls = prepare.mock.calls.length;
      prepare.mockRestore();
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    expect(results).toEqual(cases.map(([name, , code]) => [name, code]));
    expect(adversarial.calls()).toBe(0);
    expect(prepareCalls).toBe(0);
    expect(contention).toMatchObject({ name: 'SqliteError', code: 'SQLITE_BUSY' });
    expect(contention).not.toBeInstanceOf(WorkflowRepositoryError);
    expect(storedDefinitions()).toBe(before);

    now = canonicalNow;
    const callsBeforeCrud = clockCalls;
    const created = create('after-lock');
    const saved = repository.saveDefinition({ ...created, title: 'Saved' }, 1);
    const enabled = repository.setEnabled(saved.id, true, saved.revision);
    const copy = repository.duplicateDefinition(enabled.id, { id: 'after-lock-copy', title: 'Copy' });
    const retired = repository.setRetired(enabled.id, true, enabled.revision, canonicalNow);
    expect({ saved: saved.revision, enabled: enabled.enabled, copy: copy.revision,
      retired: retired.retiredAt, read: repository.getDefinition(copy.id)?.id })
      .toEqual({ saved: 2, enabled: true, copy: 1, retired: canonicalNow, read: copy.id });
    expect(clockCalls - callsBeforeCrud).toBe(5);
  });
});

describe('createDefinition and getDefinition', () => {
  it('uses the caller ID and one transaction-clock value for canonical disabled defaults', () => {
    const created = repository.createDefinition({
      id: 'content-pipeline',
      title: 'Content pipeline',
      description: 'Prepare and review content.',
    });

    expect(created).toEqual({
      schemaVersion: 1,
      id: 'content-pipeline',
      title: 'Content pipeline',
      description: 'Prepare and review content.',
      revision: 1,
      enabled: false,
      nodes: [],
      edges: [],
      createdAt: now,
      updatedAt: now,
    });
    expect(created).not.toHaveProperty('retiredAt');
    expect(clockCalls).toBe(1);
    expect(repository.getDefinition(created.id)).toEqual(created);
    expect(repository.getDefinition('missing-workflow')).toBeNull();

    const row = db.prepare('SELECT retired_at, definition_json FROM workflow_definitions WHERE id = ?')
      .get(created.id) as { retired_at: string | null; definition_json: string };
    expect(row.retired_at).toBeNull();
    expect(JSON.parse(row.definition_json)).not.toHaveProperty('retiredAt');
  });

  it('rejects duplicate IDs without replacing the stable original', () => {
    const original = create('stable-id', 'Original');
    expectRepositoryError(
      () => repository.createDefinition({ id: 'stable-id', title: 'Replacement' }),
      'id-conflict',
    );
    expect(repository.getDefinition('stable-id')).toEqual(original);
  });

  it.each([
    [{ id: '', title: 'Title' }, 'invalid ID'],
    [{ id: 'Invalid', title: 'Title' }, 'invalid ID grammar'],
    [{ id: 'valid-id', title: '' }, 'empty title'],
    [{ id: 'valid-id', title: 'x'.repeat(121) }, 'long title'],
  ])('rejects bad create input: %s (%s)', (input) => {
    expectRepositoryError(() => repository.createDefinition(input), 'bad-input');
  });

  it('rejects the reserved Event identity at create, save, and duplicate boundaries', () => {
    const source = create('event-source');

    expectRepositoryError(() => repository.createDefinition({ id: 'events', title: 'Reserved' }), 'bad-input');
    expectRepositoryError(() => repository.saveDefinition({ ...source, id: 'events' }, source.revision), 'bad-input');
    expectRepositoryError(() => repository.duplicateDefinition(source.id, { id: 'events', title: 'Reserved' }), 'bad-input');
    expect(db.prepare("SELECT COUNT(*) FROM workflow_definitions WHERE id = 'events'").pluck().get()).toBe(0);
    expect(repository.getDefinition(source.id)).toEqual(source);
  });

  it('normalizes exact safe envelopes without mutation and rejects hostile envelopes', () => {
    const input = Object.assign(Object.create(null), { id: 'null-prototype', title: 'Null prototype' }) as CreateWorkflowInput;
    repository.createDefinition(input);
    expect(input).toEqual({ id: 'null-prototype', title: 'Null prototype' });
    expect(Object.getPrototypeOf(input)).toBeNull();

    const adversarial = adversarialEnvelopes('invalid-create');
    expect(adversarial.values.map((value) => repositoryOutcome(
      () => repository.createDefinition(value as CreateWorkflowInput),
    ))).toEqual(adversarial.values.map(() => 'bad-input'));
    expect(adversarial.calls()).toBe(0);
  });
});

describe('canonical definition persistence', () => {
  it('roundtrips the exact canonical graph JSON', () => {
    const created = create('review-flow', 'Review flow');
    now = '2026-07-21T01:00:00.000Z';
    const changed: WorkflowDefinition = {
      ...created,
      description: 'Review a prepared artifact.',
      inputs: [{ key: 'topic', label: 'Topic', type: 'string', required: true, default: 'release' }],
      nodes: [
        { id: 'start', type: 'trigger', name: 'Start', config: { kind: 'manual' } },
        {
          id: 'review', type: 'employee', name: 'Review',
          config: {
            employee: { source: 'input', path: 'reviewer' },
            prompt: 'Review {{ input.topic }}.',
            output: { fields: { approved: { type: 'boolean', required: true } }, allowAdditionalFields: false },
          },
        },
      ],
      edges: [{ id: 'start-review', from: { nodeId: 'start', port: 'success' }, to: { nodeId: 'review', port: 'input' } }],
      ui: { positions: { start: { x: 0, y: 0 }, review: { x: 180, y: 0 } } },
    };

    const saved = repository.saveDefinition(changed, 1);
    expect(saved).toEqual({ ...changed, revision: 2, updatedAt: now });
    expect(repository.getDefinition(created.id)).toEqual(saved);

    const json = db.prepare('SELECT definition_json FROM workflow_definitions WHERE id = ?')
      .pluck().get(created.id) as string;
    expect(JSON.parse(json)).toEqual(saved);
  });

  it('rejects invalid canonical definitions without changing the row', () => {
    const created = create('valid-workflow');
    const invalid = { ...created, title: '' } as WorkflowDefinition;
    expectRepositoryError(() => repository.saveDefinition(invalid, 1), 'bad-input');
    expect(repository.getDefinition(created.id)).toEqual(created);
  });

  it('reports which field failed the schema instead of a bare "definition is invalid"', () => {
    const created = create('schema-detail');
    const invalid = { ...created, nodes: [{ id: 'start', type: 'trigger', name: '', config: { kind: 'manual' } }] } as WorkflowDefinition;

    let thrown: unknown;
    try { repository.saveDefinition(invalid, 1); } catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(WorkflowRepositoryError);
    expect((thrown as WorkflowRepositoryError).issues).toEqual([
      expect.objectContaining({ code: 'schema', path: 'nodes.0.name' }),
    ]);
  });

  it('fails every definition read that encounters corrupt JSON', () => {
    create('corrupt-get');
    db.prepare("UPDATE workflow_definitions SET definition_json = '{' WHERE id = 'corrupt-get'").run();
    expectRepositoryError(() => repository.getDefinition('corrupt-get'), 'corrupt-record');

    create('corrupt-list');
    expectRepositoryError(() => repository.listDefinitions({}), 'corrupt-record');
    expectRepositoryError(
      () => repository.duplicateDefinition('corrupt-get', { id: 'copy', title: 'Copy' }),
      'corrupt-record',
    );
  });
});

describe('optimistic revision mutations', () => {
  it('increments exactly once for save and rejects stale expected revisions', () => {
    const created = create('revisioned', 'Revision one');
    now = '2026-07-21T01:00:00.000Z';
    const saved = repository.saveDefinition({ ...created, title: 'Revision two' }, 1);
    expect(saved).toMatchObject({ revision: 2, title: 'Revision two', updatedAt: now });
    expectRepositoryError(
      () => repository.saveDefinition({ ...saved, title: 'Stale write' }, 1),
      'revision-conflict',
    );
    expect(repository.getDefinition(created.id)).toEqual(saved);
  });

  it('persists a canvas-only move without spending a revision, and still versions the next graph edit', () => {
    const created = create('dragged', 'Dragged');
    const graph = repository.saveDefinition({
      ...created,
      nodes: [{ id: 'start', type: 'trigger', name: 'Start', config: { kind: 'manual' } }],
      ui: { positions: { start: { x: 0, y: 0 } } },
    } as WorkflowDefinition, 1);
    expect(graph.revision).toBe(2);

    now = '2026-07-21T02:00:00.000Z';
    const dragged = repository.saveDefinition({ ...graph, ui: { positions: { start: { x: 320, y: 96 } }, layout: 'manual' } }, 2);
    expect(dragged).toMatchObject({ revision: 2, updatedAt: now, ui: { positions: { start: { x: 320, y: 96 } }, layout: 'manual' } });
    expect(repository.getDefinition(created.id)).toEqual(dragged);

    const renamed = repository.saveDefinition({ ...dragged, title: 'Renamed' }, 2);
    expect(renamed).toMatchObject({ revision: 3, title: 'Renamed' });
  });

  it('rejects invalid repository clocks before every write and roundtrips emitted cursors', () => {
    const saved = create('clock-save');
    const enabled = create('clock-enable');
    const retired = create('clock-retire');
    const duplicated = create('clock-duplicate');
    const cases: Array<[unknown, () => unknown]> = [
      ['2026-07-21T00:00:00Z', () => create('clock-create')],
      ['not-an-instant', () => repository.saveDefinition({ ...saved, title: 'Changed' }, saved.revision)],
      [1, () => repository.setEnabled(enabled.id, true, enabled.revision)],
      ['2026-07-21T00:00:00Z', () => repository.setRetired(
        retired.id, true, retired.revision, '2026-07-21T00:30:00.000Z',
      )],
      ['not-an-instant', () => repository.duplicateDefinition(duplicated.id, { id: 'clock-copy', title: 'Copy' })],
    ];
    const results = cases.map(([stamp, action]) => {
      const before = storedDefinitions();
      now = stamp as string;
      return { outcome: repositoryOutcome(action), unchanged: storedDefinitions() === before };
    });
    expect(results).toEqual(cases.map(() => ({ outcome: 'bad-input', unchanged: true })));

    now = '2026-07-21T01:00:00.000Z';
    create('clock-cursor-a');
    create('clock-cursor-b');
    const first = repository.listDefinitions({ limit: 1 });
    expect(repository.listDefinitions({ limit: 1, cursor: first.nextCursor! }).items).toHaveLength(1);
  });

  it('increments exactly once per enable transition', () => {
    const created = create('enable-flow');
    now = '2026-07-21T02:00:00.000Z';
    const enabled = repository.setEnabled(created.id, true, 1);
    expect(enabled).toMatchObject({ enabled: true, revision: 2, updatedAt: now });
    now = '2026-07-21T03:00:00.000Z';
    const disabled = repository.setEnabled(created.id, false, 2);
    expect(disabled).toMatchObject({ enabled: false, revision: 3, updatedAt: now });
    expectRepositoryError(() => repository.setEnabled(created.id, true, 2), 'revision-conflict');
  });

  it('retires once, disables the definition, and rejects later mutations', () => {
    const created = create('retire-flow');
    const enabled = repository.setEnabled(created.id, true, 1);
    now = '2026-07-21T04:00:00.000Z';
    const retiredAt = '2026-07-21T03:30:00.000Z';
    const retired = repository.setRetired(created.id, true, enabled.revision, retiredAt);

    expect(retired).toMatchObject({ enabled: false, retiredAt, revision: 3, updatedAt: now });
    expect(db.prepare('SELECT retired_at FROM workflow_definitions WHERE id = ?').pluck().get(created.id)).toBe(retiredAt);
    expectRepositoryError(() => repository.setEnabled(created.id, true, retired.revision), 'retired');
    expectRepositoryError(() => repository.saveDefinition({ ...retired, title: 'Changed' }, retired.revision), 'retired');
    expectRepositoryError(() => repository.setRetired(created.id, true, retired.revision, retiredAt), 'retired');
  });

  it('distinguishes missing rows from revision conflicts', () => {
    expectRepositoryError(() => repository.setEnabled('missing', true, 1), 'not-found');
    expectRepositoryError(() => repository.setRetired('missing', true, 1, now), 'not-found');
    const absent: WorkflowDefinition = {
      schemaVersion: 1, id: 'missing', title: 'Missing', revision: 1, enabled: false,
      nodes: [], edges: [], createdAt: now, updatedAt: now,
    };
    expectRepositoryError(() => repository.saveDefinition(absent, 1), 'not-found');
  });
});

describe('duplicateDefinition', () => {
  it('copies authored content while resetting identity, lifecycle, revision, and timestamps', () => {
    const source = create('source-flow', 'Source');
    const saved = repository.saveDefinition({ ...source, description: 'Source description' }, 1);
    repository.setEnabled(source.id, true, saved.revision);
    now = '2026-07-21T05:00:00.000Z';
    const callsBeforeDuplicate = clockCalls;

    const copy = repository.duplicateDefinition(source.id, { id: 'copied-flow', title: 'Copied flow' });
    expect(copy).toEqual({
      ...saved,
      id: 'copied-flow',
      title: 'Copied flow',
      revision: 1,
      enabled: false,
      createdAt: now,
      updatedAt: now,
    });
    expect(copy).not.toHaveProperty('retiredAt');
    expect(clockCalls - callsBeforeDuplicate).toBe(1);
    expect(repository.getDefinition(source.id)).toMatchObject({ enabled: true, revision: 3 });
  });

  it('validates duplicate targets before source lookup without leaking source existence', () => {
    const invalidTargets = [
      { id: 'Invalid', title: 'Copy' },
      { id: 'copy', title: '' },
      { id: 'copy', title: 'x'.repeat(121) },
    ];
    expect(invalidTargets.map((input) => repositoryOutcome(
      () => repository.duplicateDefinition('missing', input),
    ))).toEqual(invalidTargets.map(() => 'bad-input'));
    expectRepositoryError(
      () => repository.duplicateDefinition('missing', { id: 'copy', title: 'Copy' }),
      'not-found',
    );
    create('existing');
    expect(invalidTargets.map((input) => repositoryOutcome(
      () => repository.duplicateDefinition('existing', input),
    ))).toEqual(invalidTargets.map(() => 'bad-input'));
    expectRepositoryError(
      () => repository.duplicateDefinition('existing', { id: 'existing', title: 'Copy' }),
      'id-conflict',
    );
  });

  it('normalizes exact duplicate envelopes and rejects every hostile envelope', () => {
    create('duplicate-source');
    const input = Object.assign(Object.create(null), { id: 'null-prototype-copy', title: 'Copy' });
    repository.duplicateDefinition('duplicate-source', input);
    expect(input).toEqual({ id: 'null-prototype-copy', title: 'Copy' });
    expect(Object.getPrototypeOf(input)).toBeNull();

    const adversarial = adversarialEnvelopes('invalid-copy');
    const values = [...adversarial.values, { id: 'description-copy', title: 'Copy', description: 'extra' }];
    expect(values.map((value) => repositoryOutcome(
      () => repository.duplicateDefinition('duplicate-source', value as { id: string; title: string }),
    ))).toEqual(values.map(() => 'bad-input'));
    expect(adversarial.calls()).toBe(0);
  });
});

describe('listDefinitions pagination and filters', () => {
  it('defaults to 50, accepts 100, and rejects all invalid limits', () => {
    for (let index = 0; index < 105; index += 1) {
      now = new Date(Date.UTC(2026, 6, 21, 6, index)).toISOString();
      create(`workflow-${String(index).padStart(3, '0')}`);
    }
    expect(repository.listDefinitions({}).items).toHaveLength(50);
    expect(repository.listDefinitions({ limit: 100 }).items).toHaveLength(100);
    for (const limit of [0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectRepositoryError(() => repository.listDefinitions({ limit }), 'bad-input');
    }
  });

  it('uses stable updatedAt DESC and id DESC keyset pagination', () => {
    now = '2026-07-21T07:00:00.000Z';
    const first = create('alpha');
    const beta = create('beta');
    now = '2026-07-21T08:00:00.000Z';
    const gamma = create('gamma');

    const pageOne = repository.listDefinitions({ limit: 2 });
    expect(pageOne.items).toEqual([summary(gamma), summary(beta)]);
    expect(pageOne.nextCursor).not.toBeNull();
    now = '2026-07-21T09:00:00.000Z';
    create('newer-after-cursor');
    const pageTwo = repository.listDefinitions({ limit: 2, cursor: pageOne.nextCursor! });
    expect(pageTwo).toEqual({ items: [summary(first)], nextCursor: null });
  });

  it('filters enabled state and retired state with locked omitted behavior', () => {
    create('disabled');
    const active = create('active');
    const retiredSource = create('retired-source');
    const retiredEnabledSource = create('retired-enabled-source');
    repository.setEnabled(active.id, true, active.revision);
    repository.setRetired(retiredSource.id, true, retiredSource.revision, '2026-07-21T10:00:00.000Z');
    const enabled = repository.setEnabled(retiredEnabledSource.id, true, retiredEnabledSource.revision);
    repository.setRetired(enabled.id, true, enabled.revision, '2026-07-21T10:00:00.000Z');

    expect(repository.listDefinitions({}).items.map((item) => item.id).sort()).toEqual(['active', 'disabled']);
    expect(repository.listDefinitions({ retired: false }).items.map((item) => item.id).sort()).toEqual(['active', 'disabled']);
    expect(repository.listDefinitions({ enabled: true }).items.map((item) => item.id)).toEqual(['active']);
    expect(repository.listDefinitions({ enabled: false }).items.map((item) => item.id)).toEqual(['disabled']);
    expect(repository.listDefinitions({ retired: true }).items.map((item) => item.id).sort())
      .toEqual(['retired-enabled-source', 'retired-source']);
    expect(repository.listDefinitions({ retired: true, enabled: true }).items).toEqual([]);
  });
});

describe('listDefinitions validation', () => {
  it('normalizes exact null-prototype queries without mutation', () => {
    create('alpha');
    create('beta');
    const cursor = repository.listDefinitions({ limit: 1 }).nextCursor!;
    const query = Object.assign(Object.create(null), { cursor, limit: 1, enabled: false, retired: false });
    expect(repository.listDefinitions(query).items.map((item) => item.id)).toEqual(['alpha']);
    expect({ ...query }).toEqual({ cursor, limit: 1, enabled: false, retired: false });
    expect(Object.getPrototypeOf(query)).toBeNull();
    expect(repository.listDefinitions({}).items).toHaveLength(2);
  });

  it('rejects hostile query envelopes without traps or prepared statements', () => {
    const adversarial = adversarialQueries();
    const prepare = vi.spyOn(db, 'prepare');
    expect(adversarial.values.map((query) => repositoryOutcome(
      () => repository.listDefinitions(query as DefinitionListQuery),
    ))).toEqual(adversarial.values.map(() => 'bad-input'));
    expect(adversarial.calls()).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects malformed, wrong-endpoint, and unknown-version cursors', () => {
    create('alpha');
    create('beta');
    for (const cursor of [null, 1, true, {}, []]) {
      expectRepositoryError(() => repository.listDefinitions({ cursor } as unknown as DefinitionListQuery), 'bad-cursor');
    }
    const valid = repository.listDefinitions({ limit: 1 }).nextCursor!;
    const decoded = decodeCursor(valid);
    for (const cursor of [
      '', 'not-base64!', `${valid}!`, encodeCursor(null), encodeCursor({}),
      encodeCursor({ ...decoded, endpoint: 'workflow-runs' }),
      encodeCursor({ ...decoded, version: 2 }),
      encodeCursor({ ...decoded, updatedAt: 1 }),
      encodeCursor({ ...decoded, id: null }),
    ]) {
      expectRepositoryError(() => repository.listDefinitions({ cursor }), 'bad-cursor');
    }
  });

  it('rejects noncanonical cursor JSON and invalid tuple values', () => {
    create('alpha');
    create('beta');
    const valid = repository.listDefinitions({ limit: 1 }).nextCursor!;
    const decoded = decodeCursor(valid);
    const canonicalJson = Buffer.from(valid, 'base64url').toString('utf8');
    const idJson = JSON.stringify(decoded.id);
    const invalid = [
      encodeCursorJson(JSON.stringify({ id: decoded.id, updatedAt: decoded.updatedAt, endpoint: decoded.endpoint, version: decoded.version })),
      encodeCursorJson(`${canonicalJson} `),
      encodeCursorJson(canonicalJson.replace(`"id":${idJson}`, `"id":${idJson},"id":${idJson}`)),
      encodeCursor({ ...decoded, extra: true }), `${valid}=`,
      ...['', 'not-an-instant', '2026-07-21T00:00:00Z', '2026-07-21T00:00:00.000+00:00',
        '2026-02-30T00:00:00.000Z'].map((updatedAt) => encodeCursor({ ...decoded, updatedAt })),
      ...['', 'Invalid ID', 'Invalid', '1workflow', 'under_score', `a${'b'.repeat(64)}`]
        .map((id) => encodeCursor({ ...decoded, id })),
    ];
    expect(invalid.map((cursor) => repositoryOutcome(
      () => repository.listDefinitions({ cursor }),
    ))).toEqual(invalid.map(() => 'bad-cursor'));
  });

  it('rejects non-boolean filters as bad input', () => {
    expectRepositoryError(
      () => repository.listDefinitions({ enabled: 'true' } as unknown as DefinitionListQuery),
      'bad-input',
    );
    expectRepositoryError(
      () => repository.listDefinitions({ retired: 1 } as unknown as DefinitionListQuery),
      'bad-input',
    );
  });
});
