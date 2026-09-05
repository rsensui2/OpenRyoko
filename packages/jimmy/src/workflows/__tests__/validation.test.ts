import { describe, expect, it } from 'vitest';
import type {
  Binding,
  ConditionNode,
  TriggerNode,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowInputField,
  WorkflowNode,
} from '../model.js';
import { workflowDefinitionSchema, workflowDraftSchema } from '../model.js';
import {
  outputPorts,
  topologicalOrder,
  validateExecutableWorkflow,
  type WorkflowValidationIssue,
} from '../validation.js';

const fixed = (value: string): Binding<string> => ({ source: 'fixed', value });
const input = (path: string): Binding<string> => ({ source: 'input', path });

function trigger(id = 'trigger'): WorkflowNode {
  return { id, type: 'trigger', name: id, config: { kind: 'manual' } };
}

function employee(id: string, employeeBinding: Binding<string> = fixed('worker')): WorkflowNode {
  return { id, type: 'employee', name: id, config: { employee: employeeBinding, prompt: `Run ${id}.` } };
}

function workflowCall(id: string, workflowId: Binding<string> = fixed('child-flow')): WorkflowNode {
  return {
    id,
    type: 'workflow-call',
    name: id,
    config: {
      workflowId,
      items: { source: 'fixed', value: [{ topic: 'one' }] },
      input: { topic: { source: 'trigger', path: 'item.topic' } },
      concurrency: 2,
    },
  };
}

function condition(id: string, ports = ['yes'], defaultPort = 'no'): ConditionNode {
  return {
    id,
    type: 'condition',
    name: id,
    config: {
      cases: ports.map((port) => ({
        port,
        label: port,
        all: [{ left: fixed(port), operator: 'equals', right: fixed(port) }],
      })),
      defaultPort,
    },
  };
}

function merge(id: string): WorkflowNode {
  return { id, type: 'merge', name: id, config: { mode: 'wait-all' } };
}

function approval(id: string, approver?: Binding<string>): WorkflowNode {
  return {
    id,
    type: 'approval',
    name: id,
    config: { description: `Approve ${id}.`, ...(approver ? { approver } : {}) },
  };
}

function waitNode(id: string, timestamp?: Binding<string>): WorkflowNode {
  return timestamp
    ? { id, type: 'wait', name: id, config: { mode: 'until', timestamp } }
    : { id, type: 'wait', name: id, config: { mode: 'duration', minutes: 1 } };
}

function end(id = 'end', output?: Binding): WorkflowNode {
  return {
    id,
    type: 'end',
    name: id,
    config: { result: 'success', ...(output ? { output } : {}) },
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  port = 'success',
  targetPort: string = 'input',
): WorkflowEdge {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: targetPort as 'input' } };
}

function field(key: string): WorkflowInputField {
  return { key, label: key, type: 'string', required: true };
}

function definition(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  inputs?: WorkflowInputField[],
): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: 'validation-fixture',
    title: 'Validation fixture',
    revision: 1,
    enabled: false,
    ...(inputs ? { inputs } : {}),
    nodes,
    edges,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

function validChain(): WorkflowDefinition {
  return definition(
    [trigger(), employee('first'), employee('second'), end()],
    [edge('e1', 'trigger', 'first'), edge('e2', 'first', 'second'), edge('e3', 'second', 'end')],
  );
}

function codes(result: ReturnType<typeof validateExecutableWorkflow>): string[] {
  return result.issues.map((issue) => issue.code);
}

function issue(result: ReturnType<typeof validateExecutableWorkflow>, code: string): WorkflowValidationIssue {
  const found = result.issues.find((entry) => entry.code === code);
  expect(found, `Expected issue ${code}`).toBeDefined();
  return found!;
}

const malformedResult = {
  ok: false,
  issues: [{ code: 'invalid-definition', message: 'Workflow definition is invalid.' }],
};
const invalidDefinitionError = new Error('Workflow definition is invalid.');

function throwingProxy<T extends object>(value: T, trapped: () => void): T {
  return new Proxy(value, {
    get() { trapped(); throw new Error('poison getter executed'); },
    getOwnPropertyDescriptor() { trapped(); throw new Error('poison descriptor executed'); },
    ownKeys() { trapped(); throw new Error('poison keys executed'); },
  });
}

function withPrototypeProperty(key: string, descriptor: PropertyDescriptor, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  try {
    Object.defineProperty(Object.prototype, key, { ...descriptor, configurable: true }); run();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, key, previous); else Reflect.deleteProperty(Object.prototype, key);
  }
}

