import { isProxy } from 'node:util/types';
import { z } from 'zod';

/**
 * What counts as data inside a Workflow definition, a run input, or a node
 * output: plain JSON, with no accessors, no prototypes, no cycles, and no
 * `__proto__`. Every schema in `model.ts` is wrapped in `normalizedSchema`, so
 * this is the gate an untrusted definition passes through before any other rule
 * reads it. It sits beside `model.ts` rather than inside it so the node schemas
 * have room to grow.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const INVALID_INPUT = Symbol('invalid-workflow-input');

/** One dot-separated step of a binding path, an output field name, or an input
 *  key: an identifier that is safe to look up on a plain object. */
export const pathSegmentSchema = z.string()
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'Invalid path segment')
  .refine((segment) => !FORBIDDEN_PATH_SEGMENTS.has(segment), 'Unsafe path segment');

type OwnDescriptors = ReturnType<typeof Object.getOwnPropertyDescriptors>;

/** The array's own length, but only for an array whose keys are exactly the
 *  indexes `0..length-1` plus `length` — anything else is a hole, a getter, or
 *  a stray property, and none of those survive a round trip through JSON. */
function arrayLength(descriptors: OwnDescriptors): number | undefined {
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) return undefined;
  const descriptor = descriptors.length;
  if (!descriptor || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value)
    || descriptor.value < 0 || keys.length !== descriptor.value + 1) return undefined;
  return descriptor.value as number;
}

function normalizeArray(descriptors: OwnDescriptors, ancestors: WeakSet<object>): JsonValue | typeof INVALID_INPUT {
  const length = arrayLength(descriptors);
  if (length === undefined) return INVALID_INPUT;
  const normalized: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return INVALID_INPUT;
    const child = normalizeJson(descriptor.value, ancestors);
    if (child === INVALID_INPUT) return INVALID_INPUT;
    normalized.push(child);
  }
  return normalized;
}

function normalizeRecord(descriptors: OwnDescriptors, ancestors: WeakSet<object>): JsonValue | typeof INVALID_INPUT {
  const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || FORBIDDEN_PATH_SEGMENTS.has(key)) return INVALID_INPUT;
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return INVALID_INPUT;
    const child = normalizeJson(descriptor.value, ancestors);
    if (child === INVALID_INPUT) return INVALID_INPUT;
    Object.defineProperty(normalized, key, { value: child, enumerable: true, configurable: true, writable: true });
  }
  return normalized;
}

/** A container carrying nothing but its own kind: a plain array or a plain
 *  object. Anything with a class, a subclass, or a swapped prototype is refused
 *  rather than flattened, so a definition cannot smuggle behaviour in as data. */
function plainContainer(value: object, array: boolean): boolean {
  const prototype = Object.getPrototypeOf(value);
  return array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null;
}

/** Whatever this value is on its own, without descending: a JSON leaf, or not
 *  data at all. `undefined` means it is a container and the caller keeps going. */
function normalizeLeaf(value: unknown): JsonValue | typeof INVALID_INPUT | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_INPUT;
  return typeof value === 'object' ? undefined : INVALID_INPUT;
}

function normalizeJson(value: unknown, ancestors: WeakSet<object>): JsonValue | typeof INVALID_INPUT {
  const leaf = normalizeLeaf(value);
  if (leaf !== undefined) return leaf;
  const container = value as object;
  if (isProxy(container) || ancestors.has(container)) return INVALID_INPUT;
  const array = Array.isArray(container);
  if (!plainContainer(container, array)) return INVALID_INPUT;
  const descriptors = Object.getOwnPropertyDescriptors(container);
  ancestors.add(container);
  try {
    return array
      ? normalizeArray(descriptors, ancestors)
      : normalizeRecord(descriptors, ancestors);
  } finally {
    ancestors.delete(container);
  }
}

function normalizeInput(value: unknown): unknown {
  try {
    return normalizeJson(value, new WeakSet<object>());
  } catch {
    return INVALID_INPUT;
  }
}

export function normalizedSchema<T extends z.ZodType>(schema: T) {
  return z.preprocess(normalizeInput, schema);
}

export const jsonValueSchema = normalizedSchema(z.custom<JsonValue>(
  (value) => value !== INVALID_INPUT,
  { message: 'Value must be bounded, accessor-free JSON data' },
));
