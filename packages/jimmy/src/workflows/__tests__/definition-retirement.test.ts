import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletionListener } from '../../shared/types.js';
import type { WorkflowDefinition, WorkflowNode } from '../model.js';
import { openWorkflowDatabase } from '../repository-migrations.js';
import { WorkflowRepository, WorkflowRepositoryError } from '../repository.js';
import type { WorkflowSessionExecutor } from '../session-executor.js';
import { WorkflowService } from '../service.js';

/* Retiring used to be a trapdoor: `retired_at` was set and nothing could clear it,
 * so an archived Workflow was frozen out of every other mutation for good. These
 * cover the way back, and the guards that keep each direction one-way per call. */

class Executor {
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    return { sessionId: `session:${command.owner.runId}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  readTerminalCompletion(): null { return null; }
}

const employee: Employee = { name: 'worker', displayName: 'Worker', department: 'operations', rank: 'employee',
  engine: 'test-engine', model: 'test-model', effortLevel: 'high', persona: 'Complete work.' };
const models: ModelRegistry = { 'test-engine': { name: 'test-engine', available: true, defaultModel: 'test-model',
  effortMechanism: 'codex-config', models: [{ id: 'test-model', label: 'Test', supportsEffort: true, effortLevels: ['high'] }] } };
const trigger: WorkflowNode = { id: 'start', type: 'trigger', name: 'Start', config: { kind: 'manual' } };
const finish: WorkflowNode = { id: 'finish', type: 'end', name: 'Finish', config: { result: 'success' } };
const edges = [{ id: 'start-finish', from: { nodeId: 'start', port: 'success' as const },
  to: { nodeId: 'finish', port: 'input' as const } }];

const RETIRED_AT = '2026-07-21T03:30:00.000Z';

let root: string;
let db: Database.Database;
let repository: WorkflowRepository;
let definitionChanges: Array<{ workflowId: string; revision: number }>;
let service: WorkflowService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-workflow-retirement-'));
  db = openWorkflowDatabase(path.join(root, 'workflows.db'));
  repository = new WorkflowRepository(db, () => '2026-07-21T04:00:00.000Z');
  definitionChanges = [];
  service = new WorkflowService({
    repository,
    executor: new Executor() as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]),
    models: () => models,
    onDefinitionChange: (change) => definitionChanges.push(change),
    now: () => RETIRED_AT,
  });
});

afterEach(() => {
  service.dispose();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A runnable definition: a manual trigger a run can be created against. */
function runnable(id: string): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  return repository.saveDefinition({ ...created, nodes: [trigger, finish], edges }, created.revision);
}

function retiredColumn(id: string): string | null {
  return db.prepare('SELECT retired_at FROM workflow_definitions WHERE id = ?').pluck().get(id) as string | null;
}

function expectCode(action: () => unknown, code: WorkflowRepositoryError['code']): void {
  expect(action).toThrow(expect.objectContaining({ name: 'WorkflowRepositoryError', code }));
}

describe('WorkflowRepository.setRetired', () => {
  it('clears the retirement, bumps the revision, and leaves the definition disabled', () => {
    const created = repository.createDefinition({ id: 'round-trip', title: 'Round trip' });
    const enabled = repository.setEnabled(created.id, true, created.revision);
    const retired = repository.setRetired(created.id, true, enabled.revision, RETIRED_AT);
    expect(retired).toMatchObject({ enabled: false, retiredAt: RETIRED_AT, revision: 3 });

    const unretired = repository.setRetired(created.id, false, retired.revision, RETIRED_AT);

    expect(unretired).not.toHaveProperty('retiredAt');
    expect(unretired).toMatchObject({ enabled: false, revision: 4 });
    // The column and the JSON blob are written separately, and a disagreement
    // between them is what `parseStoredDefinition` reports as a corrupt record.
    expect(retiredColumn(created.id)).toBeNull();
    expect(repository.getDefinition(created.id)).toEqual(unretired);
  });

  it('leaves the row untouched when the expected revision is stale', () => {
    const created = repository.createDefinition({ id: 'stale', title: 'Stale' });
    const retired = repository.setRetired(created.id, true, created.revision, RETIRED_AT);

    expectCode(() => repository.setRetired(created.id, false, retired.revision - 1, RETIRED_AT), 'revision-conflict');

    expect(repository.getDefinition(created.id)).toEqual(retired);
    expect(retiredColumn(created.id)).toBe(RETIRED_AT);
  });

  it('refuses to unretire a definition that is not retired', () => {
    const created = repository.createDefinition({ id: 'live', title: 'Live' });

    expectCode(() => repository.setRetired(created.id, false, created.revision, RETIRED_AT), 'bad-input');

    expect(repository.getDefinition(created.id)).toEqual(created);
  });

  it('still refuses to retire a definition that is already retired', () => {
    const created = repository.createDefinition({ id: 'twice', title: 'Twice' });
    const retired = repository.setRetired(created.id, true, created.revision, RETIRED_AT);

    expectCode(() => repository.setRetired(created.id, true, retired.revision, RETIRED_AT), 'retired');
  });

  it('reports a missing definition as not-found', () => {
    expectCode(() => repository.setRetired('missing', false, 1, RETIRED_AT), 'not-found');
  });

  it('validates its arguments before taking the write lock', () => {
    const created = repository.createDefinition({ id: 'guarded', title: 'Guarded' });
    const prepare = vi.spyOn(db, 'prepare');

    expectCode(() => repository.setRetired('Invalid', false, 1, RETIRED_AT), 'bad-input');
    expectCode(() => repository.setRetired(created.id, 'yes' as unknown as boolean, 1, RETIRED_AT), 'bad-input');
    expectCode(() => repository.setRetired(created.id, true, 1.5, RETIRED_AT), 'revision-conflict');
    expectCode(() => repository.setRetired(created.id, true, 1, 1 as unknown as string), 'bad-input');

    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
  });

  it('makes the definition editable and enable-able again', () => {
    const created = runnable('editable');
    const retired = repository.setRetired(created.id, true, created.revision, RETIRED_AT);
    expectCode(() => repository.setEnabled(created.id, true, retired.revision), 'retired');
    expectCode(() => repository.saveDefinition({ ...retired, title: 'Changed' }, retired.revision), 'retired');

    const unretired = repository.setRetired(created.id, false, retired.revision, RETIRED_AT);
    const saved = repository.saveDefinition({ ...unretired, title: 'Changed' }, unretired.revision);
    const enabled = repository.setEnabled(saved.id, true, saved.revision);

    expect(enabled).toMatchObject({ title: 'Changed', enabled: true });
  });

  it('keeps the runs a definition had before it was archived', () => {
    const created = runnable('with-runs');
    const run = repository.createRun({ workflowId: created.id, input: {},
      trigger: { nodeId: 'start', kind: 'manual', payload: {} } });
    const retired = repository.setRetired(created.id, true, created.revision, RETIRED_AT);

    expect(repository.listRuns(created.id, {}).items.map((item) => item.id)).toEqual([run.id]);

    repository.setRetired(created.id, false, retired.revision, RETIRED_AT);

    expect(repository.listRuns(created.id, {}).items.map((item) => item.id)).toEqual([run.id]);
  });
});

describe('WorkflowService.setRetired', () => {
  it('reports the change so triggers are rebuilt in both directions', () => {
    const created = service.createDefinition({ id: 'notified', title: 'Notified' });
    const retired = service.setRetired({ id: created.id, retired: true, expectedRevision: created.revision });
    definitionChanges.length = 0;

    const unretired = service.setRetired({ id: created.id, retired: false, expectedRevision: retired.revision });

    expect(unretired).not.toHaveProperty('retiredAt');
    expect(unretired.enabled).toBe(false);
    expect(definitionChanges).toEqual([{ workflowId: created.id, revision: unretired.revision }]);
  });

  it('stamps the retirement with the service clock', () => {
    const created = service.createDefinition({ id: 'stamped', title: 'Stamped' });

    const retired = service.setRetired({ id: created.id, retired: true, expectedRevision: created.revision });

    expect(retired.retiredAt).toBe(RETIRED_AT);
  });
});