describe('valid executable graphs', () => {
  it('accepts Manual -> Employee -> Employee -> End', () => {
    expect(validateExecutableWorkflow(validChain())).toEqual({ ok: true, issues: [] });
  });

  it('accepts a workflow-call success path and validates every authored binding', () => {
    const graph = definition(
      [trigger(), workflowCall('children'), end()],
      [edge('e1', 'trigger', 'children'), edge('e2', 'children', 'end')],
    );

    expect(outputPorts(graph.nodes[1]!)).toEqual(['success']);
    expect(validateExecutableWorkflow(graph)).toEqual({ ok: true, issues: [] });

    const malformed = structuredClone(graph);
    const call = malformed.nodes[1] as Extract<WorkflowNode, { type: 'workflow-call' }>;
    call.config.input = { topic: { source: 'node', nodeId: 'missing', path: 'fields.topic' } };
    expect(codes(validateExecutableWorkflow(malformed))).toContain('unknown-node-binding');
  });

  it('refuses a fixed workflow-call target equal to the defining workflow', () => {
    const graph = definition(
      [trigger(), workflowCall('children', fixed('validation-fixture')), end()],
      [edge('e1', 'trigger', 'children'), edge('e2', 'children', 'end')],
    );

    expect(validateExecutableWorkflow(graph).issues).toContainEqual(expect.objectContaining({
      code: 'workflow-call-self-reference',
      nodeId: 'children',
      path: 'nodes.1.config.workflowId',
    }));
  });

  it('accepts branching, fan-out, Condition, Merge, Approval recovery, and Wait', () => {
    const graph = definition(
      [
        trigger(), condition('choice'), employee('left'), employee('right'), merge('join'), approval('gate'),
        employee('recovery'), merge('decision'), waitNode('pause'), end(),
      ],
      [
        edge('e1', 'trigger', 'choice'), edge('e2', 'choice', 'left', 'yes'), edge('e3', 'choice', 'right', 'no'),
        edge('e4', 'left', 'join'), edge('e5', 'right', 'join'), edge('e6', 'join', 'gate'),
        edge('e7', 'gate', 'decision', 'approved'), edge('e8', 'gate', 'recovery', 'rejected'),
        edge('e9', 'recovery', 'decision'), edge('e10', 'decision', 'pause'), edge('e11', 'pause', 'end'),
      ],
    );

    expect(validateExecutableWorkflow(graph)).toEqual({ ok: true, issues: [] });
  });
});

describe('canonical schema boundary', () => {
  it('rejects an extra edge property before executable graph operations', () => {
    const graph = definition([trigger(), end()], [edge('finish', 'trigger', 'end')]);
    graph.edges[0] = { ...graph.edges[0]!, unexpected: true } as unknown as WorkflowEdge;

    expect(workflowDefinitionSchema.safeParse(graph).success).toBe(false);
    expect(validateExecutableWorkflow(graph)).toEqual(malformedResult);
    expect(() => topologicalOrder(graph)).toThrowError(invalidDefinitionError);
  });

  it('rejects an extra node property before executable graph operations', () => {
    const malformedNode = { ...trigger(), unexpected: true } as unknown as WorkflowNode;
    const graph = definition([malformedNode, end()], [edge('finish', 'trigger', 'end')]);

    expect(workflowDefinitionSchema.safeParse(graph).success).toBe(false);
    expect(validateExecutableWorkflow(graph)).toEqual(malformedResult);
    expect(() => topologicalOrder(graph)).toThrowError(invalidDefinitionError);
    expect(outputPorts(malformedNode)).toEqual([]);
  });

  it('keeps a structurally valid disabled draft editable before it is executable', () => {
    const draft = { nodes: [trigger()], edges: [] };
    const disabled = definition(draft.nodes, draft.edges);

    expect(disabled.enabled).toBe(false);
    expect(workflowDraftSchema.safeParse(draft).success).toBe(true);
    expect(validateExecutableWorkflow(disabled).ok).toBe(false);
    expect(codes(validateExecutableWorkflow(disabled))).not.toContain('invalid-definition');
  });
});

describe('triggers, End paths, and cycles', () => {
  it('requires at least one Trigger', () => {
    const result = validateExecutableWorkflow(definition([employee('work'), end()], [edge('e1', 'work', 'end')]));
    expect(result.issues).toContainEqual({ code: 'trigger-count', message: 'Workflow must contain at least one Trigger.' });
  });

  it('accepts one Todo trigger and one Workflow Call trigger when both reach an End', () => {
    const graph = definition([
      { id: 'todo-trigger', type: 'trigger', name: 'Todo', config: { kind: 'todo-status', status: 'in_review' } },
      { id: 'call-trigger', type: 'trigger', name: 'Called', config: { kind: 'workflow-call' } },
      end('todo-end'),
      end('call-end'),
    ], [edge('todo-finish', 'todo-trigger', 'todo-end'), edge('call-finish', 'call-trigger', 'call-end')]);

    expect(validateExecutableWorkflow(graph)).toEqual({ ok: true, issues: [] });
  });

  it('reports a duplicate Trigger kind on the duplicate node', () => {
    const graph = definition([
      trigger('first-trigger'),
      trigger('second-trigger'),
      end('first-end'),
      end('second-end'),
    ], [edge('first-finish', 'first-trigger', 'first-end'), edge('second-finish', 'second-trigger', 'second-end')]);

    expect(validateExecutableWorkflow(graph).issues).toContainEqual({
      code: 'duplicate-trigger-kind',
      message: 'Workflow must contain at most one manual Trigger.',
      nodeId: 'second-trigger',
    });
  });

  it('requires a directed Trigger-to-End path even when an End exists', () => {
    const graph = definition([trigger(), employee('dead'), end()], [edge('e1', 'trigger', 'dead')]);
    expect(codes(validateExecutableWorkflow(graph))).toEqual(expect.arrayContaining(['missing-end-path', 'dead-node']));
  });

  it.each([
    [
      'self-loop',
      definition(
        [trigger(), employee('loop'), end()],
        [edge('e1', 'loop', 'loop'), edge('e2', 'trigger', 'loop'), edge('e3', 'loop', 'end')],
      ),
    ],
    [
      'multi-node cycle',
      definition(
        [trigger(), merge('a'), merge('b'), end()],
        [
          edge('e1', 'trigger', 'a'), edge('e2', 'b', 'a'), edge('e3', 'a', 'b'),
          edge('e4', 'trigger', 'b'), edge('e5', 'b', 'end'),
        ],
      ),
    ],
    [
      'cycle disconnected from Trigger',
      definition(
        [trigger(), end(), merge('a'), merge('b')],
        [edge('e1', 'trigger', 'end'), edge('e2', 'a', 'b'), edge('e3', 'b', 'a')],
      ),
    ],
  ])('reports a %s without throwing', (_label, graph) => {
    const result = validateExecutableWorkflow(graph);
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('cycle');
  });
});

