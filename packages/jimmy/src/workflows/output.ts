import { Buffer } from 'node:buffer';
import { isProxy } from 'node:util/types';
import { ATTACHMENT_REF_SHAPE, isAttachmentRef } from './attachment-ref.js';
import {
  jsonValueSchema,
  type JsonValue,
  type WorkflowNodeOutput,
  type WorkflowOutputSchema,
} from './model.js';
import type { WorkflowFanoutChildSummary } from './runtime.js';

type WorkflowOutputCode =
  | 'multiple-blocks'
  | 'invalid-json'
  | 'invalid-shape'
  | 'missing-field'
  | 'type-mismatch'
  | 'too-large';

type OutputField = WorkflowOutputSchema['fields'][string];

interface ParsedSchema {
  fields: Record<string, OutputField>;
  allowAdditionalFields: boolean;
}

interface FenceScan {
  openerCount: number;
  blockStart?: number;
  payloadStart?: number;
  payloadEnd?: number;
  blockEnd?: number;
}

const MAX_PAYLOAD_BYTES = 262_144;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'string[]', 'attachment', 'attachment[]']);
const FORBIDDEN_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);
const MESSAGES: Record<WorkflowOutputCode, string> = {
  'multiple-blocks': 'Employee output must contain at most one jinn-output block.',
  'invalid-json': 'Employee output block must contain valid JSON.',
  'invalid-shape': 'Employee output has an invalid shape.',
  'missing-field': 'Employee output is missing a required field.',
  'type-mismatch': 'Employee output field has the wrong type.',
  'too-large': 'Employee output block exceeds 262144 UTF-8 bytes.',
};

export class WorkflowOutputError extends Error {
  readonly code: WorkflowOutputCode;

  constructor(code: WorkflowOutputCode, message = MESSAGES[code]) {
    super(message);
    this.name = 'WorkflowOutputError';
    this.code = code;
  }
}

function fail(code: WorkflowOutputCode, message?: string): never {
  throw new WorkflowOutputError(code, message);
}

function matchesLine(text: string, start: number, end: number, marker: string): boolean {
  if (end - start < marker.length || text.slice(start, start + marker.length) !== marker) return false;
  for (let index = start + marker.length; index < end; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 9 && code !== 32) return false;
  }
  return true;
}

function scanFences(text: string): FenceScan {
  const scan: FenceScan = { openerCount: 0 };
  for (let start = 0; start <= text.length;) {
    const newline = text.indexOf('\n', start);
    const lineEnd = newline === -1 ? text.length : newline;
    const contentEnd = lineEnd > start && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    const next = newline === -1 ? text.length : newline + 1;
    if (matchesLine(text, start, contentEnd, '```jinn-output')) {
      scan.openerCount += 1;
      if (scan.openerCount === 1) {
        scan.blockStart = start;
        scan.payloadStart = next;
      }
    } else if (scan.openerCount >= 1 && scan.payloadEnd === undefined
      && matchesLine(text, start, contentEnd, '```')) {
      scan.payloadEnd = start;
      scan.blockEnd = next;
    }
    if (newline === -1) break;
    start = next;
  }
  return scan;
}

function readDataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== 'object' || isProxy(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      Object.defineProperty(record, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true });
    }
    return record;
  } catch {
    return undefined;
  }
}

