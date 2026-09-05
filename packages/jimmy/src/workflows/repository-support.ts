import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { WorkflowValidationIssue } from './issues.js';
import { jsonValueSchema, nodeIdSchema, workflowIdSchema, type JsonValue } from './model.js';

export type WorkflowRepositoryErrorCode =
  | 'not-found'
  | 'id-conflict'
  | 'revision-conflict'
  | 'idempotency-conflict'
  | 'retired'
  | 'bad-cursor'
  | 'bad-input'
  | 'already-submitted'
  | 'corrupt-record';

export class WorkflowRepositoryError extends Error {
  readonly code: WorkflowRepositoryErrorCode;
  /** What exactly was wrong. Authoring a 20-node graph against a bare
   *  "definition is invalid" means bisecting it by hand, so every surface
   *  that can name a node, edge, or field path does. */
  readonly issues?: readonly WorkflowValidationIssue[];

  constructor(code: WorkflowRepositoryErrorCode, message: string, issues?: readonly WorkflowValidationIssue[]) {
    super(message);
    this.name = 'WorkflowRepositoryError';
    this.code = code;
    if (issues) this.issues = issues;
  }
}

export function repositoryError(code: WorkflowRepositoryErrorCode, message: string, issues?: readonly WorkflowValidationIssue[]): never {
  throw new WorkflowRepositoryError(code, message, issues);
}

export function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

export function canonicalStamp(value: unknown, stored = false): string {
  if (!isCanonicalInstant(value)) {
    repositoryError(stored ? 'corrupt-record' : 'bad-input', `Workflow repository ${stored ? 'record' : 'clock'} is invalid.`);
  }
  return value;
}

export function parseWorkflowId(value: unknown): string {
  if (typeof value !== 'string') repositoryError('bad-input', 'Workflow definition ID is invalid.');
  const parsed = workflowIdSchema.safeParse(value);
  if (!parsed.success) repositoryError('bad-input', 'Workflow definition ID is invalid.');
  return parsed.data;
}

export function parseNodeId(value: unknown): string {
  if (typeof value !== 'string') repositoryError('bad-input', 'Workflow node ID is invalid.');
  const parsed = nodeIdSchema.safeParse(value);
  if (!parsed.success) repositoryError('bad-input', 'Workflow node ID is invalid.');
  return parsed.data;
}

export function isRunId(value: unknown): value is string {
  return typeof value === 'string'
    && /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function parseRunId(value: unknown): string {
  if (!isRunId(value)) repositoryError('bad-input', 'Workflow run ID is invalid.');
  return value;
}

export function newRunId(): string {
  return `run_${randomUUID()}`;
}

export function parseExpectedRevision(subject: string, value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    repositoryError('revision-conflict', `${subject} revision does not match.`);
  }
  return value as number;
}

export function parseLimit(value: JsonValue | undefined, subject: string): number {
  const limit = value ?? 50;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    repositoryError('bad-input', `${subject} limit must be an integer from 1 through 100.`);
  }
  return limit;
}

export function parseBoundedString(value: JsonValue | undefined, label: string, max = 256): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > max) repositoryError('bad-input', `${label} is invalid.`);
  return value;
}

export function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (isProxy(value)) return true;
  for (let target: object | null = value; target; target = Object.getPrototypeOf(target) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(target, 'then');
    if (descriptor) return !Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function';
  }
  return false;
}

export function parseJsonRecord(value: unknown, message: string): Record<string, JsonValue> {
  if (unsafeJson(value)) repositoryError('bad-input', message);
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success || parsed.data === null || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    repositoryError('bad-input', message);
  }
  return parsed.data as Record<string, JsonValue>;
}

function unsafeJson(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (isProxy(value) || seen.has(value)) return true;
  seen.add(value);
  const unsafe = Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return !Object.hasOwn(descriptor, 'value') || unsafeJson(descriptor.value, seen);
  });
  seen.delete(value);
  return unsafe;
}

export function assertExactKeys(value: Record<string, JsonValue>, allowed: readonly string[], message: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) repositoryError('bad-input', message);
}

export function parseStoredJson(value: unknown, subject: string): JsonValue {
  if (typeof value !== 'string') repositoryError('corrupt-record', `${subject} contains invalid JSON.`);
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    repositoryError('corrupt-record', `${subject} contains invalid JSON.`);
  }
  const parsed = jsonValueSchema.safeParse(decoded);
  if (!parsed.success) repositoryError('corrupt-record', `${subject} contains invalid JSON.`);
  return parsed.data;
}

function canonicalValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => [key, canonicalValue(value[key]!)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalValue(value));
}

interface CursorSpec {
  endpoint: string;
  instantKey: 'updatedAt' | 'startedAt';
  validateId: (value: unknown) => string;
}

export function encodeCursor(spec: CursorSpec, instant: string, id: string): string {
  return Buffer.from(JSON.stringify({ version: 1, endpoint: spec.endpoint, [spec.instantKey]: instant, id }), 'utf8')
    .toString('base64url');
}

export function decodeCursor(value: unknown, spec: CursorSpec): { instant: string; id: string } {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    repositoryError('bad-cursor', 'Workflow cursor is malformed.');
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) repositoryError('bad-cursor', 'Workflow cursor is malformed.');
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch {
    repositoryError('bad-cursor', 'Workflow cursor is malformed.');
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    repositoryError('bad-cursor', 'Workflow cursor is malformed.');
  }
  const cursor = decoded as Record<string, unknown>;
  if (Object.keys(cursor).sort().join(',') !== `endpoint,id,${spec.instantKey},version`
    || cursor.version !== 1 || cursor.endpoint !== spec.endpoint || !isCanonicalInstant(cursor[spec.instantKey])) {
    repositoryError('bad-cursor', 'Workflow cursor is invalid.');
  }
  let id: string;
  try {
    id = spec.validateId(cursor.id);
  } catch {
    repositoryError('bad-cursor', 'Workflow cursor is invalid.');
  }
  const instant = cursor[spec.instantKey] as string;
  if (encodeCursor(spec, instant, id) !== value) repositoryError('bad-cursor', 'Workflow cursor is invalid.');
  return { instant, id };
}
