import { isProxy } from 'node:util/types';
import { bindingSchema, jsonValueSchema } from './model.js';
import type { Binding, JsonValue, WorkflowNodeOutput } from './model.js';
import type { WorkflowError } from './runtime.js';

export interface WorkflowBindingContext {
  input: Record<string, JsonValue>;
  /** `item`/`itemIndex` are set for a fan-out child and `round`/`maxRounds` for
   *  an iteration round, both only while a Workflow Call maps its target's
   *  inputs — which is where a round gets told which one it is. */
  trigger: { kind: string; payload: Record<string, JsonValue>; item?: JsonValue; itemIndex?: number;
    round?: number; maxRounds?: number };
  nodes: Record<string, { status: string; output: WorkflowNodeOutput | null; error: WorkflowError | null }>;
  run: { id: string; startedAt: string; todoId?: string };
}

type WorkflowBindingErrorCode = 'invalid-path' | 'missing-value' | 'type-mismatch' | 'unsafe-value';

export class WorkflowBindingError extends Error {
  readonly code: 'invalid-path' | 'missing-value' | 'type-mismatch' | 'unsafe-value';

  constructor(code: WorkflowBindingErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'WorkflowBindingError';
    this.code = code;
  }
}

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const SOURCE_ROOTS = new Set(['input', 'trigger', 'run', 'nodes']);

function fail(code: WorkflowBindingErrorCode, message: string): never {
  throw new WorkflowBindingError(code, message);
}

export function validateBindingPath(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > 256) {
    fail('invalid-path', 'Binding path must contain 1 to 256 characters');
  }
  const segments = path.split('.');
  if (segments.length > 16 || (segments.length > 1 && SOURCE_ROOTS.has(segments[0]!))) {
    fail('invalid-path', 'Binding path must be relative and contain at most 16 segments');
  }
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || DANGEROUS.has(segment)) {
      fail('invalid-path', 'Binding path contains an invalid segment');
    }
  }
  return [...segments];
}

type Descriptors = ReturnType<typeof Object.getOwnPropertyDescriptors>;

function safeDescriptors(value: unknown, allowDangerous = false): { descriptors: Descriptors; array: boolean } {
  if (value === null || typeof value !== 'object') fail('missing-value', 'Binding path does not exist');
  if (isProxy(value)) fail('unsafe-value', 'Proxy containers are not allowed');
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      fail('unsafe-value', 'Only plain JSON containers are allowed');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') fail('unsafe-value', 'Container has unsafe properties');
      const descriptor = descriptors[key]!;
      if ((!allowDangerous && DANGEROUS.has(key)) || !Object.hasOwn(descriptor, 'value')) {
        fail('unsafe-value', 'Container has unsafe properties');
      }
      const arrayLength = array && key === 'length';
      if (!arrayLength && !descriptor.enumerable) fail('unsafe-value', 'Container has hidden properties');
      if (array && !arrayLength && !/^(0|[1-9][0-9]*)$/.test(key)) {
        fail('unsafe-value', 'Array has non-index properties');
      }
    }
    if (array && !jsonValueSchema.safeParse(value).success) {
      fail('unsafe-value', 'Array is not canonical JSON');
    }
    return { descriptors, array };
  } catch (error) {
    if (error instanceof WorkflowBindingError) throw error;
    fail('unsafe-value', 'Container inspection failed');
  }
}

function requireRecord(value: unknown, allowDangerous = false): object {
  if (value === null || typeof value !== 'object') fail('unsafe-value', 'Binding source must be a record');
  const inspected = safeDescriptors(value, allowDangerous);
  if (inspected.array) fail('unsafe-value', 'Binding source must be a record');
  return value;
}

function readOwn(value: unknown, key: string, allowDangerous = false): unknown {
  const inspected = safeDescriptors(value, allowDangerous);
  if (inspected.array) fail('missing-value', 'Binding path does not exist');
  const descriptor = inspected.descriptors[key];
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value === undefined) {
    fail('missing-value', 'Binding path does not exist');
  }
  return descriptor.value;
}

function normalizeValue(value: unknown): JsonValue {
  try {
    const result = jsonValueSchema.safeParse(value);
    if (!result.success) fail('unsafe-value', 'Resolved value is not safe JSON');
    return result.data;
  } catch (error) {
    if (error instanceof WorkflowBindingError) throw error;
    fail('unsafe-value', 'Resolved value inspection failed');
  }
}

function normalizeBinding(binding: unknown): Binding {
  classifyBindingEnvelope(binding);
  const normalized = normalizeValue(binding);
  try {
    const result = bindingSchema.safeParse(normalized);
    if (!result.success) fail('invalid-path', 'Binding has an invalid shape');
    return result.data as Binding;
  } catch (error) {
    if (error instanceof WorkflowBindingError) throw error;
    fail('unsafe-value', 'Binding inspection failed');
  }
}

