import { Buffer } from 'node:buffer';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ZodError } from 'zod';
import {
  jsonValueSchema,
  workflowIdSchema,
  workflowDefinitionSchema,
  workflowDraftSchema,
  workflowNodeSchema,
  type ApprovalNode,
  type Binding,
  type ConditionNode,
  type ConditionPredicate,
  type EmployeeNode,
  type EndNode,
  type JsonPrimitive,
  type JsonValue,
  type MergeNode,
  type TriggerNode,
  type WaitNode,
  type WorkflowDefinition,
  type WorkflowDraft,
  type WorkflowEdge,
  type WorkflowInputField,
  type WorkflowNode,
  type WorkflowNodeOutput,
  type WorkflowOutputSchema,
} from '../model.js';

const KiB = 1024;

type SafeParseSchema = {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean };
};

function expectSafeRejected(schema: SafeParseSchema, value: unknown): void {
  let result: { success: boolean } | undefined;
  expect(() => { result = schema.safeParse(value); }).not.toThrow();
  expect(result?.success).toBe(false);
  expect(result).not.toHaveProperty('data');
}

function expectCanonicalRejected(schema: SafeParseSchema, value: unknown): void {
  expectSafeRejected(schema, value);
  let thrown: unknown;
  try {
    schema.parse(value);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ZodError);
}

function ownDataRecord(key: PropertyKey, value: unknown): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
  return record;
}

function fixedJsonNode(value: unknown): EndNode {
  const node: any = endNode();
  node.config.output = { source: 'fixed', value };
  return node;
}

const triggerNode = (config: TriggerNode['config'] = { kind: 'manual' }): TriggerNode => ({
  id: 'start',
  type: 'trigger',
  name: 'Start',
  config,
});

const employeeNode = (id = 'work', prompt = 'Do the work.'): EmployeeNode => ({
  id,
  type: 'employee',
  name: 'Work',
  config: {
    employee: { source: 'fixed', value: 'worker' },
    prompt,
  },
});

const conditionNode = (): ConditionNode => ({
  id: 'route',
  type: 'condition',
  name: 'Route',
  config: {
    cases: [{
      port: 'matched',
      label: 'Matched',
      all: [{ left: { source: 'input', path: 'approved' }, operator: 'equals', right: { source: 'fixed', value: true } }],
    }],
    defaultPort: 'default',
  },
});

const mergeNode = (): MergeNode => ({ id: 'join', type: 'merge', name: 'Join', config: { mode: 'wait-all' } });
const approvalNode = (): ApprovalNode => ({
  id: 'approve',
  type: 'approval',
  name: 'Approve',
  config: { description: 'Approve this result.', approver: { source: 'run', path: 'id' } },
});
const waitNode = (): WaitNode => ({ id: 'pause', type: 'wait', name: 'Pause', config: { mode: 'duration', minutes: 1 } });
const workflowCallNode = () => ({
  id: 'children',
  type: 'workflow-call' as const,
  name: 'Run children',
  config: {
    workflowId: { source: 'fixed' as const, value: 'child-flow' },
    items: { source: 'node' as const, nodeId: 'work', path: 'fields.items' },
    input: {
      topic: { source: 'trigger' as const, path: 'item.topic' },
      ordinal: { source: 'trigger' as const, path: 'itemIndex' },
    },
    concurrency: 4,
  },
});
const endNode = (): EndNode => ({
  id: 'done',
  type: 'end',
  name: 'Done',
  config: { result: 'success', output: { source: 'node', nodeId: 'work', path: 'fields.result' } },
});

const edge = (id = 'edge-1'): WorkflowEdge => ({
  id,
  from: { nodeId: 'start', port: 'success' },
  to: { nodeId: 'work', port: 'input' },
});

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: 'example-workflow',
    title: 'Example workflow',
    description: 'A generic workflow fixture.',
    revision: 1,
    enabled: false,
    inputs: [{ key: 'approved', label: 'Approved', type: 'boolean', required: true }],
    nodes: [triggerNode(), employeeNode(), conditionNode(), mergeNode(), approvalNode(), waitNode(), endNode()],
    edges: [edge()],
    ui: { positions: { start: { x: 0, y: 0 }, work: { x: 280, y: 0 } } },
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

function draft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    nodes: [triggerNode(), employeeNode()],
    edges: [edge()],
    ...overrides,
  };
}

function definitionAtBytes(targetBytes: number, unit = 'x'): WorkflowDefinition {
  const value = definition({ description: '' });
  const baseBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  const unitBytes = Buffer.byteLength(unit, 'utf8');
  const remaining = targetBytes - baseBytes;
  if (remaining < 0 || unitBytes < 1) throw new Error('invalid byte fixture');
  value.description = unit.repeat(Math.floor(remaining / unitBytes)) + 'x'.repeat(remaining % unitBytes);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') !== targetBytes) throw new Error('byte fixture drifted');
  return value;
}

