import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  interpolateWorkflowPrompt,
  resolveBinding,
  validateBindingPath,
  WorkflowBindingError,
  type WorkflowBindingContext,
} from '../bindings.js';
import { bindingSchema, type Binding, type JsonValue } from '../model.js';
import type { WorkflowError } from '../runtime.js';

function context(): WorkflowBindingContext {
  return {
    input: {
      reviewer: 'reviewer',
      count: 2,
      approved: true,
      empty: null,
      unicode: 'Здравей',
      negativeZero: -0,
      list: ['one', { nested: true }],
      record: { nested: { value: 'safe' } },
      braces: '{{ trigger.kind }}',
    },
    trigger: { kind: 'event', payload: { repository: 'example/repository' } },
    nodes: {
      plan: {
        status: 'completed',
        output: { text: 'Plan ready.', fields: { reviewer: 'reviewer', scores: [1, 2] } },
        error: null,
      },
      empty: { status: 'completed', output: null, error: null },
    },
    run: { id: 'run-1', startedAt: '2026-07-20T00:00:00.000Z' },
  };
}

function expectBindingError(action: () => unknown, code: WorkflowBindingError['code']): WorkflowBindingError {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WorkflowBindingError);
  expect(thrown).toMatchObject({ name: 'WorkflowBindingError', code });
  return thrown as WorkflowBindingError;
}

function ownRecord(key: PropertyKey, value: unknown): Record<string, JsonValue> {
  const record = Object.create(null) as Record<string, JsonValue>;
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true });
  return record;
}

describe('WorkflowBindingContext', () => {
  it('owns the locked binding-context shape', () => {
    const error: WorkflowError = { code: 'failed', message: 'Failed.', retryable: false };
    const value = context();
    value.nodes.plan!.error = error;

    expect(value.nodes.plan).toMatchObject({ status: 'completed', error });
    expectTypeOf(value).toEqualTypeOf<WorkflowBindingContext>();
  });
});

describe('WorkflowBindingError', () => {
  it('has the exact public name, code union, and Error behavior', () => {
    const error = new WorkflowBindingError('invalid-path', 'Invalid binding path');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('WorkflowBindingError');
    expect(error.code).toBe('invalid-path');
    expectTypeOf(error.code).toEqualTypeOf<'invalid-path' | 'missing-value' | 'type-mismatch' | 'unsafe-value'>();
  });
});

describe('validateBindingPath', () => {
  it.each([
    ['value', ['value']],
    ['Valid_name-2', ['Valid_name-2']],
    ['a'.repeat(256), ['a'.repeat(256)]],
    [Array.from({ length: 16 }, (_, index) => `s${index}`).join('.'), Array.from({ length: 16 }, (_, index) => `s${index}`)],
    ['input', ['input']],
    ['trigger', ['trigger']],
    ['run', ['run']],
    ['nodes', ['nodes']],
    ['safe.input.trigger.run.nodes', ['safe', 'input', 'trigger', 'run', 'nodes']],
  ])('accepts the valid relative path %s', (path, expected) => {
    expect(validateBindingPath(path)).toEqual(expected);
  });

  it('returns a fresh segments array without mutable global state', () => {
    const first = validateBindingPath('fields.reviewer');
    first[0] = 'changed';
    expect(validateBindingPath('fields.reviewer')).toEqual(['fields', 'reviewer']);
  });

  it.each([
    '',
    'a'.repeat(257),
    Array.from({ length: 17 }, (_, index) => `s${index}`).join('.'),
    '.value', 'value.', 'a..b', 'with space', ' value', 'value ', '0value',
    '$.value', 'items[0]', 'call()', 'a+b', 'a/b', String.raw`a\b`, String.raw`a\u002eb`,
    '__proto__', 'safe.__proto__.value', 'prototype', 'safe.prototype', 'constructor', 'safe.constructor',
    'input.value', 'trigger.payload', 'run.id', 'nodes.plan',
  ])('rejects the invalid relative path %s', (path) => {
    expectBindingError(() => validateBindingPath(path), 'invalid-path');
  });

  it.each([undefined, null, 1, {}, new String('value')])('maps non-string input to invalid-path without leaking arbitrary errors', (path) => {
    expectBindingError(() => validateBindingPath(path as string), 'invalid-path');
  });
});