describe('edge references and ports', () => {
  it('reports unknown source and target nodes with edge metadata', () => {
    const graph = definition(
      [trigger(), end()],
      [edge('bad-source', 'missing-source', 'end'), edge('bad-target', 'trigger', 'missing-target')],
    );
    const result = validateExecutableWorkflow(graph);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'unknown-source-node', edgeId: 'bad-source', nodeId: 'missing-source',
    }));
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'unknown-target-node', edgeId: 'bad-target', nodeId: 'missing-target',
    }));
  });

  it.each([
    ['trigger', trigger('source'), 'error'],
    ['employee', employee('source'), 'approved'],
    ['condition', condition('source'), 'success'],
    ['merge', merge('source'), 'error'],
    ['approval', approval('source'), 'success'],
    ['wait', waitNode('source'), 'error'],
    ['end', end('source'), 'success'],
  ])('rejects an invalid %s source port', (_type, source, port) => {
    const nodes = source.type === 'trigger'
      ? [source, end()]
      : [trigger(), source, end()];
    const edges = source.type === 'trigger'
      ? [edge('invalid', source.id, 'end', port)]
      : [edge('enter', 'trigger', source.id), edge('invalid', source.id, 'end', port)];
    expect(validateExecutableWorkflow(definition(nodes, edges)).issues).toContainEqual(expect.objectContaining({
      code: 'invalid-source-port', edgeId: 'invalid', nodeId: source.id,
    }));
  });

  it('requires every target port to be exactly input', () => {
    const graph = validChain();
    graph.edges[1]!.to.port = 'success' as 'input';
    expect(workflowDefinitionSchema.safeParse(graph).success).toBe(false);
    expect(validateExecutableWorkflow(graph)).toEqual(malformedResult);
  });

  it('flags only the later exact duplicate route and excludes it from incoming counts', () => {
    const graph = definition(
      [trigger(), employee('work'), end()],
      [edge('first', 'trigger', 'work'), edge('later', 'trigger', 'work'), edge('finish', 'work', 'end')],
    );
    const result = validateExecutableWorkflow(graph);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'duplicate-edge', edgeId: 'later' }));
    expect(codes(result)).not.toContain('multiple-incoming');
  });

  it('allows fan-out from one source port to distinct targets', () => {
    const graph = definition(
      [trigger(), employee('left'), employee('right'), end('left-end'), end('right-end')],
      [
        edge('e1', 'trigger', 'left'), edge('e2', 'trigger', 'right'),
        edge('e3', 'left', 'left-end'), edge('e4', 'right', 'right-end'),
      ],
    );
    expect(validateExecutableWorkflow(graph)).toEqual({ ok: true, issues: [] });
  });
});

describe('incoming cardinality and terminal boundaries', () => {
  it('rejects every valid incoming edge to a Trigger', () => {
    const graph = definition(
      [trigger(), employee('work'), end()],
      [edge('enter', 'trigger', 'work'), edge('back', 'work', 'trigger'), edge('finish', 'work', 'end')],
    );
    expect(validateExecutableWorkflow(graph).issues).toContainEqual(expect.objectContaining({
      code: 'trigger-incoming', nodeId: 'trigger', edgeId: 'back',
    }));
  });

  it('flags later incoming edges beyond the first for an ordinary node', () => {
    const graph = definition(
      [trigger(), employee('left'), employee('right'), employee('target'), end()],
      [
        edge('e1', 'trigger', 'left'), edge('e2', 'trigger', 'right'), edge('first', 'left', 'target'),
        edge('later', 'right', 'target'), edge('finish', 'target', 'end'),
      ],
    );
    expect(validateExecutableWorkflow(graph).issues).toContainEqual(expect.objectContaining({
      code: 'multiple-incoming', nodeId: 'target', edgeId: 'later',
    }));
  });

  it('excludes a later excess incoming edge from reachability analysis', () => {
    const graph = definition(
      [trigger(), employee('source'), employee('target'), end()],
      [edge('first', 'source', 'target'), edge('later', 'trigger', 'target'), edge('finish', 'target', 'end')],
    );
    const result = validateExecutableWorkflow(graph);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'multiple-incoming', nodeId: 'target', edgeId: 'later',
    }));
    expect(result.issues.filter((item) => item.code === 'unreachable-node').map((item) => item.nodeId))
      .toEqual(['source', 'target', 'end']);
  });

  it('keeps the first authored ordinary incoming edge authoritative', () => {
    const graph = definition(
      [trigger(), employee('source'), employee('target'), end()],
      [edge('first', 'trigger', 'target'), edge('later', 'source', 'target'), edge('finish', 'target', 'end')],
    );
    const result = validateExecutableWorkflow(graph);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'multiple-incoming', nodeId: 'target', edgeId: 'later',
    }));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'unreachable-node', nodeId: 'source' }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: 'unreachable-node', nodeId: 'target' }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({ code: 'unreachable-node', nodeId: 'end' }));
  });

  it('excludes Trigger incoming edges from cycle analysis', () => {
    const graph = definition(
      [trigger(), employee('work'), end()],
      [edge('enter', 'trigger', 'work'), edge('back', 'work', 'trigger'), edge('finish', 'work', 'end')],
    );
    const result = validateExecutableWorkflow(graph);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'trigger-incoming', nodeId: 'trigger', edgeId: 'back',
    }));
    expect(codes(result)).not.toContain('cycle');
  });
});