function expectDefinitionRejected(value: unknown, message?: RegExp): void {
  expect(() => workflowDefinitionSchema.parse(value)).toThrow(message);
}

const schemaSeams: Array<[string, SafeParseSchema, () => object]> = [
  ['jsonValueSchema', jsonValueSchema, () => ({ safe: true })],
  ['workflowNodeSchema', workflowNodeSchema, () => employeeNode()],
  ['workflowDraftSchema', workflowDraftSchema, () => draft()],
  ['workflowDefinitionSchema', workflowDefinitionSchema, () => definition()],
];

const hostileProxyFactories: Array<[string, (value: object) => object]> = [
  ['ownKeys', (value) => new Proxy(value, { ownKeys() { throw new Error('ownKeys trap'); } })],
  ['getOwnPropertyDescriptor', (value) => new Proxy(value, { getOwnPropertyDescriptor() { throw new Error('descriptor trap'); } })],
  ['getPrototypeOf', (value) => new Proxy(value, { getPrototypeOf() { throw new Error('prototype trap'); } })],
  ['get', (value) => new Proxy(value, { get() { throw new Error('get trap'); } })],
];

function ownKeysMutationProxy(value: object): object {
  let calls = 0;
  return new Proxy(value, {
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      if (++calls === 2) Object.defineProperty(target, 'later', { value: true, enumerable: true });
      return keys;
    },
  });
}

function mutateObservedValue(value: unknown): unknown {
  if (typeof value === 'string') return `${value}-changed`;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (Array.isArray(value)) return [...value];
  return value === null ? {} : { ...(value as object) };
}

function dataMutationProxy(value: object): object {
  const watched = Reflect.ownKeys(value).find((key) => key !== 'length')!;
  let reads = 0;
  return new Proxy(value, {
    get(target, key, receiver) {
      const observed = Reflect.get(target, key, receiver);
      if (key === watched && ++reads === 2) {
        Object.defineProperty(target, key, { ...Reflect.getOwnPropertyDescriptor(target, key), value: mutateObservedValue(observed) });
      }
      return observed;
    },
  });
}

function prototypeMutationProxy(value: object): object {
  let calls = 0;
  return new Proxy(value, {
    getPrototypeOf(target) {
      const prototype = Reflect.getPrototypeOf(target);
      if (++calls === 2) Object.setPrototypeOf(target, null);
      return prototype;
    },
  });
}

function arrayMutationProxy(): unknown[] {
  const target = [1];
  let calls = 0;
  return new Proxy(target, {
    ownKeys(value) {
      const keys = Reflect.ownKeys(value);
      if (++calls === 2) value.push(2);
      return keys;
    },
    getOwnPropertyDescriptor(value, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      return key === 'length' ? { ...descriptor, value: 1 } : descriptor;
    },
    get(value, key, receiver) {
      return key === 'length' ? 1 : Reflect.get(value, key, receiver);
    },
  });
}