describe('resolveBinding source roots', () => {
  it('resolves single-segment source words as ordinary own field names', () => {
    const value = context();
    (value.input as Record<string, JsonValue>).input = 'input value';
    (value.trigger as unknown as Record<string, JsonValue>).trigger = 'trigger value';
    (value.run as unknown as Record<string, JsonValue>).run = 'run value';
    (value.nodes.plan!.output as unknown as Record<string, JsonValue>).nodes = 'nodes value';
    expect(resolveBinding({ source: 'input', path: 'input' }, value)).toBe('input value');
    expect(resolveBinding({ source: 'trigger', path: 'trigger' }, value)).toBe('trigger value');
    expect(resolveBinding({ source: 'run', path: 'run' }, value)).toBe('run value');
    expect(resolveBinding({ source: 'node', nodeId: 'plan', path: 'nodes' }, value)).toBe('nodes value');
    expect(interpolateWorkflowPrompt('{{ input.input }} / {{ node.plan.nodes }}', value)).toBe('input value / nodes value');
  });

  it.each([
    { source: 'input', path: 'input' }, { source: 'trigger', path: 'trigger' },
    { source: 'run', path: 'run' }, { source: 'node', nodeId: 'plan', path: 'nodes' },
  ] as Binding[])('maps an absent single-segment source word for $source to missing-value', (binding) => {
    expectBindingError(() => resolveBinding(binding, context()), 'missing-value');
  });

  it.each<[string, Binding, unknown]>([
    ['fixed string', { source: 'fixed', value: 'value' }, 'value'],
    ['fixed number', { source: 'fixed', value: -0 }, -0],
    ['fixed boolean', { source: 'fixed', value: false }, false],
    ['fixed null', { source: 'fixed', value: null }, null],
    ['fixed array', { source: 'fixed', value: [1, { ok: true }] }, [1, { ok: true }]],
    ['fixed object', { source: 'fixed', value: { ok: true } }, { ok: true }],
    ['input', { source: 'input', path: 'reviewer' }, 'reviewer'],
    ['trigger kind', { source: 'trigger', path: 'kind' }, 'event'],
    ['trigger payload', { source: 'trigger', path: 'payload.repository' }, 'example/repository'],
    ['run id', { source: 'run', path: 'id' }, 'run-1'],
    ['run timestamp', { source: 'run', path: 'startedAt' }, '2026-07-20T00:00:00.000Z'],
    ['node field', { source: 'node', nodeId: 'plan', path: 'fields.reviewer' }, 'reviewer'],
    ['node text', { source: 'node', nodeId: 'plan', path: 'text' }, 'Plan ready.'],
    ['whole array', { source: 'input', path: 'list' }, ['one', { nested: true }]],
    ['whole object', { source: 'input', path: 'record' }, { nested: { value: 'safe' } }],
    ['node array', { source: 'node', nodeId: 'plan', path: 'fields.scores' }, [1, 2]],
  ])('resolves %s', (_label, binding, expected) => {
    const resolved = resolveBinding(binding, context());
    expect(resolved).toEqual(expected);
    if (Object.is(expected, -0)) expect(Object.is(resolved, -0)).toBe(true);
  });

  it('does not expose node status or error through the output root', () => {
    expectBindingError(() => resolveBinding({ source: 'node', nodeId: 'plan', path: 'status' }, context()), 'missing-value');
    expectBindingError(() => resolveBinding({ source: 'node', nodeId: 'plan', path: 'error' }, context()), 'missing-value');
  });

  it('does not expose array implementation properties as JSON paths', () => {
    expectBindingError(() => resolveBinding({ source: 'input', path: 'list.length' }, context()), 'missing-value');
  });

  it.each([
    { source: 'input', path: 'absent' },
    { source: 'input', path: 'record.absent' },
    { source: 'node', nodeId: 'absent', path: 'text' },
    { source: 'node', nodeId: 'empty', path: 'text' },
  ] as Binding[])('maps absent values for $source to missing-value', (binding) => {
    expectBindingError(() => resolveBinding(binding, context()), 'missing-value');
  });
});

