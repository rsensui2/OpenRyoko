import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Employee, ModelRegistry } from '../../shared/types.js';
import type { EmployeeNode, WorkflowDefinition, WorkflowNode } from '../model.js';
import { resolveDispatch, type DispatchResolutionDeps } from '../node-dispatch.js';
import { openWorkflowDatabase } from '../repository-migrations.js';
import { WorkflowRepository } from '../repository.js';
import type { WorkflowRunDetail } from '../runtime.js';

/**
 * ICI-733: a Todo bound to a workflow run can redirect the NEXT attempt onto
 * another engine or model. The point is recovery — a run whose attempts keep
 * dying on one engine has to be movable without editing the workflow — so the
 * Todo's word beats both the node's own config and the employee's default.
 */

const WORKER: Employee = {
  name: 'worker', displayName: 'Worker', department: 'platform', rank: 'employee',
  engine: 'codex', model: 'gpt-5.6-sol', persona: 'works',
} as unknown as Employee;

const MODELS: ModelRegistry = {
  codex: {
    available: true, defaultModel: 'gpt-5.6-sol',
    models: [{ id: 'gpt-5.6-sol', supportsEffort: true, effortLevels: ['low', 'high'] }, { id: 'gpt-5.5', supportsEffort: false, effortLevels: [] }],
  },
  claude: {
    available: true, defaultModel: 'opus',
    models: [{ id: 'opus', supportsEffort: false, effortLevels: [] }, { id: 'sonnet', supportsEffort: false, effortLevels: [] }],
  },
} as unknown as ModelRegistry;

function nodes(config: Partial<EmployeeNode['config']> = {}): WorkflowNode[] {
  return [
    { id: 'start', type: 'trigger', name: 'Start', config: { kind: 'manual' } },
    { id: 'work', type: 'employee', name: 'Work', config: {
      employee: { source: 'fixed', value: 'worker' }, prompt: 'Do the work.', ...config } },
    { id: 'finish', type: 'end', name: 'Finish', config: { result: 'success' } },
  ];
}