describe('Merge predecessor cardinality and terminal boundaries', () => {
  it.each([
    ['zero', []],
    ['one', [edge('one', 'trigger', 'join')]],
  ])('requires two distinct valid predecessor edges for Merge with %s', (_label, incoming) => {
    const graph = definition(
      [trigger(), merge('join'), end()],
      [...incoming, edge('finish', 'join', 'end')],
    );
    expect(validateExecutableWorkflow(graph).issues).toContainEqual(expect.objectContaining({
      code: 'merge-predecessors', nodeId: 'join',
    }));
  });

  it('accepts two or more distinct valid Merge predecessor edges', () => {
    const graph = definition(
      [trigger(), employee('left'), employee('right'), merge('join'), end()],
      [
        edge('e1', 'trigger', 'left'), edge('e2', 'trigger', 'right'), edge('e3', 'left', 'join'),
        edge('e4', 'right', 'join'), edge('e5', 'trigger', 'join'), edge('e6', 'join', 'end'),
      ],
    );
    expect(validateExecutableWorkflow(graph)).toEqual({ ok: true, issues: [] });
  });

  it('does not count an exact duplicate route as a second Merge predecessor', () => {
    const graph = definition(
      [trigger(), merge('join'), end()],
      [edge('first', 'trigger', 'join'), edge('duplicate', 'trigger', 'join'), edge('finish', 'join', 'end')],
    );
    expect(codes(validateExecutableWorkflow(graph))).toEqual(expect.arrayContaining(['duplicate-edge', 'merge-predecessors']));
  });

  it('requires distinct Merge predecessor node IDs across different source ports', () => {
    const graph = definition(
      [trigger(), employee('work'), merge('join'), end()],
      [
        edge('enter', 'trigger', 'work'), edge('success', 'work', 'join'),
        edge('error', 'work', 'join', 'error'), edge('finish', 'join', 'end'),
      ],
    );
    expect(validateExecutableWorkflow(graph).issues).toContainEqual(expect.objectContaining({
      code: 'merge-predecessors',
      nodeId: 'join',
      message: 'Merge nodes require at least two distinct predecessor nodes.',
    }));
  });

  it('accepts exactly two distinct Merge predecessor node IDs', () => {
    const graph = definition(
      [trigger(), employee('left'), employee('right'), merge('join'), end()],
      [
        edge('left-in', 'trigger', 'left'), edge('right-in', 'trigger', 'right'),
        edge('left-join', 'left', 'join'), edge('right-join', 'right', 'join'), edge('finish', 'join', 'end'),
      ],
    );
    expect(validateExecutableWorkflow(graph)).toEqual({ ok: true, issues: [] });
  });

  it('reports every outgoing edge authored on End', () => {
    const graph = definition(
      [trigger(), end(), employee('after'), end('last')],
      [edge('enter', 'trigger', 'end'), edge('out', 'end', 'after'), edge('finish', 'after', 'last')],
    );
    expect(validateExecutableWorkflow(graph).issues).toContainEqual(expect.objectContaining({
      code: 'end-outgoing', nodeId: 'end', edgeId: 'out',
    }));
  });
});

describe('reachability and liveness', () => {
  it('reports non-Trigger nodes unreachable through valid edges', () => {
    const graph = validChain();
    graph.nodes.push(employee('stray'));
    expect(validateExecutableWorkflow(graph).issues).toContainEqual(expect.objectContaining({
      code: 'unreachable-node', nodeId: 'stray',
    }));
  });

  it('reports a reachable non-End node with no path to End', () => {
    const graph = definition(
      [trigger(), employee('finish'), employee('dead'), end()],
      [edge('e1', 'trigger', 'finish'), edge('e2', 'finish', 'end'), edge('e3', 'trigger', 'dead')],
    );
    expect(validateExecutableWorkflow(graph).issues).toContainEqual(expect.objectContaining({
      code: 'dead-node', nodeId: 'dead',
    }));
  });

  it('does not require Employee error or Approval rejected outputs to be connected', () => {
    const graph = definition(
      [trigger(), employee('work'), approval('gate'), end()],
      [edge('e1', 'trigger', 'work'), edge('e2', 'work', 'gate'), edge('e3', 'gate', 'end', 'approved')],
    );
    expect(validateExecutableWorkflow(graph)).toEqual({ ok: true, issues: [] });
  });
});