describe('own record traversal and canonical node identifiers', () => {
  it('reads own properties only', () => {
    const inherited: Record<string, JsonValue> = { own: 'safe' };
    const value = context();
    value.input = inherited;
    expect(resolveBinding({ source: 'input', path: 'own' }, value)).toBe('safe');
    expectBindingError(() => resolveBinding({ source: 'input', path: 'toString' }, value), 'missing-value');
  });

  it('supports null-prototype context records', () => {
    const value = Object.create(null) as WorkflowBindingContext;
    Object.defineProperties(value, {
      input: { value: ownRecord('reviewer', 'reviewer'), enumerable: true },
      trigger: { value: Object.assign(Object.create(null), { kind: 'manual', payload: Object.create(null) }), enumerable: true },
      nodes: { value: Object.create(null), enumerable: true },
      run: { value: Object.assign(Object.create(null), { id: 'run-null', startedAt: 'now' }), enumerable: true },
    });
    expect(resolveBinding({ source: 'input', path: 'reviewer' }, value)).toBe('reviewer');
    expect(resolveBinding({ source: 'run', path: 'id' }, value)).toBe('run-null');
  });

  it.each(['constructor', 'prototype'])('accepts canonical node ID %s and resolves only its own node descriptor', (nodeId) => {
    const binding = { source: 'node', nodeId, path: 'fields.value' } as const;
    const value = context();
    value.nodes = ownRecord(nodeId, { status: 'completed', output: { text: 'safe', fields: { value: nodeId } }, error: null }) as WorkflowBindingContext['nodes'];
    expect(bindingSchema.safeParse(binding).success).toBe(true);
    expect(resolveBinding(binding, value)).toBe(nodeId);
    expect(interpolateWorkflowPrompt(`{{ node.${nodeId}.fields.value }}`, value)).toBe(nodeId);
    expectBindingError(() => resolveBinding(binding, context()), 'missing-value');
  });

  it.each(['Constructor', 'node.dot', '1node', `a${'b'.repeat(64)}`, '__proto__'])('defers invalid node ID %s to canonical schema', (nodeId) => {
    const binding = { source: 'node', nodeId, path: 'text' } as unknown as Binding;
    expect(bindingSchema.safeParse(binding).success).toBe(false);
    expectBindingError(() => resolveBinding(binding, context()), 'invalid-path');
  });

  it('never invokes inherited nodes, node-map getters, or Proxy traps', () => {
    const before = Object.getOwnPropertyDescriptor(Object.prototype, 'constructor');
    let calls = 0;
    const getter = {} as WorkflowBindingContext['nodes'];
    Object.defineProperty(getter, 'constructor', { enumerable: true, get() { calls += 1; return {}; } });
    const value = context();
    value.nodes = getter;
    expectBindingError(() => resolveBinding({ source: 'node', nodeId: 'constructor', path: 'text' }, value), 'unsafe-value');
    value.nodes = new Proxy({}, { ownKeys() { calls += 1; throw new Error('trap'); } });
    expectBindingError(() => resolveBinding({ source: 'node', nodeId: 'prototype', path: 'text' }, value), 'unsafe-value');
    expect(calls).toBe(0);
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'constructor')).toEqual(before);
  });
});