function classifyBindingEnvelope(binding: unknown): void {
  if (binding === null || typeof binding !== 'object') fail('invalid-path', 'Binding has an invalid shape');
  if (isProxy(binding)) fail('unsafe-value', 'Proxy bindings are not allowed');
  let descriptors: Descriptors;
  try {
    const prototype = Object.getPrototypeOf(binding);
    if (prototype !== Object.prototype && prototype !== null) fail('invalid-path', 'Binding has an invalid shape');
    descriptors = Object.getOwnPropertyDescriptors(binding);
  } catch (error) {
    if (error instanceof WorkflowBindingError) throw error;
    fail('unsafe-value', 'Binding inspection failed');
  }
  const sourceDescriptor = descriptors.source;
  if (!sourceDescriptor || !sourceDescriptor.enumerable || !Object.hasOwn(sourceDescriptor, 'value')
    || typeof sourceDescriptor.value !== 'string') fail('invalid-path', 'Binding source is invalid');
  const source = sourceDescriptor.value;
  const expected = source === 'fixed' ? ['source', 'value']
    : source === 'node' ? ['source', 'nodeId', 'path']
      : source === 'input' || source === 'trigger' || source === 'run' ? ['source', 'path'] : null;
  const keys = Reflect.ownKeys(descriptors);
  if (!expected || keys.length !== expected.length
    || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    fail('invalid-path', 'Binding has invalid fields');
  }
  if (source === 'fixed') return;
  const pathDescriptor = descriptors.path;
  if (!pathDescriptor || !pathDescriptor.enumerable || !Object.hasOwn(pathDescriptor, 'value')
    || typeof pathDescriptor.value !== 'string') fail('invalid-path', 'Binding path is invalid');
  validateBindingPath(pathDescriptor.value);
  if (source === 'node') {
    const nodeDescriptor = descriptors.nodeId;
    if (!nodeDescriptor || !nodeDescriptor.enumerable || !Object.hasOwn(nodeDescriptor, 'value')
      || typeof nodeDescriptor.value !== 'string') fail('invalid-path', 'Node identifier is invalid');
  }
}

function traverse(root: unknown, segments: string[]): JsonValue {
  const ancestors = new WeakSet<object>();
  let current = root;
  for (const segment of segments) {
    if (current !== null && typeof current === 'object') {
      if (ancestors.has(current)) fail('unsafe-value', 'Binding path contains a cycle');
      ancestors.add(current);
    }
    current = readOwn(current, segment);
  }
  return normalizeValue(current);
}

function bindingRoot(binding: Exclude<Binding, { source: 'fixed' }>, context: WorkflowBindingContext): unknown {
  const safeContext = requireRecord(context);
  if (binding.source === 'input') return requireRecord(readOwn(safeContext, 'input'));
  if (binding.source === 'trigger') return requireRecord(readOwn(safeContext, 'trigger'));
  if (binding.source === 'run') return requireRecord(readOwn(safeContext, 'run'));
  const nodes = requireRecord(readOwn(safeContext, 'nodes'), true);
  const node = requireRecord(readOwn(nodes, binding.nodeId, true));
  const output = readOwn(node, 'output');
  if (output === null) fail('missing-value', 'Node output is not available');
  return requireRecord(output);
}

function resolveBindingInner<T extends JsonValue>(input: Binding<T>, context: WorkflowBindingContext): T {
  const binding = normalizeBinding(input) as Binding<T>;
  if (binding.source === 'fixed') return normalizeValue(binding.value) as T;
  const segments = validateBindingPath(binding.path);
  return traverse(bindingRoot(binding, context), segments) as T;
}

export function resolveBinding<T extends JsonValue>(binding: Binding<T>, context: WorkflowBindingContext): T {
  try {
    return resolveBindingInner(binding, context);
  } catch (error) {
    if (error instanceof WorkflowBindingError) throw error;
    fail('unsafe-value', 'Binding resolution failed');
  }
}

function renderPrimitive(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : `${value}`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return fail('type-mismatch', 'Prompt placeholders require primitive values');
}

function resolvePlaceholder(expression: string, context: WorkflowBindingContext): string {
  const parts = expression.split('.');
  const source = parts[0];
  if (source === 'input' || source === 'trigger' || source === 'run') {
    const path = parts.slice(1).join('.');
    validateBindingPath(path);
    return renderPrimitive(resolveBinding({ source, path }, context));
  }
  if (source === 'node' && parts.length >= 3) {
    const nodeId = parts[1]!;
    const path = parts.slice(2).join('.');
    validateBindingPath(path);
    return renderPrimitive(resolveBinding({ source, nodeId, path }, context));
  }
  return fail('invalid-path', 'Prompt placeholder has an invalid source or path');
}

function interpolateInner(template: string, context: WorkflowBindingContext): string {
  let cursor = 0;
  let output = '';
  while (cursor < template.length) {
    const open = template.indexOf('{{', cursor);
    const unmatchedClose = template.indexOf('}}', cursor);
    if (unmatchedClose !== -1 && (open === -1 || unmatchedClose < open)) {
      fail('invalid-path', 'Prompt contains an unmatched closing delimiter');
    }
    if (open === -1) return output + template.slice(cursor);
    const close = template.indexOf('}}', open + 2);
    if (close === -1 || template[close + 2] === '}') fail('invalid-path', 'Prompt contains a malformed placeholder');
    const raw = template.slice(open + 2, close);
    if (raw.includes('{') || raw.includes('}')) fail('invalid-path', 'Nested placeholders are not allowed');
    const expression = raw.trim();
    if (expression.length === 0) fail('invalid-path', 'Prompt placeholder cannot be empty');
    output += template.slice(cursor, open) + resolvePlaceholder(expression, context);
    cursor = close + 2;
  }
  return output;
}

export function interpolateWorkflowPrompt(template: string, context: WorkflowBindingContext): string {
  if (typeof template !== 'string') fail('invalid-path', 'Prompt template must be a string');
  try {
    return interpolateInner(template, context);
  } catch (error) {
    if (error instanceof WorkflowBindingError) throw error;
    fail('unsafe-value', 'Prompt interpolation failed');
  }
}