describe('Condition ports and outputPorts', () => {
  it.each([
    ['empty case', condition('choice', [''])],
    ['duplicate case', condition('choice', ['same', 'same'])],
    ['default collision', condition('choice', ['same'], 'same')],
  ])('maps a schema-invalid %s to one stable definition issue', (_label, choice) => {
    const graph = definition([trigger(), choice, end()], [edge('e1', 'trigger', 'choice')]);
    expect(validateExecutableWorkflow(graph)).toEqual(malformedResult);
  });

  it.each([
    ['unsafe case', condition('choice', ['not.safe']), 'nodes.1.config.cases.0.port'],
    ['unsafe default', condition('choice', ['yes'], '__proto__'), 'nodes.1.config.defaultPort'],
  ])('fails closed for %s ports', (_label, choice, path) => {
    const graph = definition([trigger(), choice, end()], [edge('e1', 'trigger', 'choice')]);
    expect(validateExecutableWorkflow(graph).issues).toContainEqual(expect.objectContaining({
      code: 'invalid-condition-port', nodeId: 'choice', path,
    }));
  });

  it('returns no ports when a Condition node fails its canonical schema', () => {
    const choice = condition('choice', ['first', 'second', 'first', 'bad.port'], 'second');
    expect(outputPorts(choice)).toEqual([]);
  });

  it('returns every locked variant contract as a fresh array', () => {
    const cases: Array<[WorkflowNode, string[]]> = [
      [trigger(), ['success']],
      [employee('work'), ['success', 'error']],
      [condition('choice', ['first', 'second'], 'fallback'), ['first', 'second', 'fallback']],
      [merge('join'), ['success']],
      [approval('gate'), ['approved', 'rejected']],
      [waitNode('pause'), ['success']],
      [end(), []],
    ];
    for (const [node, expected] of cases) {
      const first = outputPorts(node);
      const second = outputPorts(node);
      expect(first).toEqual(expected);
      expect(second).toEqual(expected);
      expect(second).not.toBe(first);
      first.push('mutated');
      expect(outputPorts(node)).toEqual(expected);
    }
  });
});

function bindingGraph(): WorkflowDefinition {
  const work = employee('work', input('employee.id'));
  if (work.type !== 'employee') throw new Error('fixture');
  work.config.engine = input('engine');
  work.config.model = input('model.name');
  work.config.effort = input('effort') as Binding<'low' | 'medium' | 'high' | 'xhigh'>;
  const choice = condition('choice');
  choice.config.cases[0]!.all = [{
    left: input('left.value'),
    operator: 'equals',
    right: input('right.value'),
  }];
  return definition(
    [
      trigger(), work, choice, approval('gate', input('approver.id')), waitNode('pause', input('timestamp')),
      end('success-end', input('result.value')), end('default-end'), end('rejected-end'),
    ],
    [
      edge('e1', 'trigger', 'work'), edge('e2', 'work', 'choice'), edge('e3', 'choice', 'gate', 'yes'),
      edge('e4', 'choice', 'default-end', 'no'), edge('e5', 'gate', 'pause', 'approved'),
      edge('e6', 'gate', 'rejected-end', 'rejected'), edge('e7', 'pause', 'success-end'),
    ],
    ['employee', 'engine', 'model', 'effort', 'left', 'right', 'approver', 'timestamp', 'result'].map(field),
  );
}

describe('Workflow input declarations', () => {
  it('accepts every explicitly traversed input Binding location using the first path segment', () => {
    expect(validateExecutableWorkflow(bindingGraph())).toEqual({ ok: true, issues: [] });
  });

  it.each([
    ['employee', 'nodes.1.config.employee'],
    ['engine', 'nodes.1.config.engine'],
    ['model', 'nodes.1.config.model'],
    ['effort', 'nodes.1.config.effort'],
    ['left', 'nodes.2.config.cases.0.all.0.left'],
    ['right', 'nodes.2.config.cases.0.all.0.right'],
    ['approver', 'nodes.3.config.approver'],
    ['timestamp', 'nodes.4.config.timestamp'],
    ['result', 'nodes.5.config.output'],
  ])('reports missing %s declarations at the known config path', (key, path) => {
    const graph = bindingGraph();
    graph.inputs = graph.inputs!.filter((entry) => entry.key !== key);
    expect(validateExecutableWorkflow(graph).issues).toContainEqual(expect.objectContaining({
      code: 'undeclared-input', path,
    }));
  });

  it('treats a single source-word path as an ordinary declared input key', () => {
    const graph = definition(
      [trigger(), employee('work', input('input')), end()],
      [edge('e1', 'trigger', 'work'), edge('e2', 'work', 'end')],
      [field('input')],
    );
    expect(validateExecutableWorkflow(graph)).toEqual({ ok: true, issues: [] });
  });

  it('does not require declarations for fixed, trigger, run, or node bindings', () => {
    const work = employee('work', fixed('worker'));
    if (work.type !== 'employee') throw new Error('fixture');
    work.config.engine = { source: 'trigger', path: 'trigger' };
    work.config.model = { source: 'run', path: 'run' };
    const graph = definition(
      [trigger(), work, end('end', { source: 'node', nodeId: 'work', path: 'nodes' })],
      [edge('e1', 'trigger', 'work'), edge('e2', 'work', 'end')],
    );
    expect(validateExecutableWorkflow(graph)).toEqual({ ok: true, issues: [] });
  });
});