describe('fail-closed traversal and normalization', () => {
  it('never invokes getters', () => {
    let calls = 0;
    const input: Record<string, JsonValue> = {};
    Object.defineProperty(input, 'secret', { enumerable: true, get() { calls += 1; return 'unsafe'; } });
    const value = context();
    value.input = input;
    expectBindingError(() => resolveBinding({ source: 'input', path: 'secret' }, value), 'unsafe-value');

    const nested: Record<string, JsonValue> = {};
    Object.defineProperty(nested, 'secret', { enumerable: true, get() { calls += 1; return 'unsafe'; } });
    value.input = { nested };
    expectBindingError(() => resolveBinding({ source: 'input', path: 'nested' }, value), 'unsafe-value');
    expect(calls).toBe(0);
  });

  it.each([
    ['benign', (target: object) => new Proxy(target, {})],
    ['throwing ownKeys', (target: object) => new Proxy(target, { ownKeys() { throw new Error('trap'); } })],
    ['throwing descriptor', (target: object) => new Proxy(target, { getOwnPropertyDescriptor() { throw new Error('trap'); } })],
    ['throwing prototype', (target: object) => new Proxy(target, { getPrototypeOf() { throw new Error('trap'); } })],
    ['stateful', (target: object) => new Proxy(target, { ownKeys(value) { Object.defineProperty(value, 'later', { value: true }); return Reflect.ownKeys(value); } })],
  ])('rejects %s Proxies before traps can escape', (_label, makeProxy) => {
    const value = context();
    value.input = makeProxy({ reviewer: 'reviewer' }) as Record<string, JsonValue>;
    expectBindingError(() => resolveBinding({ source: 'input', path: 'reviewer' }, value), 'unsafe-value');
  });

  it('rejects revoked Proxies without leaking their native exception', () => {
    const revoked = Proxy.revocable({ reviewer: 'reviewer' }, {});
    revoked.revoke();
    const value = context();
    value.input = revoked.proxy;
    expectBindingError(() => resolveBinding({ source: 'input', path: 'reviewer' }, value), 'unsafe-value');
  });

  it('keeps root Binding Proxies unsafe while classifying expected field accessors as invalid', () => {
    expectBindingError(() => resolveBinding(new Proxy({ source: 'input', path: 'reviewer' }, {}) as Binding, context()), 'unsafe-value');
    const revoked = Proxy.revocable({ source: 'input', path: 'reviewer' }, {});
    revoked.revoke();
    expectBindingError(() => resolveBinding(revoked.proxy as Binding, context()), 'unsafe-value');
    let calls = 0;
    const binding = { source: 'input' } as unknown as Binding;
    Object.defineProperty(binding, 'path', { enumerable: true, get() { calls += 1; return 'reviewer'; } });
    expectBindingError(() => resolveBinding(binding, context()), 'invalid-path');
    expect(calls).toBe(0);
  });

  it('classifies hostile malformed source, path, and nodeId fields as invalid without traps', () => {
    let traps = 0;
    const hostile = new Proxy({}, { ownKeys() { traps += 1; throw new Error('trap'); }, get() { traps += 1; throw new Error('trap'); } });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    class Box {}
    const malformed = [hostile, revoked.proxy, new String('reviewer'), [], {}, new Box()];
    for (const field of malformed) {
      expectBindingError(() => resolveBinding({ source: 'input', path: field } as unknown as Binding, context()), 'invalid-path');
      expectBindingError(() => resolveBinding({ source: field, path: 'reviewer' } as unknown as Binding, context()), 'invalid-path');
      expectBindingError(() => resolveBinding({ source: 'node', nodeId: field, path: 'text' } as unknown as Binding, context()), 'invalid-path');
    }
    expect(traps).toBe(0);
  });

  it('classifies extra or misplaced hostile descriptors as invalid without getters', () => {
    let calls = 0;
    for (const key of ['extra', 'value']) {
      const binding = { source: 'input', path: 'reviewer' } as unknown as Binding;
      Object.defineProperty(binding, key, { enumerable: true, get() { calls += 1; return new Proxy({}, {}); } });
      expectBindingError(() => resolveBinding(binding, context()), 'invalid-path');
    }
    expect(calls).toBe(0);
  });
});

