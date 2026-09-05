import { describe, expect, it } from 'vitest';
import type { Binding, WorkflowCallNode, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '../model.js';
import { MAX_ITERATION_ROUNDS, workflowNodeSchema } from '../model.js';
import { outputPorts, validateExecutableWorkflow } from '../validation.js';

/**
 * The authoring half of bounded iteration: a loop without a finite bound, or
 * without anywhere to go once it spends that bound, must not be something a
 * runnable definition can say.
 */

const fixed = (value: string): Binding<string> => ({ source: 'fixed', value });

type IterateConfig = NonNullable<WorkflowCallNode['config']['iterate']>;

function rework(round: string): IterateConfig['continueWhile'] {
  return [{ left: { source: 'node', nodeId: 'loop', path: 'fields.last.verdict' }, operator: 'equals', right: fixed(round) }];
}

function loop(iterate: Partial<IterateConfig>, extra: Partial<WorkflowCallNode['config']> = {}): WorkflowNode {
  return {
    id: 'loop',
    type: 'workflow-call',
    name: 'Loop',
    config: {
      workflowId: fixed('child-flow'),
      input: { round: { source: 'trigger', path: 'round' } },
      concurrency: 1,
      iterate: { continueWhile: rework('rework'), ...iterate } as IterateConfig,
      ...extra,
    },
  };
}

function edge(id: string, from: string, to: string, port = 'success'): WorkflowEdge {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: 'input' } };
}

/** A trigger, the loop, and both of the loop's exits wired to their own ends. */
function definition(node: WorkflowNode, edges: WorkflowEdge[]): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: 'iteration-fixture',
    title: 'Iteration fixture',
    revision: 1,
    enabled: false,
    nodes: [
      { id: 'start', type: 'trigger', name: 'Start', config: { kind: 'manual' } },
      node,
      { id: 'shipped', type: 'end', name: 'Shipped', config: { result: 'success' } },
      { id: 'escalated', type: 'end', name: 'Escalated', config: { result: 'success' } },
    ],
    edges,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
}

const wiredBoth = [
  edge('start-loop', 'start', 'loop'),
  edge('loop-shipped', 'loop', 'shipped'),
  edge('loop-escalated', 'loop', 'escalated', 'exhausted'),
];

function codes(value: WorkflowDefinition): string[] {
  return validateExecutableWorkflow(value).issues.map((entry) => entry.code);
}

describe('bounded iteration validation', () => {
  it('rejects an iteration with no finite bound, and accepts the same definition once it has one', () => {
    const unbounded = definition(loop({}), wiredBoth);

    const rejected = validateExecutableWorkflow(unbounded);

    expect(rejected.ok).toBe(false);
    const found = rejected.issues.find((entry) => entry.code === 'unbounded-iteration');
    expect(found).toMatchObject({ nodeId: 'loop', path: 'nodes.1.config.iterate.maxRounds' });
    expect(found?.message).toContain('maxRounds');

    expect(validateExecutableWorkflow(definition(loop({ maxRounds: 2 }), wiredBoth))).toEqual({ ok: true, issues: [] });
  });

  it('refuses a bound the definition cannot state as a literal', () => {
    // A binding resolves mid-run, so it could not be read off the definition —
    // the schema is where that is settled, before any rule gets to look.
    for (const maxRounds of [0, -1, 1.5, MAX_ITERATION_ROUNDS + 1, { source: 'input', path: 'rounds' }]) {
      expect(workflowNodeSchema.safeParse(loop({ maxRounds } as unknown as Partial<IterateConfig>)).success,
        `maxRounds ${JSON.stringify(maxRounds)}`).toBe(false);
    }
    expect(workflowNodeSchema.safeParse(loop({ maxRounds: MAX_ITERATION_ROUNDS })).success).toBe(true);
  });

  it('refuses to both iterate and fan out over items', () => {
    const both = definition(loop({ maxRounds: 2 }, { items: { source: 'fixed', value: [{ topic: 'one' }] } }), wiredBoth);

    expect(codes(both)).toContain('iteration-with-fanout');
  });

  it('refuses an iteration with nowhere to go once it spends every round', () => {
    const unwired = definition(loop({ maxRounds: 2 }), [
      edge('start-loop', 'start', 'loop'),
      edge('loop-shipped', 'loop', 'shipped'),
    ]);

    expect(codes(unwired)).toContain('iteration-missing-exhausted-route');
  });

  it('gives an iterating node an exhausted port and leaves a plain call with only success', () => {
    expect(outputPorts(loop({ maxRounds: 2 }))).toEqual(['success', 'exhausted']);
    expect(outputPorts({
      id: 'plain', type: 'workflow-call', name: 'Plain',
      config: { workflowId: fixed('child-flow'), concurrency: 2 },
    })).toEqual(['success']);
  });

  it('lets continueWhile read the round that just finished, but keeps every other binding forward-only', () => {
    expect(codes(definition(loop({ maxRounds: 2 }), wiredBoth))).not.toContain('non-predecessor-binding');

    const selfInput = loop({ maxRounds: 2 }) as WorkflowCallNode;
    selfInput.config.input = { echo: { source: 'node', nodeId: 'loop', path: 'fields.last' } };

    expect(codes(definition(selfInput, wiredBoth))).toContain('non-predecessor-binding');
  });
});