describe('canonical workflow node model', () => {
  it('parses exactly the eight node discriminators', () => {
    const nodes: WorkflowNode[] = [
      triggerNode(),
      employeeNode(),
      workflowCallNode(),
      conditionNode(),
      mergeNode(),
      approvalNode(),
      waitNode(),
      endNode(),
    ];

    expect(nodes.map((node) => workflowNodeSchema.parse(node).type)).toEqual([
      'trigger', 'employee', 'workflow-call', 'condition', 'merge', 'approval', 'wait', 'end',
    ]);
    expectTypeOf<WorkflowNode['type']>().toEqualTypeOf<
      'trigger' | 'employee' | 'workflow-call' | 'condition' | 'merge' | 'approval' | 'wait' | 'end'
    >();
  });

  it('round-trips workflow-call bindings and applies only the authored concurrency default', () => {
    const authored = workflowCallNode();
    expect(workflowNodeSchema.parse(authored)).toEqual(authored);
    const { concurrency: _concurrency, ...withoutConcurrency } = authored.config;
    expect(workflowNodeSchema.parse({ ...authored, config: withoutConcurrency })).toEqual({
      ...authored,
      config: { ...withoutConcurrency, concurrency: 2 },
    });
    expect(workflowNodeSchema.safeParse({
      ...authored,
      config: { ...authored.config, unexpected: true },
    }).success).toBe(false);
  });

  it('parses all five trigger kinds and both Wait modes', () => {
    const triggerConfigs: TriggerNode['config'][] = [
      { kind: 'manual' },
      { kind: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' },
      { kind: 'event', eventName: 'release.ready', tokenRef: 'release-token' },
      { kind: 'todo-status', status: 'in_review' },
      { kind: 'workflow-call' },
    ];
    const waits: WaitNode[] = [
      waitNode(),
      { ...waitNode(), config: { mode: 'until', timestamp: { source: 'trigger', path: 'payload.resumeAt' } } },
    ];

    expect(triggerConfigs.map((config) => workflowNodeSchema.parse(triggerNode(config)).config)).toEqual(triggerConfigs);
    expect(waits.map((node) => {
      const parsed = workflowNodeSchema.parse(node);
      if (parsed.type !== 'wait') throw new Error('expected Wait node');
      return parsed.config.mode;
    })).toEqual(['duration', 'until']);
  });

  it('parses each live todo-status filter on its own and refuses a stored false', () => {
    const triggerConfigs: TriggerNode['config'][] = [
      { kind: 'todo-status', status: 'assigned', unlabeled: true },
      { kind: 'todo-status', status: 'assigned', unassigned: true },
      { kind: 'todo-status', status: 'assigned', rootOnly: true },
    ];

    expect(triggerConfigs.map((config) => workflowNodeSchema.parse(triggerNode(config)).config)).toEqual(triggerConfigs);
    expect(workflowNodeSchema.safeParse(triggerNode(
      { kind: 'todo-status', status: 'assigned', unlabeled: false } as unknown as TriggerNode['config'],
    )).success).toBe(false);
  });
});

describe('employee runtime boundaries', () => {
  it('parses all five Binding sources without a parallel expression model', () => {
    const bindings: Binding[] = [
      { source: 'fixed', value: { approved: true } },
      { source: 'input', path: 'reviewer' },
      { source: 'trigger', path: 'payload.repository' },
      { source: 'run', path: 'id' },
      { source: 'node', nodeId: 'work', path: 'fields.result' },
    ];
    const node = conditionNode();
    node.config.cases[0]!.all = bindings.map((left) => ({ left, operator: 'exists' }));

    const parsed = workflowNodeSchema.parse(node);
    if (parsed.type !== 'condition') throw new Error('expected Condition node');
    expect(parsed.config.cases[0]!.all.map((predicate) => predicate.left)).toEqual(bindings);
  });

  it('preserves optional retry and timeout fields instead of applying runtime defaults during parse', () => {
    const parsed = workflowNodeSchema.parse(employeeNode());
    expect(parsed.type).toBe('employee');
    if (parsed.type !== 'employee') return;
    expect(parsed.config).not.toHaveProperty('retry');
    expect(parsed.config).not.toHaveProperty('timeoutMinutes');

    const configured = employeeNode();
    configured.config.retry = { attempts: 5, delaySeconds: 0, backoff: 'exponential' };
    configured.config.timeoutMinutes = 1440;
    expect(workflowNodeSchema.parse(configured)).toEqual(configured);
  });

  it('enforces integer retry, timeout, and Wait numeric boundaries', () => {
    const configured = employeeNode();
    configured.config.retry = { attempts: 1, delaySeconds: 0, backoff: 'fixed' };
    configured.config.timeoutMinutes = 1;
    expect(workflowNodeSchema.safeParse(configured).success).toBe(true);

    for (const attempts of [0, 6, 1.5]) {
      const node: any = employeeNode();
      node.config.retry = { attempts, delaySeconds: 0, backoff: 'fixed' };
      expect(workflowNodeSchema.safeParse(node).success, `attempts=${attempts}`).toBe(false);
    }
    for (const [field, values] of [
      ['delaySeconds', [-1, 0.5]],
      ['timeoutMinutes', [0, 1.5, 1441]],
    ] as const) {
      for (const value of values) {
        const node: any = employeeNode();
        if (field === 'delaySeconds') node.config.retry = { attempts: 1, delaySeconds: value, backoff: 'fixed' };
        else node.config.timeoutMinutes = value;
        expect(workflowNodeSchema.safeParse(node).success, `${field}=${value}`).toBe(false);
      }
    }
    expect(workflowNodeSchema.safeParse({ ...waitNode(), config: { mode: 'duration', minutes: 1 } }).success).toBe(true);
    expect(workflowNodeSchema.safeParse({ ...waitNode(), config: { mode: 'duration', minutes: 43_200 } }).success).toBe(true);
    expect(workflowNodeSchema.safeParse({ ...waitNode(), config: { mode: 'duration', minutes: 0 } }).success).toBe(false);
    expect(workflowNodeSchema.safeParse({ ...waitNode(), config: { mode: 'duration', minutes: 1.5 } }).success).toBe(false);
    expect(workflowNodeSchema.safeParse({ ...waitNode(), config: { mode: 'duration', minutes: 43_201 } }).success).toBe(false);
  });
});

describe('employee Binding and output declarations', () => {
  it('locks fixed and dynamic Binding shapes for Employee runtime selectors', () => {
    const dynamic = employeeNode();
    dynamic.config.employee = { source: 'input', path: 'employee' };
    dynamic.config.engine = { source: 'trigger', path: 'payload.engine' };
    dynamic.config.model = { source: 'node', nodeId: 'work', path: 'fields.model' };
    dynamic.config.effort = { source: 'run', path: 'effort' };
    expect(workflowNodeSchema.safeParse(dynamic).success).toBe(true);

    const fixed = employeeNode();
    fixed.config.engine = { source: 'fixed', value: 'codex' };
    fixed.config.model = { source: 'fixed', value: 'model-name' };
    fixed.config.effort = { source: 'fixed', value: 'xhigh' };
    expect(workflowNodeSchema.safeParse(fixed).success).toBe(true);

    for (const [field, binding] of [
      ['employee', { source: 'fixed', value: 1 }],
      ['engine', { source: 'fixed', value: false }],
      ['model', { source: 'fixed', value: { name: 'model' } }],
      ['effort', { source: 'fixed', value: 'extreme' }],
      ['employee', { source: 'input', path: 'employee', value: 'worker' }],
      ['effort', { source: 'fixed', value: 'low', path: 'effort' }],
    ] as const) {
      const node: any = employeeNode();
      node.config[field] = binding;
      expect(workflowNodeSchema.safeParse(node).success, `${field}:${JSON.stringify(binding)}`).toBe(false);
    }
  });

  it('supports flat closed output declarations', () => {
    const output: WorkflowOutputSchema = {
      fields: {
        summary: { type: 'string', required: true, description: 'Short result.' },
        scores: { type: 'string[]', required: false },
      },
      allowAdditionalFields: false,
    };
    const node = employeeNode();
    node.config.output = output;

    expect(workflowNodeSchema.parse(node)).toEqual(node);
    expect(() => workflowNodeSchema.parse({
      ...node,
      config: { ...node.config, output: { ...output, fields: { bad: { type: 'object', required: true } } } },
    })).toThrow();
  });

  it('requires addressable output field keys without narrowing arbitrary fixed JSON keys', () => {
    for (const key of ['valid_field', 'Valid-Field2']) {
      const node: any = employeeNode();
      node.config.output = { fields: { [key]: { type: 'string', required: true } }, allowAdditionalFields: false };
      expect(workflowNodeSchema.safeParse(node).success, key).toBe(true);
    }
    for (const key of ['dotted.field', 'field[0]', '0field', '__proto__', 'prototype', 'constructor']) {
      const fields = ownDataRecord(key, { type: 'string', required: true });
      const node: any = employeeNode();
      node.config.output = { fields, allowAdditionalFields: false };
      expect(workflowNodeSchema.safeParse(node).success, key).toBe(false);
    }

    expect(jsonValueSchema.safeParse({ 'dotted.key': true, 'bracket[key]': false }).success).toBe(true);
  });
});

describe('closed structural parsing', () => {
  it.each([
    ['definition', (value: any) => { value.extra = true; }],
    ['input declaration', (value: any) => { value.inputs[0].extra = true; }],
    ['node', (value: any) => { value.nodes[1].actor = {}; }],
    ['node config', (value: any) => { value.nodes[1].config.extra = true; }],
    ['Binding', (value: any) => { value.nodes[1].config.employee.extra = true; }],
    ['output schema', (value: any) => { value.nodes[1].config.output = { fields: {}, allowAdditionalFields: false, extra: true }; }],
    ['output field', (value: any) => { value.nodes[1].config.output = { fields: { result: { type: 'string', required: true, extra: true } }, allowAdditionalFields: false }; }],
    ['retry', (value: any) => { value.nodes[1].config.retry = { attempts: 1, delaySeconds: 0, backoff: 'fixed', extra: true }; }],
    ['edge', (value: any) => { value.edges[0].extra = true; }],
    ['edge source', (value: any) => { value.edges[0].from.extra = true; }],
    ['edge target', (value: any) => { value.edges[0].to.extra = true; }],
    ['ui', (value: any) => { value.ui.extra = true; }],
    ['ui point', (value: any) => { value.ui.positions.start.z = 1; }],
  ])('rejects unknown fields at the %s boundary', (_label, mutate) => {
    const value: any = structuredClone(definition());
    mutate(value);
    expectDefinitionRejected(value);
  });

  it.each([
    ['manual trigger with schedule fields', { ...triggerNode(), config: { kind: 'manual', cron: '* * * * *' } }],
    ['input Binding with a fixed value', { ...employeeNode(), config: { ...employeeNode().config, employee: { source: 'input', path: 'worker', value: 'worker' } } }],
    ['fixed Binding with a path', { ...endNode(), config: { result: 'success', output: { source: 'fixed', value: true, path: 'value' } } }],
    ['until Wait with duration fields', { ...waitNode(), config: { mode: 'until', timestamp: { source: 'input', path: 'resumeAt' }, minutes: 1 } }],
  ])('rejects misplaced fields in %s', (_label, node) => {
    expect(() => workflowNodeSchema.parse(node)).toThrow();
  });

  it('rejects invalid node, trigger, Binding, Wait, and End discriminators', () => {
    expect(() => workflowNodeSchema.parse({ ...employeeNode(), type: 'step' })).toThrow();
    expect(() => workflowNodeSchema.parse({ ...triggerNode(), config: { kind: 'poll' } })).toThrow();
    expect(() => workflowNodeSchema.parse({ ...employeeNode(), config: { ...employeeNode().config, employee: { source: 'env', path: 'USER' } } })).toThrow();
    expect(() => workflowNodeSchema.parse({ ...waitNode(), config: { mode: 'cron', cron: '* * * * *' } })).toThrow();
    expect(() => workflowNodeSchema.parse({ ...endNode(), config: { result: 'cancelled' } })).toThrow();
  });
});

describe('UTF-8 byte and collection limits', () => {
  it.each([
    [255 * KiB, true],
    [256 * KiB, true],
    [257 * KiB, false],
  ])('enforces the %i-byte definition boundary', (bytes, accepted) => {
    const result = workflowDefinitionSchema.safeParse(definitionAtBytes(bytes));
    expect(result.success).toBe(accepted);
    if (!accepted) expect(result.error?.message).toMatch(/256 KiB/);
  });

  it('counts definition JSON in UTF-8 bytes for multibyte content', () => {
    expect(workflowDefinitionSchema.safeParse(definitionAtBytes(256 * KiB, 'é')).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(definitionAtBytes(256 * KiB + 1, 'é')).success).toBe(false);
  });

  it('enforces the 32 KiB prompt boundary in UTF-8 bytes', () => {
    expect(workflowNodeSchema.safeParse(employeeNode('work', 'x'.repeat(32 * KiB))).success).toBe(true);
    const oversized = workflowNodeSchema.safeParse(employeeNode('work', 'x'.repeat(32 * KiB + 1)));
    expect(oversized.success).toBe(false);
    if (!oversized.success) expect(oversized.error.message).toMatch(/32 KiB/);
    expect(workflowNodeSchema.safeParse(employeeNode('work', 'é'.repeat(16 * KiB))).success).toBe(true);
    expect(workflowNodeSchema.safeParse(employeeNode('work', `${'é'.repeat(16 * KiB)}x`)).success).toBe(false);
  });

  it.each([[99, true], [100, true], [101, false]])('enforces the %i-node boundary', (count, accepted) => {
    const nodes = Array.from({ length: count }, (_, index) => employeeNode(`node_${index}`));
    expect(workflowDefinitionSchema.safeParse(definition({ nodes, edges: [] })).success).toBe(accepted);
  });

  it.each([[299, true], [300, true], [301, false]])('enforces the %i-edge boundary', (count, accepted) => {
    const edges = Array.from({ length: count }, (_, index) => edge(`edge-${index}`));
    expect(workflowDefinitionSchema.safeParse(definition({ edges })).success).toBe(accepted);
  });

  it('enforces ten Condition cases and ten predicates per case', () => {
    const node = conditionNode();
    node.config.cases = Array.from({ length: 10 }, (_, index) => ({ port: `case_${index}`, label: `Case ${index}`, all: [] }));
    expect(workflowNodeSchema.safeParse(node).success).toBe(true);
    node.config.cases.push({ port: 'case_10', label: 'Case 10', all: [] });
    expect(workflowNodeSchema.safeParse(node).success).toBe(false);

    const predicate: ConditionPredicate = { left: { source: 'input', path: 'value' }, operator: 'exists' };
    const predicates = conditionNode();
    predicates.config.cases[0]!.all = Array.from({ length: 10 }, () => predicate);
    expect(workflowNodeSchema.safeParse(predicates).success).toBe(true);
    predicates.config.cases[0]!.all.push(predicate);
    expect(workflowNodeSchema.safeParse(predicates).success).toBe(false);
  });
});

describe('identifiers, labels, events, and paths', () => {
  it('reserves the Event transport identity while leaving neighboring Workflow IDs valid', () => {
    expect(workflowIdSchema.safeParse('events').success).toBe(false);
    expect(workflowDefinitionSchema.safeParse(definition({ id: 'events' })).success).toBe(false);
    for (const id of ['event', 'events-v2', 'event-flow']) {
      expect(workflowIdSchema.safeParse(id).success, id).toBe(true);
      expect(workflowDefinitionSchema.safeParse(definition({ id })).success, id).toBe(true);
    }
  });

  it('enforces workflow, node, edge, title, and node-name boundaries', () => {
    expect(workflowDefinitionSchema.safeParse(definition({ id: `a${'b'.repeat(63)}`, title: 't'.repeat(120) })).success).toBe(true);
    for (const id of [`a${'b'.repeat(64)}`, '1workflow', 'Workflow', 'work_flow']) {
      expect(workflowDefinitionSchema.safeParse(definition({ id })).success, id).toBe(false);
    }
    expectDefinitionRejected(definition({ title: '' }));
    expectDefinitionRejected(definition({ title: 't'.repeat(121) }));

    expect(workflowNodeSchema.safeParse(employeeNode(`a${'b'.repeat(63)}`)).success).toBe(true);
    for (const id of [`a${'b'.repeat(64)}`, '1node', 'Node', 'node.dot']) {
      expect(workflowNodeSchema.safeParse({ ...employeeNode(), id }).success, id).toBe(false);
    }
    expect(workflowNodeSchema.safeParse({ ...employeeNode(), name: 'n'.repeat(80) }).success).toBe(true);
    expect(workflowNodeSchema.safeParse({ ...employeeNode(), name: '' }).success).toBe(false);
    expect(workflowNodeSchema.safeParse({ ...employeeNode(), name: 'n'.repeat(81) }).success).toBe(false);

    expect(workflowDefinitionSchema.safeParse(definition({ edges: [{ ...edge(), id: 'e'.repeat(128) }] })).success).toBe(true);
    expectDefinitionRejected(definition({ edges: [{ ...edge(), id: '' }] }));
    expectDefinitionRejected(definition({ edges: [{ ...edge(), id: 'e'.repeat(129) }] }));
  });

  it('enforces event-name length and grammar', () => {
    const event = (eventName: string) => triggerNode({ kind: 'event', eventName });
    expect(workflowNodeSchema.safeParse(event(`E${'a'.repeat(79)}`)).success).toBe(true);
    for (const name of [`E${'a'.repeat(80)}`, '1event', 'release ready', 'release/ready', '']) {
      expect(workflowNodeSchema.safeParse(event(name)).success, name).toBe(false);
    }
  });

  it('enforces relative paths, 256 characters, and 16 safe identifier segments', () => {
    const withPath = (path: string) => ({
      ...employeeNode(),
      config: { ...employeeNode().config, employee: { source: 'input', path } },
    });
    expect(workflowNodeSchema.safeParse(withPath('a'.repeat(256))).success).toBe(true);
    expect(workflowNodeSchema.safeParse(withPath('a'.repeat(257))).success).toBe(false);
    expect(workflowNodeSchema.safeParse(withPath(Array.from({ length: 16 }, (_, i) => `s${i}`).join('.'))).success).toBe(true);
    expect(workflowNodeSchema.safeParse(withPath(Array.from({ length: 17 }, (_, i) => `s${i}`).join('.'))).success).toBe(false);
    for (const path of ['', '.value', 'value.', 'a..b', '$.value', 'items[0]', 'input.reviewer', 'trigger.payload', 'run.id', 'nodes.work']) {
      expect(workflowNodeSchema.safeParse(withPath(path)).success, path).toBe(false);
    }
    for (const dangerous of ['__proto__', 'prototype', 'constructor', 'safe.__proto__.value']) {
      expect(workflowNodeSchema.safeParse(withPath(dangerous)).success, dangerous).toBe(false);
    }
  });
});

describe('schema-level cross-field invariants', () => {
  it('rejects duplicate node IDs, edge IDs, and workflow input keys', () => {
    expectDefinitionRejected(definition({ nodes: [employeeNode('same'), employeeNode('same')], edges: [] }), /duplicate node ID/i);
    expectDefinitionRejected(definition({ edges: [edge('same'), edge('same')] }), /duplicate edge ID/i);
    const inputs: WorkflowInputField[] = [
      { key: 'topic', label: 'Topic', type: 'string', required: true },
      { key: 'topic', label: 'Other topic', type: 'string', required: false },
    ];
    expectDefinitionRejected(definition({ inputs }), /duplicate input key/i);
  });

  it('rejects enabled retired definitions', () => {
    expectDefinitionRejected(definition({ enabled: true, retiredAt: '2026-07-20T00:00:00.000Z' }), /retired.*enabled/i);
    expect(workflowDefinitionSchema.safeParse(definition({ enabled: false, retiredAt: '2026-07-20T00:00:00.000Z' })).success).toBe(true);
  });

  it('requires locally unique nonempty Condition case and default ports', () => {
    const duplicate = conditionNode();
    duplicate.config.cases.push({ port: 'matched', label: 'Again', all: [] });
    expect(() => workflowNodeSchema.parse(duplicate)).toThrow(/duplicate condition port/i);
    const collidingDefault = conditionNode();
    collidingDefault.config.defaultPort = 'matched';
    expect(() => workflowNodeSchema.parse(collidingDefault)).toThrow(/default port/i);
    for (const mutate of [
      (node: ConditionNode) => { node.config.cases[0]!.port = ''; },
      (node: ConditionNode) => { node.config.defaultPort = ''; },
    ]) {
      const value = conditionNode();
      mutate(value);
      expect(workflowNodeSchema.safeParse(value).success).toBe(false);
    }
  });

  it('locks target ports to input while leaving authored source ports structurally unbounded', () => {
    expect(workflowDefinitionSchema.safeParse(definition({ edges: [{ ...edge(), from: { nodeId: 'start', port: 'p'.repeat(512) } }] })).success).toBe(true);
    expectDefinitionRejected(definition({ edges: [{ ...edge(), from: { nodeId: 'start', port: '' } }] }));
    expectDefinitionRejected(definition({ edges: [{ ...edge(), to: { nodeId: 'work', port: 'target' as 'input' } }] }));

    const condition = conditionNode();
    condition.config.cases[0]!.port = 'c'.repeat(512);
    condition.config.defaultPort = 'd'.repeat(512);
    expect(workflowNodeSchema.safeParse(condition).success).toBe(true);
  });

  it('validates finite UI point shapes without checking graph correspondence', () => {
    expect(workflowDefinitionSchema.safeParse(definition({ ui: { positions: { absent: { x: -1.5, y: 2.25 } } } })).success).toBe(true);
    expectDefinitionRejected(definition({ ui: { positions: { start: { x: Number.NaN, y: 0 } } } }));
    expectDefinitionRejected(definition({ ui: { positions: { start: { x: 0 } as { x: number; y: number } } } }));
  });

  it('carries a manual layout marker and rejects any other provenance value', () => {
    const marked = definition({ ui: { positions: { start: { x: 0, y: 0 } }, layout: 'manual' } });
    expect(workflowDefinitionSchema.parse(marked).ui).toEqual({ positions: { start: { x: 0, y: 0 } }, layout: 'manual' });
    expectDefinitionRejected(definition({ ui: { positions: {}, layout: 'auto' as 'manual' } }));
  });

  it('requires UI position keys to use node ID grammar', () => {
    for (const key of ['node_1', 'node-2']) {
      expect(workflowDefinitionSchema.safeParse(definition({ ui: { positions: { [key]: { x: 0, y: 0 } } } })).success, key).toBe(true);
    }
    for (const key of ['Node', 'node.dot', 'node[0]', '__proto__', 'prototype', 'constructor']) {
      const positions = ownDataRecord(key, { x: 0, y: 0 });
      expect(workflowDefinitionSchema.safeParse(definition({ ui: { positions: positions as any } })).success, key).toBe(false);
    }
  });
});

describe('draft versus persisted definition', () => {
  it('accepts empty and structurally incomplete drafts', () => {
    expect(workflowDraftSchema.parse({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
    expect(workflowDraftSchema.safeParse(draft({ nodes: [employeeNode()], edges: [] })).success).toBe(true);
  });

  it('keeps persisted metadata out of drafts and requires it on definitions', () => {
    expect(workflowDraftSchema.safeParse(definition()).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse(draft()).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse(definition({ nodes: [], edges: [] })).success).toBe(true);
  });

  it('retains structural and product safety bounds for drafts', () => {
    expect(workflowDraftSchema.safeParse(draft({ nodes: Array.from({ length: 101 }, (_, i) => employeeNode(`node_${i}`)), edges: [] })).success).toBe(false);
    expect(workflowDraftSchema.safeParse(draft({ nodes: [{ ...employeeNode(), id: 'bad.id' }], edges: [] })).success).toBe(false);
    expect(workflowDraftSchema.safeParse({ ...draft(), extra: true }).success).toBe(false);
  });
});

describe('trap-free Proxy rejection', () => {
  it.each(schemaSeams)('rejects a nonthrowing benign Proxy at the %s seam', (_name, schema, fixture) => {
    expectCanonicalRejected(schema, new Proxy(fixture(), {}));
  });

  it.each(hostileProxyFactories)('rejects a hostile %s Proxy at every exported seam', (_name, proxy) => {
    for (const [, schema, fixture] of schemaSeams) expectCanonicalRejected(schema, proxy(fixture()));
  });

  it.each([
    ['ownKeys mutation', ownKeysMutationProxy],
    ['data mutation after observation', dataMutationProxy],
    ['prototype mutation', prototypeMutationProxy],
  ])('rejects a stateful Proxy with %s at every exported seam', (_name, proxy) => {
    for (const [, schema, fixture] of schemaSeams) expectCanonicalRejected(schema, proxy(fixture()));
  });

  it('rejects an array Proxy that changes its keys and length during inspection', () => {
    expectCanonicalRejected(jsonValueSchema, arrayMutationProxy());
  });
});

describe('safe canonical JSON containers', () => {
  it('accepts plain and null-prototype records', () => {
    const plain = { values: [null, true, 1, 'ok'], 'arbitrary.key': 'data' };
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(nullPrototype, 'value', { value: plain, enumerable: true, configurable: true, writable: true });

    expect(jsonValueSchema.safeParse(plain).success).toBe(true);
    expect(jsonValueSchema.safeParse(nullPrototype).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(definition({ nodes: [fixedJsonNode(nullPrototype)], edges: [] })).success).toBe(true);
  });

  it('rejects cycles, class instances, array subclasses, and non-JSON values', () => {
    class RecordClass { value = true; }
    class ArraySubclass extends Array<unknown> {}
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const arrayWithExtra: unknown[] & { extra?: boolean } = [1];
    arrayWithExtra.extra = true;
    const symbolKey = ownDataRecord(Symbol('extra'), true);
    const invalidValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      1n,
      Symbol('value'),
      () => true,
      new Date(),
      new Map(),
      new RecordClass(),
      new ArraySubclass(1, 2),
      cycle,
      arrayWithExtra,
      symbolKey,
    ];

    for (const value of invalidValues) {
      expectSafeRejected(jsonValueSchema, value);
      expectSafeRejected(workflowDefinitionSchema, definition({ nodes: [fixedJsonNode(value)], edges: [] }));
    }
  });

  it('rejects dangerous own JSON keys without narrowing other arbitrary keys', () => {
    expect(jsonValueSchema.safeParse({ 'dotted.key': true, 'bracket[key]': false, '0': null }).success).toBe(true);
    for (const key of ['__proto__', 'prototype', 'constructor']) {
      const value = ownDataRecord(key, true);
      expectSafeRejected(jsonValueSchema, value);
      expectSafeRejected(workflowDefinitionSchema, definition({ nodes: [fixedJsonNode(value)], edges: [] }));
    }
  });

  it.each([true, false])('rejects %s enumerable getters without invoking them', (enumerable) => {
    let getterCalls = 0;
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, 'secret', {
      enumerable,
      get() {
        getterCalls += 1;
        return 'unsafe';
      },
    });
    expectSafeRejected(jsonValueSchema, value);
    expectSafeRejected(workflowDefinitionSchema, definition({ nodes: [fixedJsonNode(value)], edges: [] }));

    const hostileDefinition = definition();
    Object.defineProperty(hostileDefinition, 'description', {
      enumerable,
      get() {
        getterCalls += 1;
        return 'unsafe';
      },
    });
    expectSafeRejected(workflowDefinitionSchema, hostileDefinition);
    expect(getterCalls).toBe(0);
  });
});

describe('JSON capacity below the definition byte cap', () => {
  it.each([31, 32, 33, 64, 512])('accepts depth %i', (depth) => {
    let deep: JsonValue = 'leaf';
    for (let index = 0; index < depth; index += 1) deep = { next: deep };
    const deepDefinition = definition({ nodes: [fixedJsonNode(deep)], edges: [] });

    expect(Buffer.byteLength(JSON.stringify(deepDefinition), 'utf8')).toBeLessThan(256 * KiB);
    expect(jsonValueSchema.safeParse(deep).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(deepDefinition).success).toBe(true);
  });

  it.each([9_999, 10_000, 10_001])('accepts %i values', (count) => {
    const many: JsonValue = Array.from({ length: count }, () => 0);
    const manyDefinition = definition({ nodes: [fixedJsonNode(many)], edges: [] });

    expect(Buffer.byteLength(JSON.stringify(manyDefinition), 'utf8')).toBeLessThan(256 * KiB);
    expect(jsonValueSchema.safeParse(many).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(manyDefinition).success).toBe(true);
  });
});

describe('canonical node output type', () => {
  it('exports the locked JSON and node-output shapes', () => {
    const primitive: JsonPrimitive = null;
    const json: JsonValue = { primitive, list: [true, 1, 'value'] };
    const output: WorkflowNodeOutput = { text: 'Done.', fields: { result: json }, employeeId: 'worker', sessionId: 'session-1' };
    expect(output).toMatchObject({ text: 'Done.', employeeId: 'worker' });
    expectTypeOf(output.fields).toEqualTypeOf<Record<string, JsonValue>>();
  });
});