describe('canonical value normalization', () => {
  it.each([
    ['class', new (class Unsafe { value = true; })()],
    ['Date', new Date()],
    ['Map', new Map()],
    ['array subclass', new (class UnsafeArray extends Array<unknown> {})(1)],
    ['nonfinite', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['function', () => true],
    ['bigint', 1n],
    ['symbol', Symbol('value')],
  ])('rejects unsafe %s final values', (_label, unsafe) => {
    const value = context();
    value.input = { unsafe } as unknown as Record<string, JsonValue>;
    expectBindingError(() => resolveBinding({ source: 'input', path: 'unsafe' }, value), 'unsafe-value');
    expectBindingError(() => resolveBinding({ source: 'fixed', value: unsafe as JsonValue }, value), 'unsafe-value');
  });

  it('maps an own undefined context value to missing-value while rejecting fixed undefined', () => {
    const value = context();
    value.input = { unsafe: undefined } as unknown as Record<string, JsonValue>;
    expectBindingError(() => resolveBinding({ source: 'input', path: 'unsafe' }, value), 'missing-value');
    expectBindingError(() => resolveBinding({ source: 'fixed', value: undefined as unknown as JsonValue }, value), 'unsafe-value');
  });

  it('rejects cycles, symbol keys, dangerous keys, and extra array properties', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const symbolKey = ownRecord(Symbol('unsafe'), true);
    const dangerousKey = ownRecord('constructor', true);
    const array: unknown[] & { extra?: boolean } = [1];
    array.extra = true;
    for (const unsafe of [cycle, symbolKey, dangerousKey, array]) {
      const value = context();
      value.input = { unsafe } as unknown as Record<string, JsonValue>;
      expectBindingError(() => resolveBinding({ source: 'input', path: 'unsafe' }, value), 'unsafe-value');
    }
  });

  it('keeps hostile fixed values in the deep unsafe-value boundary', () => {
    let calls = 0;
    const getter: Record<string, unknown> = {};
    Object.defineProperty(getter, 'value', { enumerable: true, get() { calls += 1; return true; } });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [new Proxy({}, {}), getter, cycle, new Date()]) {
      expectBindingError(() => resolveBinding({ source: 'fixed', value } as unknown as Binding, context()), 'unsafe-value');
    }
    expect(calls).toBe(0);
  });
});

describe('canonical array traversal', () => {
  it('rejects sparse arrays at context, source, intermediate, and final boundaries', () => {
    const sparse = Array(2) as unknown as Record<string, JsonValue>;
    expectBindingError(() => resolveBinding({ source: 'input', path: 'value' }, [] as unknown as WorkflowBindingContext), 'unsafe-value');
    for (const [source, path] of [['input', 'value'], ['trigger', 'kind'], ['run', 'id']] as const) {
      const value = context() as unknown as Record<string, unknown>;
      value[source] = sparse;
      expectBindingError(() => resolveBinding({ source, path }, value as unknown as WorkflowBindingContext), 'unsafe-value');
    }
    const nodes = context();
    nodes.nodes = sparse as unknown as WorkflowBindingContext['nodes'];
    expectBindingError(() => resolveBinding({ source: 'node', nodeId: 'plan', path: 'text' }, nodes), 'unsafe-value');
    const nested = context();
    nested.input = { nested: sparse } as unknown as Record<string, JsonValue>;
    expectBindingError(() => resolveBinding({ source: 'input', path: 'nested.value' }, nested), 'unsafe-value');
    expectBindingError(() => resolveBinding({ source: 'input', path: 'nested' }, nested), 'unsafe-value');
  });

  it('rejects exotic arrays without invoking accessors while cloning dense arrays', () => {
    class ArraySubclass extends Array<unknown> {}
    const extra: unknown[] & { extra?: boolean } = [1];
    extra.extra = true;
    const symbol = [1];
    Object.defineProperty(symbol, Symbol('unsafe'), { value: true, enumerable: true });
    const hidden = [1];
    Object.defineProperty(hidden, '0', { value: 1, enumerable: false });
    let calls = 0;
    const accessor = [1];
    Object.defineProperty(accessor, '0', { enumerable: true, get() { calls += 1; return 1; } });
    for (const array of [new ArraySubclass(1), extra, symbol, hidden, accessor]) {
      const value = context();
      value.input = { array } as unknown as Record<string, JsonValue>;
      expectBindingError(() => resolveBinding({ source: 'input', path: 'array' }, value), 'unsafe-value');
    }
    const dense = [1, { safe: true }];
    const value = context();
    value.input = { dense };
    const resolved = resolveBinding({ source: 'input', path: 'dense' }, value);
    expect(resolved).toEqual(dense);
    expect(resolved).not.toBe(dense);
    expect(calls).toBe(0);
  });

  it('returns canonical copies and never mutates or leaks live references', () => {
    const original = { nested: [{ value: 'before' }] };
    const binding = { source: 'input', path: 'data' } as const;
    const value = context();
    value.input = { data: original };
    const snapshot = structuredClone(value.input);
    const resolved = resolveBinding(binding, value) as { nested: Array<{ value: string }> };

    expect(resolved).toEqual(original);
    expect(resolved).not.toBe(original);
    expect(resolved.nested).not.toBe(original.nested);
    resolved.nested[0]!.value = 'after';
    expect(original.nested[0]!.value).toBe('before');
    expect(value.input).toEqual(snapshot);
    expect(binding).toEqual({ source: 'input', path: 'data' });
  });

  it('maps malformed binding shapes to invalid-path and never leaks Zod errors', () => {
    for (const binding of [null, {}, { source: 'unknown' }, { source: 'input' }, { source: 'input', path: 1 }]) {
      expectBindingError(() => resolveBinding(binding as Binding, context()), 'invalid-path');
    }
  });
});