function definition(config?: Partial<EmployeeNode['config']>): WorkflowDefinition {
  return {
    schemaVersion: 1, id: 'flow', title: 'Flow', revision: 1, enabled: false, nodes: nodes(config),
    edges: [
      { id: 'a', from: { nodeId: 'start', port: 'success' }, to: { nodeId: 'work', port: 'input' } },
      { id: 'b', from: { nodeId: 'work', port: 'success' }, to: { nodeId: 'finish', port: 'input' } },
    ],
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function run(todoId?: string, config?: Partial<EmployeeNode['config']>): WorkflowRunDetail {
  return {
    id: 'run-1', workflowId: 'flow', workflowTitle: 'Flow', definitionRevision: 1, definition: definition(config),
    input: {}, trigger: { nodeId: 'start', kind: 'manual', payload: {}, ...(todoId ? { todoId } : {}) },
    status: 'running', revision: 1, startedAt: '2026-08-01T00:00:00.000Z',
    nodeRuns: [], approvals: [], childRuns: [], attempts: [],
  } as unknown as WorkflowRunDetail;
}

function employeeNode(config?: Partial<EmployeeNode['config']>): EmployeeNode {
  return nodes(config).find((item) => item.id === 'work') as EmployeeNode;
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jinn-node-dispatch-'));
  process.env.JINN_HOME = root;
  database = openWorkflowDatabase();
  repository = new WorkflowRepository(database);
});

afterEach(() => {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function deps(override?: { engine: string | null; model: string | null }): DispatchResolutionDeps {
  return {
    employees: () => new Map([['worker', WORKER]]),
    models: () => MODELS,
    repository,
    executor: { resumableEngineSession: () => null } as unknown as DispatchResolutionDeps['executor'],
    ...(override ? { todoDispatch: { read: () => override } } : {}),
  };
}

describe('resolveDispatch and the bound Todo', () => {
  it('uses the employee default when the Todo says nothing', () => {
    expect(resolveDispatch(run('JIN-1'), employeeNode(), deps())).toMatchObject({ engine: 'codex', model: 'gpt-5.6-sol' });
  });

  it("takes the Todo's engine and model over the node's own", () => {
    const config = { engine: { source: 'fixed' as const, value: 'codex' }, model: { source: 'fixed' as const, value: 'gpt-5.5' } };
    const resolved = resolveDispatch(run('JIN-1', config), employeeNode(config), deps({ engine: 'claude', model: 'sonnet' }));
    expect(resolved).toMatchObject({ engine: 'claude', model: 'sonnet' });
  });

  it("takes the Todo's engine over the employee default too", () => {
    expect(resolveDispatch(run('JIN-1'), employeeNode(), deps({ engine: 'claude', model: 'opus' })))
      .toMatchObject({ engine: 'claude', model: 'opus' });
  });

  it("resolves the new engine's default model when the Todo names an engine and no model", () => {
    const config = { model: { source: 'fixed' as const, value: 'gpt-5.5' } };
    const resolved = resolveDispatch(run('JIN-1', config), employeeNode(config), deps({ engine: 'claude', model: null }));
    // gpt-5.5 belongs to codex; carrying it onto claude would fail the registry
    // check, so the pinned engine's default is what the attempt gets.
    expect(resolved).toMatchObject({ engine: 'claude', model: 'opus' });
  });

  it("drops the employee's effort when the Todo moves the attempt to another engine", () => {
    const worker = { ...WORKER, effortLevel: 'high' } as Employee;
    const withEffort = { ...deps({ engine: 'claude', model: 'opus' }), employees: () => new Map([['worker', worker]]) };
    // `high` is a codex effort level; claude's opus supports none, so keeping it
    // would fail the attempt over a default nobody asked for.
    expect(resolveDispatch(run('JIN-1'), employeeNode(), withEffort).effort).toBeUndefined();
  });

  it('ignores an override on a run that is not bound to a Todo', () => {
    expect(resolveDispatch(run(undefined), employeeNode(), deps({ engine: 'claude', model: 'opus' })))
      .toMatchObject({ engine: 'codex', model: 'gpt-5.6-sol' });
  });

  it('still refuses an engine the registry does not have available', () => {
    const unavailable = { ...deps({ engine: 'grok', model: null }) };
    expect(() => resolveDispatch(run('JIN-1'), employeeNode(), unavailable)).toThrow(/not available/);
  });
});

/** PLA-202: a model id belongs to exactly one provider, so no engine rewrite may
 *  leave one on an attempt bound for a different engine. dispatchTarget already
 *  resolves the stand-in's own default; this holds it there. */
describe('resolveDispatch and the chain substitution', () => {
  /** A run whose only attempt on this node died on codex, the way an engine out
   *  of allowance settles one. */
  function afterCodexLimit(): WorkflowRunDetail {
    const detail = run('JIN-1');
    detail.attempts = [{
      nodeId: 'work', attempt: 1, error: { code: 'workflow-step-failed', message: 'Codex usage limit reached' },
      resolvedConfig: { employeeId: 'worker', engine: 'codex', model: 'gpt-5.6-sol' },
    }] as unknown as WorkflowRunDetail['attempts'];
    return detail;
  }

  const chained: DispatchResolutionDeps = { ...deps(), engineFallback: { chainFor: (engine) => (engine === 'codex' ? ['claude'] : []) } };

  it('runs the stand-in on a model it serves, never the model the limited engine was on', () => {
    const resolved = resolveDispatch(afterCodexLimit(), employeeNode(), chained);

    expect(resolved.engine).toBe('claude');
    expect(resolved.model).toBe('opus');
    expect(MODELS.claude.models.map((model) => model.id)).toContain(resolved.model);
  });

  it('drops a node pin that belongs to the limited engine rather than carrying it over', () => {
    const config = { model: { source: 'fixed' as const, value: 'gpt-5.5' } };
    const detail = afterCodexLimit();
    detail.definition = definition(config);

    const resolved = resolveDispatch(detail, employeeNode(config), chained);

    expect(resolved.engine).toBe('claude');
    expect(resolved.model).not.toBe('gpt-5.5');
    expect(MODELS.claude.models.map((model) => model.id)).toContain(resolved.model);
  });
});