function hasExactKeys(record: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(record);
  return required.every((key) => Object.hasOwn(record, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function parseSchema(value: unknown): ParsedSchema | undefined {
  const root = readDataRecord(value);
  if (!root || !hasExactKeys(root, ['fields', 'allowAdditionalFields'])
    || typeof root.allowAdditionalFields !== 'boolean') return undefined;
  const rawFields = readDataRecord(root.fields);
  if (!rawFields) return undefined;
  const fields = Object.create(null) as Record<string, OutputField>;
  for (const [name, value] of Object.entries(rawFields)) {
    if (!FIELD_NAME.test(name) || FORBIDDEN_FIELDS.has(name)) return undefined;
    const field = readDataRecord(value);
    if (!field || !hasExactKeys(field, ['type', 'required'], ['description'])
      || typeof field.type !== 'string' || !FIELD_TYPES.has(field.type)
      || typeof field.required !== 'boolean'
      || (Object.hasOwn(field, 'description') && typeof field.description !== 'string')) return undefined;
    Object.defineProperty(fields, name, { value: field as OutputField, enumerable: true, configurable: true, writable: true });
  }
  return { fields, allowAdditionalFields: root.allowAdditionalFields };
}

function emptyFields(): Record<string, JsonValue> {
  return Object.create(null) as Record<string, JsonValue>;
}

function normalizeFields(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid-shape');
  try {
    const result = jsonValueSchema.safeParse(value);
    if (!result.success || result.data === null || Array.isArray(result.data) || typeof result.data !== 'object') fail('invalid-shape');
    return result.data as Record<string, JsonValue>;
  } catch (error) {
    if (error instanceof WorkflowOutputError) throw error;
    return fail('invalid-shape');
  }
}

function matchesType(value: JsonValue, type: OutputField['type']): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'string[]': return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'attachment': return isAttachmentRef(value);
    case 'attachment[]': return Array.isArray(value) && value.every(isAttachmentRef);
  }
}

/** An attachment field fails for a reason the employee can act on: it submitted
 *  something that is not a ref, and a ref is not a filename it can invent. */
function typeMismatchMessage(name: string, type: OutputField['type']): string {
  const declared = `Output field "${name}" does not match declared type "${type}".`;
  return type === 'attachment' || type === 'attachment[]'
    ? `${declared} Attach the file to the Todo first, then submit the ref it returns: ${ATTACHMENT_REF_SHAPE}`
    : declared;
}

function validateFields(fields: Record<string, JsonValue>, schema: ParsedSchema): Record<string, JsonValue> {
  for (const [name, field] of Object.entries(schema.fields)) {
    if (field.required && !Object.hasOwn(fields, name)) {
      fail('missing-field', `Required output field "${name}" is missing.`);
    }
  }
  for (const [name, field] of Object.entries(schema.fields)) {
    if (Object.hasOwn(fields, name) && !matchesType(fields[name]!, field.type)) {
      fail('type-mismatch', typeMismatchMessage(name, field.type));
    }
  }
  if (!schema.allowAdditionalFields) {
    for (const name of Object.keys(fields)) {
      if (!Object.hasOwn(schema.fields, name)) fail('invalid-shape', `Output field "${name}" is not declared.`);
    }
  }
  if (schema.allowAdditionalFields) return fields;
  const selected = emptyFields();
  for (const name of Object.keys(schema.fields)) {
    if (Object.hasOwn(fields, name)) Object.defineProperty(selected, name, {
      value: fields[name], enumerable: true, configurable: true, writable: true,
    });
  }
  return selected;
}

export function validateSubmittedFields(
  fields: unknown,
  schema?: WorkflowOutputSchema,
): Record<string, JsonValue> {
  const normalized = fields === undefined ? emptyFields() : normalizeFields(fields);
  if (schema === undefined) return normalized;
  const parsedSchema = parseSchema(schema);
  if (!parsedSchema) fail('invalid-shape');
  return validateFields(normalized, parsedSchema);
}

export function parseWorkflowOutput(finalText: string, schema?: WorkflowOutputSchema): WorkflowNodeOutput {
  if (typeof finalText !== 'string') fail('invalid-shape');
  const scan = scanFences(finalText);
  if (scan.openerCount > 1) fail('multiple-blocks');
  if (scan.openerCount === 1 && scan.payloadEnd === undefined) fail('invalid-shape');
  let text = finalText;
  let fields = emptyFields();
  if (scan.openerCount === 1) {
    const payload = finalText.slice(scan.payloadStart!, scan.payloadEnd!);
    if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) fail('too-large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      fail('invalid-json');
    }
    fields = normalizeFields(parsed);
    text = finalText.slice(0, scan.blockStart) + finalText.slice(scan.blockEnd);
  }
  return { text, fields: validateSubmittedFields(fields, schema) };
}

/** The other way a node output comes to exist: a Workflow Call node joins its
 *  children into one, so a downstream Condition can route on the batch. */
export function fanoutOutput(children: readonly WorkflowFanoutChildSummary[]): WorkflowNodeOutput {
  const outcomes = children.map((child) => ({
    index: child.itemIndex,
    runId: child.runId,
    workflowId: child.workflowId,
    status: child.status === 'completed' ? 'succeeded' : child.status,
    fields: child.endOutput ?? {},
  }));
  const succeeded = outcomes.filter((outcome) => outcome.status === 'succeeded').length;
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
  const cancelled = outcomes.filter((outcome) => outcome.status === 'cancelled').length;
  const total = outcomes.length;
  const summary = total > 0 && succeeded === total ? 'all-succeeded' : succeeded > 0 ? 'partial' : 'none-succeeded';
  return { text: '', fields: { total, succeeded, failed, cancelled, summary, outcomes } };
}