describe('interpolateWorkflowPrompt', () => {
  it('interpolates every source with optional inner whitespace', () => {
    expect(interpolateWorkflowPrompt(
      'Review {{input.reviewer}} from {{ trigger.payload.repository }} in {{run.id}}: {{ node.plan.text }}',
      context(),
    )).toBe('Review reviewer from example/repository in run-1: Plan ready.');
  });

  it.each([
    ['{{ input.unicode }}', 'Здравей'],
    ['{{ input.count }}', '2'],
    ['{{ input.approved }}', 'true'],
    ['{{ input.empty }}', 'null'],
    ['{{ input.negativeZero }}', '0'],
  ])('renders the primitive placeholder %s explicitly', (template, expected) => {
    expect(interpolateWorkflowPrompt(template, context())).toBe(expected);
  });

  it('resolves repeated placeholders independently in one pass', () => {
    expect(interpolateWorkflowPrompt('{{ input.reviewer }} / {{ input.reviewer }}', context())).toBe('reviewer / reviewer');
    expect(interpolateWorkflowPrompt('{{ input.braces }}', context())).toBe('{{ trigger.kind }}');
  });

  it.each(['{{ input.list }}', '{{ input.record }}', '{{ node.plan.fields }}'])('rejects composite prompt value %s', (template) => {
    expectBindingError(() => interpolateWorkflowPrompt(template, context()), 'type-mismatch');
  });

  it.each([
    '{{ }}', '{{ unknown.value }}', '{{ fixed.value }}', '{{ node }}', '{{ node.plan }}',
    '{{ input.input.value }}', '{{ trigger.trigger.payload }}', '{{ run.run.id }}', '{{ node.plan.nodes.other }}',
    '{{ input.items[0] }}', '{{ input.call() }}', '{{ input.a+b }}',
    '{{ input.__proto__ }}', '{{ input.prototype }}', '{{ input.constructor }}',
    '{{{ input.reviewer }}}', '{{ input.{{ reviewer }} }}', '{{ input.reviewer }}}',
    '{{ input.reviewer ', 'input.reviewer }}', '{{ input.reviewer }} {{', '}}',
  ])('rejects malformed placeholder %s', (template) => {
    expectBindingError(() => interpolateWorkflowPrompt(template, context()), 'invalid-path');
  });

  it.each([
    ['input.input.x', '{{ input.input.x }}'], ['trigger.trigger.x', '{{ trigger.trigger.x }}'],
    ['run.run.x', '{{ run.run.x }}'], ['nodes.plan.x', '{{ node.plan.nodes.plan }}'],
  ])('rejects duplicated multi-segment root %s in direct and prompt paths', (path, prompt) => {
    expectBindingError(() => resolveBinding({ source: 'input', path } as Binding, context()), 'invalid-path');
    expectBindingError(() => interpolateWorkflowPrompt(prompt, context()), 'invalid-path');
  });

  it('returns plain text without double braces unchanged', () => {
    expect(interpolateWorkflowPrompt('Plain {text} stays unchanged.', context())).toBe('Plain {text} stays unchanged.');
  });

  it('aborts on an unresolved placeholder instead of returning a partial result', () => {
    expectBindingError(() => interpolateWorkflowPrompt('resolved {{ input.reviewer }}, missing {{ input.absent }}', context()), 'missing-value');
  });

  it('maps non-string templates to invalid-path', () => {
    expectBindingError(() => interpolateWorkflowPrompt({} as string, context()), 'invalid-path');
  });
});