describe('deterministic issue behavior', () => {
  it('sorts by node rank, then edge rank, then code and remains byte-identical without mutation', () => {
    const graph = definition(
      [trigger(), employee('first'), employee('second'), end()],
      [
        edge('bad-port', 'first', 'second', 'approved'),
        edge('unknown', 'missing', 'end'),
        edge('incoming', 'second', 'trigger'),
        edge('outgoing', 'end', 'first'),
      ],
    );
    const snapshot = structuredClone(graph);
    const first = validateExecutableWorkflow(graph);
    const second = validateExecutableWorkflow(graph);

    expect(JSON.stringify(second.issues)).toBe(JSON.stringify(first.issues));
    expect(graph).toEqual(snapshot);
    expect(first.ok).toBe(first.issues.length === 0);
    expect(first.issues.map((entry) => [entry.nodeId, entry.edgeId, entry.code])).toEqual([
      ['trigger', 'incoming', 'trigger-incoming'],
      ['trigger', undefined, 'dead-node'],
      ['first', 'bad-port', 'invalid-source-port'],
      ['first', undefined, 'unreachable-node'],
      ['second', undefined, 'unreachable-node'],
      ['end', 'outgoing', 'end-outgoing'],
      ['end', 'outgoing', 'invalid-source-port'],
      ['end', undefined, 'unreachable-node'],
      ['missing', 'unknown', 'unknown-source-node'],
      [undefined, undefined, 'missing-end-path'],
    ]);
  });

  it('de-duplicates the same code/nodeId/edgeId/path tuple', () => {
    const choice = condition('choice', ['same', 'same'], 'same');
    const graph = definition([trigger(), choice, end()], [edge('e1', 'trigger', 'choice')]);
    const tuples = validateExecutableWorkflow(graph).issues.map((entry) => JSON.stringify([
      entry.code, entry.nodeId, entry.edgeId, entry.path,
    ]));
    expect(new Set(tuples).size).toBe(tuples.length);
  });
});

describe('topologicalOrder', () => {
  it('preserves authored node order among simultaneously ready nodes', () => {
    const graph = definition(
      [trigger(), employee('second'), employee('first'), merge('join'), end()],
      [
        edge('e1', 'trigger', 'first'), edge('e2', 'trigger', 'second'), edge('e3', 'first', 'join'),
        edge('e4', 'second', 'join'), edge('e5', 'join', 'end'),
      ],
    );
    const snapshot = structuredClone(graph);
    expect(topologicalOrder(graph)).toEqual(['trigger', 'second', 'first', 'join', 'end']);
    expect(graph).toEqual(snapshot);
  });

  it('throws one stable generic Error on a cycle', () => {
    const graph = definition(
      [trigger(), employee('loop'), end()],
      [edge('e1', 'trigger', 'loop'), edge('e2', 'loop', 'loop'), edge('e3', 'loop', 'end')],
    );
    expect(() => topologicalOrder(graph)).toThrowError(new Error('Workflow graph contains a directed cycle.'));
  });

  it('throws one stable generic Error on an unknown edge reference', () => {
    const graph = definition([trigger(), end()], [edge('bad', 'trigger', 'missing')]);
    expect(() => topologicalOrder(graph)).toThrowError(new Error('Workflow graph contains an unknown node reference.'));
  });
});

function maximumGraph(): WorkflowDefinition {
  const employees = Array.from({ length: 50 }, (_, index) => employee(`employee-${index}`));
  const merges = Array.from({ length: 48 }, (_, index) => merge(`merge-${index}`));
  const nodes = [trigger(), ...employees, ...merges, end()];
  const edges: WorkflowEdge[] = employees.map((node, index) => edge(`enter-${index}`, 'trigger', node.id));
  for (let index = 0; index < merges.length; index += 1) {
    const target = merges[index]!.id;
    if (index > 0) edges.push(edge(`chain-${index}`, merges[index - 1]!.id, target));
    edges.push(edge(`base-${index}`, employees[index % employees.length]!.id, target));
  }
  for (let index = 0; edges.length < 299; index += 1) {
    const source = employees[index % employees.length]!.id;
    const target = merges[(Math.floor(index / employees.length) + index + 1) % merges.length]!.id;
    if (!edges.some((item) => item.from.nodeId === source && item.to.nodeId === target)) {
      edges.push(edge(`fan-${index}`, source, target));
    }
  }
  edges.push(edge('finish', merges.at(-1)!.id, 'end'));
  return definition(nodes, edges);
}

describe('bounded and malformed inputs', () => {
  it('handles a valid 100-node, 300-edge graph without a timing assertion', () => {
    const graph = maximumGraph();
    expect(graph.nodes).toHaveLength(100);
    expect(graph.edges).toHaveLength(300);
    expect(validateExecutableWorkflow(graph)).toEqual({ ok: true, issues: [] });
    expect(topologicalOrder(graph)).toHaveLength(100);
  });

  it('fails closed for hand-built malformed Condition values without mutating or throwing', () => {
    const malformed = condition('choice') as unknown as { config: { cases: unknown; defaultPort: unknown } };
    malformed.config.cases = null;
    malformed.config.defaultPort = 1;
    const graph = definition(
      [trigger(), malformed as unknown as WorkflowNode, end()],
      [edge('e1', 'trigger', 'choice')],
    );
    const snapshot = structuredClone(graph);
    expect(() => validateExecutableWorkflow(graph)).not.toThrow();
    expect(validateExecutableWorkflow(graph)).toEqual(malformedResult);
    expect(graph).toEqual(snapshot);
  });

  it('treats malformed top-level collections as a structural-schema prerequisite without throwing', () => {
    const graph = { ...validChain(), nodes: null, edges: null } as unknown as WorkflowDefinition;
    expect(() => validateExecutableWorkflow(graph)).not.toThrow();
    expect(validateExecutableWorkflow(graph).ok).toBe(false);
  });
});

