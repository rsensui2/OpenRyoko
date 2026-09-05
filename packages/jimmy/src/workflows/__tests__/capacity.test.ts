import { describe, expect, it } from 'vitest';
import type { WorkflowBindingContext } from '../bindings.js';
import {
  resolveFanoutConcurrency,
  systemConcurrencyCeiling,
  type WorkflowCapacitySnapshot,
} from '../capacity.js';
import type { WorkflowCallNode } from '../model.js';

const GIB = 1024 ** 3;

function snapshot(overrides: Partial<WorkflowCapacitySnapshot> = {}): WorkflowCapacitySnapshot {
  return { cpus: 9, freeMemBytes: 64 * GIB, activeEngineSessions: 0, ...overrides };
}

function callNode(concurrency: WorkflowCallNode['config']['concurrency']): WorkflowCallNode {
  return {
    id: 'children', type: 'workflow-call', name: 'Children',
    config: { workflowId: { source: 'fixed', value: 'child-flow' }, concurrency },
  };
}

function context(output: Record<string, unknown> | null): WorkflowBindingContext {
  return {
    input: {},
    trigger: { kind: 'manual', payload: {} },
    nodes: { plan: { status: 'completed', output: output === null ? null : { text: '', fields: output as never }, error: null } },
    run: { id: 'run_1', startedAt: '2026-08-05T12:00:00.000Z' },
  };
}

describe('systemConcurrencyCeiling', () => {
  it('is bound by the cores left over once the gateway keeps one', () => {
    expect(systemConcurrencyCeiling(snapshot({ cpus: 5 }))).toBe(4);
  });

  it('is bound by free memory when the machine would otherwise swap', () => {
    expect(systemConcurrencyCeiling(snapshot({ cpus: 17, freeMemBytes: 1 * GIB }))).toBe(2);
  });

  it('is bound by the engine sessions already holding the machine', () => {
    expect(systemConcurrencyCeiling(snapshot({ activeEngineSessions: 5 }))).toBe(3);
  });

  it('never drops below one, however starved the machine is', () => {
    expect(systemConcurrencyCeiling({ cpus: 1, freeMemBytes: 0, activeEngineSessions: 99 })).toBe(1);
  });

  it('never rises above the authored maximum of sixteen', () => {
    expect(systemConcurrencyCeiling({ cpus: 64, freeMemBytes: 1024 * GIB, activeEngineSessions: 0 })).toBe(16);
  });
});

describe('resolveFanoutConcurrency', () => {
  it('passes an authored number through when no capacity signal is wired', () => {
    expect(resolveFanoutConcurrency(callNode(6), context({ degree: 3 }), null))
      .toEqual({ requested: 6, effective: 6, limitedBy: 'requested' });
  });

  it('takes the degree a predecessor node emitted', () => {
    expect(resolveFanoutConcurrency(callNode({ source: 'node', nodeId: 'plan', path: 'fields.degree' }), context({ degree: 7 }), null))
      .toEqual({ requested: 7, effective: 7, limitedBy: 'requested' });
  });

  it('clamps a request the machine cannot serve and says so', () => {
    expect(resolveFanoutConcurrency(callNode(9), context(null), snapshot({ cpus: 4 })))
      .toEqual({ requested: 9, effective: 3, limitedBy: 'system-ceiling' });
  });

  it('leaves a request under the ceiling alone', () => {
    expect(resolveFanoutConcurrency(callNode(2), context(null), snapshot({ cpus: 4 })))
      .toEqual({ requested: 2, effective: 2, limitedBy: 'requested' });
  });

  const rejected: [string, unknown][] = [
    ['zero', 0],
    ['a negative', -3],
    ['a fraction', 2.5],
    ['a string', 'many'],
    ['null', null],
    ['above the authored maximum', 40],
  ];
  for (const [label, degree] of rejected) {
    it(`fails, naming the node, when the binding resolves to ${label}`, () => {
      expect(() => resolveFanoutConcurrency(
        callNode({ source: 'node', nodeId: 'plan', path: 'fields.degree' }),
        context({ degree: degree as never }),
        null,
      )).toThrow(/Workflow Call children concurrency/);
    });
  }

  it('fails, naming the node, when the bound path does not exist', () => {
    expect(() => resolveFanoutConcurrency(
      callNode({ source: 'node', nodeId: 'plan', path: 'fields.missing' }),
      context({ degree: 3 }),
      null,
    )).toThrow(/Workflow Call children concurrency/);
  });
});