describe('adversarial public seams', () => {
  it('maps throwing and revoked definition Proxies to stable public outcomes without invoking traps', () => {
    let calls = 0;
    const poison = new Proxy(validChain(), {
      get() { calls += 1; throw new Error('poison getter executed'); },
      getOwnPropertyDescriptor() { calls += 1; throw new Error('poison descriptor executed'); },
      ownKeys() { calls += 1; throw new Error('poison keys executed'); },
    });
    const revoked = Proxy.revocable(validChain(), {});
    revoked.revoke();
    for (const hostile of [poison, revoked.proxy]) {
      expect(validateExecutableWorkflow(hostile)).toEqual(malformedResult);
      expect(validateExecutableWorkflow(hostile)).toEqual(malformedResult);
      expect(() => topologicalOrder(hostile)).toThrowError(invalidDefinitionError);
    }
    expect(calls).toBe(0);
  });

  it('maps hostile WorkflowNode values to no ports without invoking traps', () => {
    let calls = 0;
    const poison = new Proxy(employee('work'), {
      get() { calls += 1; throw new Error('poison getter executed'); },
      getOwnPropertyDescriptor() { calls += 1; throw new Error('poison descriptor executed'); },
      ownKeys() { calls += 1; throw new Error('poison keys executed'); },
    });
    const revoked = Proxy.revocable(employee('work'), {});
    revoked.revoke();
    expect(outputPorts(poison)).toEqual([]);
    expect(outputPorts(revoked.proxy)).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects accessor-backed public inputs without invoking getters and preserves benign values', () => {
    let calls = 0;
    const hostileDefinition = {} as WorkflowDefinition;
    Object.defineProperty(hostileDefinition, 'nodes', { enumerable: true, get() { calls += 1; throw new Error('getter'); } });
    const hostileNode = {} as WorkflowNode;
    Object.defineProperty(hostileNode, 'type', { enumerable: true, get() { calls += 1; throw new Error('getter'); } });
    expect(validateExecutableWorkflow(hostileDefinition)).toEqual({
      ok: false,
      issues: [{ code: 'invalid-definition', message: 'Workflow definition is invalid.' }],
    });
    expect(outputPorts(hostileNode)).toEqual([]);
    expect(() => topologicalOrder(hostileDefinition)).toThrowError(invalidDefinitionError);
    expect(calls).toBe(0);
    expect(validateExecutableWorkflow(validChain())).toEqual({ ok: true, issues: [] });
    expect(outputPorts(employee('work'))).toEqual(['success', 'error']);
  });
});

describe('nested adversarial public seams', () => {
  it('rejects throwing, revoked, and accessor-backed node arrays without invoking traps', () => {
    let calls = 0;
    const poison = throwingProxy(validChain().nodes, () => { calls += 1; });
    const revoked = Proxy.revocable(validChain().nodes, {});
    revoked.revoke();
    const accessor = validChain().nodes.slice();
    Object.defineProperty(accessor, 1, {
      enumerable: true,
      get() { calls += 1; throw new Error('node getter executed'); },
    });

    for (const nodes of [poison, revoked.proxy, accessor]) {
      const graph = { ...validChain(), nodes };
      expect(validateExecutableWorkflow(graph)).toEqual(malformedResult);
      expect(validateExecutableWorkflow(graph)).toEqual(malformedResult);
      expect(() => topologicalOrder(graph)).toThrowError(invalidDefinitionError);
      expect(() => topologicalOrder(graph)).toThrowError(invalidDefinitionError);
    }
    expect(calls).toBe(0);
  });

  it('rejects hostile edges, inputs, and a nested endpoint object at the definition boundary', () => {
    let calls = 0;
    const trapped = () => { calls += 1; };
    const hostileEdges = { ...validChain(), edges: throwingProxy(validChain().edges, trapped) };
    const hostileInputs = {
      ...validChain(), inputs: throwingProxy([field('worker')], trapped),
    };
    const hostileEndpoint = validChain();
    hostileEndpoint.edges[0]!.from = throwingProxy(hostileEndpoint.edges[0]!.from, trapped);

    for (const graph of [hostileEdges, hostileInputs, hostileEndpoint]) {
      expect(validateExecutableWorkflow(graph)).toEqual(malformedResult);
      expect(() => topologicalOrder(graph)).toThrowError(invalidDefinitionError);
    }
    expect(calls).toBe(0);
  });
});

describe('nested adversarial Condition seams', () => {
  it('rejects hostile cases and predicate arrays with deterministic outcomes', () => {
    let calls = 0;
    const trapped = () => { calls += 1; };
    const hostileCases = condition('choice');
    hostileCases.config.cases = throwingProxy(hostileCases.config.cases, trapped);
    const hostilePredicates = condition('choice');
    hostilePredicates.config.cases[0]!.all = throwingProxy(
      hostilePredicates.config.cases[0]!.all,
      trapped,
    );

    for (const choice of [hostileCases, hostilePredicates]) {
      const graph = definition([trigger(), choice, end()], [
        edge('e1', 'trigger', 'choice'), edge('e2', 'choice', 'end', 'yes'),
      ]);
      expect(outputPorts(choice)).toEqual([]);
      expect(outputPorts(choice)).toEqual([]);
      expect(validateExecutableWorkflow(graph)).toEqual(malformedResult);
      expect(() => topologicalOrder(graph)).toThrowError(invalidDefinitionError);
    }
    expect(calls).toBe(0);
  });

  it('rejects a nested accessor object without invoking its getter and preserves canonical values', () => {
    let calls = 0;
    const hostile = condition('choice');
    Object.defineProperty(hostile.config.cases[0]!, 'port', {
      enumerable: true,
      get() { calls += 1; throw new Error('case getter executed'); },
    });
    expect(outputPorts(hostile)).toEqual([]);
    expect(calls).toBe(0);
    expect(outputPorts(condition('choice', ['first', 'second'], 'fallback')))
      .toEqual(['first', 'second', 'fallback']);
    expect(validateExecutableWorkflow(validChain())).toEqual({ ok: true, issues: [] });
    expect(topologicalOrder(validChain())).toEqual(['trigger', 'first', 'second', 'end']);
  });
});

describe('inherited adversarial public seams', () => {
  it('ignores inherited throwing accessors at node and definition boundaries', () => {
    let calls = 0;
    const choice = condition('choice');
    Reflect.deleteProperty(choice.config, 'defaultPort');
    const graph = definition([trigger(), choice, end()], [edge('e1', 'trigger', 'choice'), edge('e2', 'choice', 'end', 'yes')]);
    const snapshot = structuredClone(graph);
    withPrototypeProperty('defaultPort', { get() { calls += 1; throw new Error('inherited poison'); } }, () => {
      const result = validateExecutableWorkflow(graph);
      expect(result).toEqual(malformedResult);
      expect(validateExecutableWorkflow(graph)).toEqual(result);
      expect(outputPorts(choice)).toEqual([]);
      expect(outputPorts(choice)).toEqual([]);
    });
    const missingNodes = validChain();
    Reflect.deleteProperty(missingNodes, 'nodes');
    const topologicalSnapshot = structuredClone(missingNodes);
    withPrototypeProperty('nodes', { get() { calls += 1; throw new Error('inherited poison'); } }, () => {
      expect(() => topologicalOrder(missingNodes)).toThrowError(invalidDefinitionError);
      expect(() => topologicalOrder(missingNodes)).toThrowError(invalidDefinitionError);
    });
    expect(calls).toBe(0);
    expect(graph).toEqual(snapshot);
    expect(missingNodes).toEqual(topologicalSnapshot);
  });

  it('ignores benign inherited values while preserving own-data diagnostics', () => {
    const inherited = condition('choice');
    Reflect.deleteProperty(inherited.config, 'defaultPort');
    const inheritedGraph = definition([trigger(), inherited, end()], [edge('e1', 'trigger', 'choice'), edge('e2', 'choice', 'end', 'yes')]);
    withPrototypeProperty('defaultPort', { value: 'inherited' }, () => {
      expect(outputPorts(inherited)).toEqual([]);
      expect(validateExecutableWorkflow(inheritedGraph)).toEqual(malformedResult);
    });
    const ownData = condition('choice') as unknown as { config: { defaultPort: unknown } };
    ownData.config.defaultPort = 1;
    const ownGraph = definition([trigger(), ownData as WorkflowNode, end()], [edge('e1', 'trigger', 'choice'), edge('e2', 'choice', 'end', 'yes')]);
    const snapshot = structuredClone(ownGraph);
    expect(validateExecutableWorkflow(ownGraph)).toEqual(malformedResult);
    expect(outputPorts(ownData as WorkflowNode)).toEqual([]);
    expect(outputPorts(ownData as WorkflowNode)).toEqual([]);
    expect(ownGraph).toEqual(snapshot);
  });
});

describe('Schedule trigger cron and timezone', () => {
  function scheduled(cron: string, timezone: string): WorkflowDefinition {
    return definition(
      [{ id: 'trigger', type: 'trigger', name: 'trigger', config: { kind: 'schedule', cron, timezone } }, end()],
      [edge('e1', 'trigger', 'end')],
    );
  }

  it('accepts a parseable cron expression paired with a real IANA timezone', () => {
    expect(validateExecutableWorkflow(scheduled('0 9 * * 1-5', 'Europe/Sofia'))).toEqual({ ok: true, issues: [] });
  });

  it.each([
    ['every weekday please', 'UTC', 'config.cron', 'schedule must be a valid cron expression'],
    ['0 9 * * 1-5', 'Mars/Olympus', 'config.timezone', 'timezone "Mars/Olympus" is not a valid IANA timezone'],
  ])('reports %j / %j as an invalid-schedule issue on its trigger node', (cron, timezone, path, message) => {
    const result = validateExecutableWorkflow(scheduled(cron, timezone));
    expect(result.ok).toBe(false);
    expect(issue(result, 'invalid-schedule')).toEqual({ code: 'invalid-schedule', message, nodeId: 'trigger', path });
  });
});

describe('Todo trigger filters', () => {
  function filtered(config: Record<string, unknown>): WorkflowDefinition {
    return definition(
      [{ id: 'todo-trigger', type: 'trigger', name: 'trigger',
        config: { kind: 'todo-status', status: 'assigned', ...config } as TriggerNode['config'] }, end()],
      [edge('e1', 'todo-trigger', 'end')],
    );
  }

  it('accepts each live filter on its own', () => {
    expect(validateExecutableWorkflow(filtered({ unlabeled: true, unassigned: true, rootOnly: true })))
      .toEqual({ ok: true, issues: [] });
    expect(validateExecutableWorkflow(filtered({ label: 'build', unassigned: true }))).toEqual({ ok: true, issues: [] });
  });

  it('rejects a trigger that demands no labels and a specific label at once', () => {
    const result = validateExecutableWorkflow(filtered({ unlabeled: true, label: 'build' }));

    expect(result.ok).toBe(false);
    expect(issue(result, 'conflicting-todo-filters')).toEqual({
      code: 'conflicting-todo-filters',
      message: 'A todo-status trigger cannot set both unlabeled and label: a Todo carrying no labels can never carry the one named. Set only one.',
      nodeId: 'todo-trigger',
      path: 'nodes.0.config.unlabeled',
    });
  });
});
