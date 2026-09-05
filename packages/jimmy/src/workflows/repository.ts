import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { isProxy } from 'node:util/types';
import {
  workflowDefinitionSchema,
  type JsonValue,
  type WorkflowDefinition,
  type WorkflowId,
  type WorkflowNodeOutput,
} from './model.js';
import { readContinuationAttempt, type ContinuationAttemptQuery } from './repository-continuation.js';
import { RunMutation } from './repository-run-transaction.js';
import { readMutexNodeRuns, type WorkflowMutexNodeRun } from './repository-mutex.js';
import {
  equivalentRun, insertRun, listRunSummaries, readAttempt, readAttemptByRetryKey, readAttemptBySession,
  readAttempts, readDueReminders, readDueWaits, readNextDueReminder, readNextDueTimeout, readNextDueWait, readRecoverableRuns,
  readRun, readRunByIdempotency, readRunsByCaller, readWorkflowCallByIdempotency, readRunDetail, type NormalizedRunListQuery,
} from './repository-runs.js';
import {
  WorkflowRepositoryError, assertExactKeys, canonicalStamp, decodeCursor, encodeCursor, isThenable, newRunId,
  parseBoundedString, parseExpectedRevision, parseJsonRecord, parseLimit, parseNodeId, parseRunId, parseStoredJson,
  parseWorkflowId, repositoryError,
} from './repository-support.js';
import {
  WORKFLOW_RUN_STATUSES,
  type ResolvedEmployeeConfig,
  type WorkflowApprovalRecord,
  type WorkflowAttemptRecord,
  type WorkflowChildRunSummary,
  type WorkflowError,
  type WorkflowNodeRunRecord,
  type WorkflowNodeRunStatus,
  type WorkflowRunDetail,
  type WorkflowRunRecord,
  type WorkflowRunStatus,
} from './runtime.js';

export { WorkflowRepositoryError };

export interface CreateWorkflowInput { id: string; title: string; description?: string }
export interface DefinitionListQuery { cursor?: string; limit?: number; enabled?: boolean; retired?: boolean }
export interface CursorPage<T> { items: T[]; nextCursor: string | null }
import type { WorkflowDefinitionSummary, WorkflowRunSummary } from './wire.js';
export type { WorkflowDefinitionSummary, WorkflowRunSummary };

export interface CreateRunInput {
  workflowId: string; input: Record<string, JsonValue>;
  trigger: {
    nodeId: string; kind: 'manual' | 'schedule' | 'event' | 'todo-status' | 'workflow-call';
    fireId?: string; payload: Record<string, JsonValue>;
  };
  idempotencyKey?: string; invocationSessionId?: string;
}

export interface RunListQuery {
  cursor?: string; limit?: number; status?: WorkflowRunStatus;
  triggerKind?: WorkflowRunRecord['trigger']['kind']; startedFrom?: string; startedTo?: string; text?: string;
}



export interface WorkflowRunTransaction {
  setRunStatus(status: WorkflowRunStatus, patch?: {
    cancelRequestedAt?: string; endedAt?: string; error?: WorkflowError;
  }): WorkflowRunRecord;
  setNodeStatus(nodeId: string, status: WorkflowNodeRunStatus, patch?: Partial<Pick<
    WorkflowNodeRunRecord,
    'activated' | 'resolvedConfig' | 'input' | 'output' | 'error' | 'resumeAt' | 'startedAt' | 'endedAt'
  >>): WorkflowNodeRunRecord;
  createAttempt(input: { nodeId: string; resolvedConfig: ResolvedEmployeeConfig; input: JsonValue;
    promptText?: string; retryIdempotencyKey?: string }): WorkflowAttemptRecord;
  settleAttempt(nodeId: string, attempt: number, patch:
    | { status: 'running'; sessionId: string }
    | { status: 'completed'; sessionId?: string; output: WorkflowNodeOutput; endedAt: string }
    | { status: 'failed' | 'timed-out' | 'cancelled'; sessionId?: string; error: WorkflowError; endedAt: string }
  ): WorkflowAttemptRecord;
  setAttemptReminder(nodeId: string, attempt: number, patch: {
    remindersSent?: number; stopNudgesSent?: number;
    nextReminderAt?: string | null;
    extensions?: number;
    lastExtensionReason?: string | null;
    pendingOutputError?: string | null;
    lastProcessedTurn?: number;
  }): WorkflowAttemptRecord;
  putApproval(input: Omit<WorkflowApprovalRecord, 'runId'>): WorkflowApprovalRecord;
}

interface DefinitionRow { id: string; title: string; revision: number; enabled: number; retired_at: string | null;
  definition_json: string; created_at: string; updated_at: string }
interface NormalizedDefinitionQuery {
  limit: number; cursor?: { updatedAt: string; id: string }; enabled?: boolean; retired?: boolean;
}

const DEFINITION_CURSOR = { endpoint: 'workflow-definitions', instantKey: 'updatedAt', validateId: parseWorkflowId } as const;
const RUN_CURSOR = { endpoint: 'workflow-runs', instantKey: 'startedAt', validateId: parseRunId } as const;
const TRIGGER_KINDS = ['manual', 'schedule', 'event', 'todo-status', 'workflow-call'] as const;
const VALIDATION_STAMP = '1970-01-01T00:00:00.000Z';
function parseInputDefinition(value: unknown): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    // The schema failure names the field; without it a large graph can only be
    // debugged by bisecting the JSON by hand.
    repositoryError('bad-input', 'Workflow definition is invalid.', parsed.error.issues.map((issue) => ({
      code: 'schema',
      message: issue.message,
      ...(issue.path.length > 0 ? { path: issue.path.join('.') } : {}),
    })));
  }
  return parsed.data;
}
function parseDefinitionInput(value: unknown, description: boolean): CreateWorkflowInput {
  const input = parseJsonRecord(value, 'Workflow definition input is invalid.');
  assertExactKeys(input, description ? ['id', 'title', 'description'] : ['id', 'title'], 'Workflow definition input is invalid.');
  if (typeof input.id !== 'string' || typeof input.title !== 'string'
    || (input.description !== undefined && typeof input.description !== 'string')) {
    repositoryError('bad-input', 'Workflow definition input is invalid.');
  }
  return { id: input.id, title: input.title, ...(input.description === undefined ? {} : { description: input.description }) };
}
function parseStoredDefinition(row: DefinitionRow): WorkflowDefinition {
  const parsed = workflowDefinitionSchema.safeParse(parseStoredJson(row.definition_json, `Workflow definition ${row.id}`));
  if (!parsed.success) repositoryError('corrupt-record', `Workflow definition ${row.id} is invalid.`);
  const value = parsed.data;
  if ((row.enabled !== 0 && row.enabled !== 1) || value.id !== row.id || value.title !== row.title
    || value.revision !== row.revision || value.enabled !== Boolean(row.enabled)
    || (value.retiredAt ?? null) !== row.retired_at || value.createdAt !== row.created_at || value.updatedAt !== row.updated_at) {
    repositoryError('corrupt-record', `Workflow definition ${row.id} metadata does not match its JSON.`);
  }
  return value;
}
function initialDefinition(input: CreateWorkflowInput, stamp: string): WorkflowDefinition {
  return parseInputDefinition({ schemaVersion: 1, ...input, revision: 1, enabled: false,
    nodes: [], edges: [], createdAt: stamp, updatedAt: stamp });
}
function editableDefinition(requested: WorkflowDefinition, current: WorkflowDefinition, stamp: string, revision: number): WorkflowDefinition {
  const { retiredAt: _retiredAt, ...authored } = requested;
  return parseInputDefinition({ ...authored, id: current.id, revision, enabled: current.enabled,
    ...(current.retiredAt === undefined ? {} : { retiredAt: current.retiredAt }),
    createdAt: current.createdAt, updatedAt: stamp });
}
/** True when a save moves only canvas positions (or nothing at all). Dragging a
 *  node is not an edit of the workflow, so charging it a revision would flood
 *  the history and invalidate every `expectedRevision` a caller is holding. */
function graphUnchanged(candidate: WorkflowDefinition, current: WorkflowDefinition): boolean {
  const graph = ({ ui: _ui, revision: _revision, updatedAt: _updatedAt, ...rest }: WorkflowDefinition) => rest;
  return isDeepStrictEqual(graph(candidate), graph(current));
}
function definitionSummary(value: WorkflowDefinition): WorkflowDefinitionSummary {
  return { id: value.id, title: value.title, description: value.description ?? null, revision: value.revision,
    enabled: value.enabled, retiredAt: value.retiredAt ?? null, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function parseDefinitionQuery(value: unknown): NormalizedDefinitionQuery {
  const query = parseJsonRecord(value, 'Workflow definition query is invalid.');
  assertExactKeys(query, ['cursor', 'enabled', 'limit', 'retired'], 'Workflow definition query is invalid.');
  if (query.enabled !== undefined && typeof query.enabled !== 'boolean') repositoryError('bad-input', 'Enabled filter must be boolean.');
  if (query.retired !== undefined && typeof query.retired !== 'boolean') repositoryError('bad-input', 'Retired filter must be boolean.');
  return { limit: parseLimit(query.limit, 'Workflow definition'),
    ...(query.cursor === undefined ? {} : { cursor: (() => { const cursor = decodeCursor(query.cursor, DEFINITION_CURSOR);
      return { updatedAt: cursor.instant, id: cursor.id }; })() }),
    ...(query.enabled === undefined ? {} : { enabled: query.enabled }),
    ...(query.retired === undefined ? {} : { retired: query.retired }) };
}
function parseCreateRun(value: unknown): CreateRunInput {
  const input = parseJsonRecord(value, 'Workflow run input is invalid.');
  assertExactKeys(input, ['workflowId', 'input', 'trigger', 'idempotencyKey', 'invocationSessionId'], 'Workflow run input is invalid.');
  const trigger = parseJsonRecord(input.trigger, 'Workflow run trigger is invalid.');
  assertExactKeys(trigger, ['nodeId', 'kind', 'fireId', 'payload', 'todoId'], 'Workflow run trigger is invalid.');
  if (typeof trigger.kind !== 'string' || !TRIGGER_KINDS.includes(trigger.kind as typeof TRIGGER_KINDS[number])) {
    repositoryError('bad-input', 'Workflow run trigger is invalid.');
  }
  return {
    workflowId: parseWorkflowId(input.workflowId), input: parseJsonRecord(input.input, 'Workflow run input is invalid.'),
    trigger: { nodeId: parseNodeId(trigger.nodeId), kind: trigger.kind as CreateRunInput['trigger']['kind'],
      ...(trigger.fireId === undefined ? {} : { fireId: parseBoundedString(trigger.fireId, 'Workflow trigger fire ID', 128)! }),
      ...(trigger.todoId === undefined ? {} : { todoId: parseBoundedString(trigger.todoId, 'Workflow trigger Todo ID', 64)! }),
      payload: parseJsonRecord(trigger.payload, 'Workflow trigger payload is invalid.') },
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: parseBoundedString(input.idempotencyKey,
      'Workflow idempotency key', trigger.kind === 'workflow-call' ? 128 : 256)! }),
    ...(input.invocationSessionId === undefined ? {} : { invocationSessionId: parseBoundedString(input.invocationSessionId, 'Workflow invocation session ID')! }),
  };
}

function parseRunQuery(value: unknown): NormalizedRunListQuery {
  const query = parseJsonRecord(value, 'Workflow run query is invalid.');
  assertExactKeys(query, ['cursor', 'limit', 'status', 'triggerKind', 'startedFrom', 'startedTo', 'text'], 'Workflow run query is invalid.');
  if (query.status !== undefined && (typeof query.status !== 'string' || !WORKFLOW_RUN_STATUSES.includes(query.status as WorkflowRunStatus))) {
    repositoryError('bad-input', 'Workflow run status filter is invalid.');
  }
  if (query.triggerKind !== undefined && (typeof query.triggerKind !== 'string'
    || !TRIGGER_KINDS.includes(query.triggerKind as typeof TRIGGER_KINDS[number]))) {
    repositoryError('bad-input', 'Workflow trigger filter is invalid.');
  }
  for (const key of ['startedFrom', 'startedTo'] as const) if (query[key] !== undefined) canonicalStamp(query[key]);
  if (typeof query.startedFrom === 'string' && typeof query.startedTo === 'string' && query.startedFrom > query.startedTo) {
    repositoryError('bad-input', 'Workflow run date range is invalid.');
  }
  if (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 120)) repositoryError('bad-input', 'Workflow run text filter is invalid.');
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor, RUN_CURSOR);
  return { limit: parseLimit(query.limit, 'Workflow run'), ...(cursor ? { cursor: { startedAt: cursor.instant, id: cursor.id } } : {}),
    ...(query.status === undefined ? {} : { status: query.status as string }),
    ...(query.triggerKind === undefined ? {} : { triggerKind: query.triggerKind as string }),
    ...(query.startedFrom === undefined ? {} : { startedFrom: query.startedFrom as string }),
    ...(query.startedTo === undefined ? {} : { startedTo: query.startedTo as string }),
    ...(query.text === undefined || query.text === '' ? {} : { text: query.text.toLowerCase() }) };
}

export class WorkflowRepository {
  private mutating = false;

  constructor(private readonly db: Database.Database, private readonly now: () => string = () => new Date().toISOString()) {}

  private transactionStamp(): string { return canonicalStamp(this.now()); }
  private row(id: string): DefinitionRow | undefined {
    return this.db.prepare('SELECT * FROM workflow_definitions WHERE id = ?').get(id) as DefinitionRow | undefined;
  }
  private requireDefinition(id: string): WorkflowDefinition {
    const row = this.row(id);
    if (!row) repositoryError('not-found', `Workflow definition ${id} was not found.`);
    return parseStoredDefinition(row);
  }
  private requireMutable(id: string, revision: number, mustBeRetired = false): WorkflowDefinition {
    const value = this.requireDefinition(id); if (value.revision !== revision) repositoryError('revision-conflict', `Workflow definition ${id} revision does not match.`);
    if (value.retiredAt !== undefined && !mustBeRetired) repositoryError('retired', `Workflow definition ${id} is retired.`);
    if (value.retiredAt === undefined && mustBeRetired) repositoryError('bad-input', `Workflow definition ${id} is not retired.`);
    return value;
  }
  private write(value: WorkflowDefinition, insert: boolean, expected = 0): void {
    const data = { id: value.id, title: value.title, revision: value.revision, enabled: value.enabled ? 1 : 0,
      retiredAt: value.retiredAt ?? null, json: JSON.stringify(value), createdAt: value.createdAt, updatedAt: value.updatedAt, expected };
    if (insert) this.db.prepare(`INSERT INTO workflow_definitions
      (id,title,revision,enabled,retired_at,definition_json,created_at,updated_at)
      VALUES (@id,@title,@revision,@enabled,@retiredAt,@json,@createdAt,@updatedAt)`).run(data);
    else if (this.db.prepare(`UPDATE workflow_definitions SET title=@title,revision=@revision,enabled=@enabled,
      retired_at=@retiredAt,definition_json=@json,updated_at=@updatedAt WHERE id=@id AND revision=@expected`).run(data).changes !== 1) {
      repositoryError('revision-conflict', `Workflow definition ${value.id} revision does not match.`);
    }
  }

  createDefinition(input: CreateWorkflowInput): WorkflowDefinition {
    const normalized = parseDefinitionInput(input, true);
    const value = initialDefinition(normalized, this.transactionStamp());
    return this.db.transaction(() => { if (this.row(value.id)) repositoryError('id-conflict', `Workflow definition ${value.id} already exists.`);
      this.write(value, true); return this.requireDefinition(value.id); }).immediate();
  }
  getDefinition(id: string): WorkflowDefinition | null { const row = this.row(parseWorkflowId(id)); return row ? parseStoredDefinition(row) : null; }
  listDefinitions(query: DefinitionListQuery): CursorPage<WorkflowDefinitionSummary> {
    const value = parseDefinitionQuery(query); const clauses = [value.retired ? 'retired_at IS NOT NULL' : 'retired_at IS NULL'];
    const data: Record<string, string | number> = { limit: value.limit + 1 };
    if (value.enabled !== undefined) { clauses.push('enabled=@enabled'); data.enabled = value.enabled ? 1 : 0; }
    if (value.cursor) { clauses.push('(updated_at<@at OR (updated_at=@at AND id<@id))'); data.at = value.cursor.updatedAt; data.id = value.cursor.id; }
    const values = (this.db.prepare(`SELECT * FROM workflow_definitions WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC,id DESC LIMIT @limit`).all(data) as DefinitionRow[]).map(parseStoredDefinition);
    const page = values.slice(0, value.limit); const last = page.at(-1);
    return { items: page.map(definitionSummary), nextCursor: values.length > value.limit && last
      ? encodeCursor(DEFINITION_CURSOR, last.updatedAt, last.id) : null };
  }
  saveDefinition(definition: WorkflowDefinition, expectedRevision: number): WorkflowDefinition {
    const requested = parseInputDefinition(definition); const revision = parseExpectedRevision(`Workflow definition ${requested.id}`, expectedRevision);
    const stamp = this.transactionStamp(); return this.db.transaction(() => { const current = this.requireMutable(requested.id, revision);
      const candidate = editableDefinition(requested, current, stamp, current.revision);
      const saved = graphUnchanged(candidate, current) ? candidate : { ...candidate, revision: current.revision + 1 };
      this.write(saved, false, revision); return this.requireDefinition(saved.id); }).immediate();
  }
  setEnabled(id: string, enabled: boolean, expectedRevision: number): WorkflowDefinition {
    const workflowId = parseWorkflowId(id); if (typeof enabled !== 'boolean') repositoryError('bad-input', 'Enabled state must be boolean.');
    const revision = parseExpectedRevision(`Workflow definition ${workflowId}`, expectedRevision); const stamp = this.transactionStamp();
    return this.db.transaction(() => { const current = this.requireMutable(workflowId, revision);
      const saved = parseInputDefinition({ ...current, revision: current.revision + 1, enabled, updatedAt: stamp });
      this.write(saved, false, revision); return this.requireDefinition(workflowId); }).immediate();
  }
  setRetired(id: string, retired: boolean, expectedRevision: number, at: string): WorkflowDefinition {
    const workflowId = parseWorkflowId(id); const revision = parseExpectedRevision(`Workflow definition ${workflowId}`, expectedRevision);
    if (typeof at !== 'string' || typeof retired !== 'boolean') repositoryError('bad-input', 'Workflow definition is invalid.'); const stamp = this.transactionStamp();
    return this.db.transaction(() => { const { retiredAt: _retiredAt, ...current } = this.requireMutable(workflowId, revision, !retired);
      const saved = parseInputDefinition({ ...current, revision: current.revision + 1, enabled: false, ...(retired ? { retiredAt: at } : {}), updatedAt: stamp });
      this.write(saved, false, revision); return this.requireDefinition(workflowId); }).immediate();
  }
  duplicateDefinition(id: WorkflowId, input: { id: WorkflowId; title: string }): WorkflowDefinition {
    const target = initialDefinition(parseDefinitionInput(input, false), VALIDATION_STAMP); const sourceId = parseWorkflowId(id);
    const stamp = this.transactionStamp(); return this.db.transaction(() => { const { retiredAt: _, ...source } = this.requireDefinition(sourceId);
      const copy = parseInputDefinition({ ...source, id: target.id, title: target.title, revision: 1, enabled: false, createdAt: stamp, updatedAt: stamp });
      if (this.row(copy.id)) repositoryError('id-conflict', `Workflow definition ${copy.id} already exists.`);
      this.write(copy, true); return this.requireDefinition(copy.id); }).immediate();
  }

  createRun(input: CreateRunInput, frozenDefinition?: WorkflowDefinition): WorkflowRunRecord {
    const value = parseCreateRun(input); const frozen = frozenDefinition ? parseInputDefinition(frozenDefinition) : undefined;
    if (frozen && frozen.id !== value.workflowId) repositoryError('bad-input', 'Workflow run definition is invalid.');
    const stamp = this.transactionStamp();
    return this.db.transaction(() => {
      const current = this.requireDefinition(value.workflowId); const definition = frozen ?? current;
      const replay = value.idempotencyKey ? (value.trigger.kind === 'workflow-call'
        ? readWorkflowCallByIdempotency(this.db, value.idempotencyKey)
        : readRunByIdempotency(this.db, value.workflowId, value.idempotencyKey)) : null;
      if (replay) {
        if (replay.workflowId === value.workflowId && replay.definitionRevision === definition.revision
          && equivalentRun(replay, value.input, value.trigger, value.invocationSessionId)) return replay;
        repositoryError('idempotency-conflict', 'Workflow idempotency key was reused with different input.');
      }
      const trigger = definition.nodes.find((node) => node.id === value.trigger.nodeId);
      if (!trigger || trigger.type !== 'trigger' || trigger.config.kind !== value.trigger.kind) repositoryError('bad-input', 'Workflow run trigger is invalid.');
      const run: WorkflowRunRecord = { id: newRunId(), workflowId: definition.id, workflowTitle: definition.title,
        definitionRevision: definition.revision, definition, input: value.input, trigger: value.trigger,
        status: 'pending', revision: 1, ...(value.idempotencyKey ? { idempotencyKey: value.idempotencyKey } : {}),
        ...(value.invocationSessionId ? { invocationSessionId: value.invocationSessionId } : {}), startedAt: stamp };
      insertRun(this.db, run); return readRun(this.db, run.id)!;
    }).immediate();
  }
  getRun(workflowId: string, runId: string): WorkflowRunDetail | null {
    return readRunDetail(this.db, parseWorkflowId(workflowId), parseRunId(runId));
  }
  listRuns(workflowId: string, query: RunListQuery): CursorPage<WorkflowRunSummary> {
    const id = parseWorkflowId(workflowId); const value = parseRunQuery(query);
    const rows = listRunSummaries(this.db, id, value); const page = rows.slice(0, value.limit); const last = page.at(-1);
    return { items: page, nextCursor: rows.length > value.limit && last ? encodeCursor(RUN_CURSOR, last.startedAt, last.id) : null };
  }
  findRunByIdempotency(workflowId: string, key: string): WorkflowRunRecord | null {
    const id = parseWorkflowId(workflowId); const parsed = parseBoundedString(key as unknown as JsonValue, 'Workflow idempotency key');
    return readRunByIdempotency(this.db, id, parsed!);
  }
  findWorkflowCallByIdempotency(input: { workflowId: string; input: Record<string, JsonValue>;
    caller: { workflowId: string; runId: string; nodeId: string }; itemIndex?: number;
    todoId?: string; idempotencyKey: string }): WorkflowRunRecord | null {
    const workflowId = parseWorkflowId(input.workflowId);
    const value = parseJsonRecord(input.input, 'Workflow run input is invalid.');
    const caller = parseJsonRecord(input.caller, 'Workflow caller identity is invalid.');
    const key = parseBoundedString(input.idempotencyKey, 'Workflow idempotency key', 128)!;
    const replay = readWorkflowCallByIdempotency(this.db, key);
    if (replay && (replay.workflowId !== workflowId || !equivalentRun(replay, value,
      { nodeId: replay.trigger.nodeId, kind: 'workflow-call', payload: {
        caller, ...(input.itemIndex === undefined ? {} : { itemIndex: input.itemIndex }),
      }, ...(input.todoId === undefined ? {} : { todoId: input.todoId }) }))) {
      repositoryError('idempotency-conflict', 'Workflow idempotency key was reused with different input.');
    }
    return replay;
  }
  mutateRun<T>(runId: string, expectedRevision: number, mutation: (tx: WorkflowRunTransaction) => T): T {
    const id = parseRunId(runId); const revision = parseExpectedRevision(`Workflow run ${id}`, expectedRevision);
    if (typeof mutation !== 'function' || isProxy(mutation)) repositoryError('bad-input', 'Workflow run mutation is invalid.');
    if (this.mutating) repositoryError('bad-input', 'Workflow run mutations cannot be nested.');
    const stamp = this.transactionStamp(); this.mutating = true;
    try {
      return this.db.transaction(() => { const run = readRun(this.db, id); if (!run) repositoryError('not-found', `Workflow run ${id} was not found.`);
        if (run.revision !== revision) repositoryError('revision-conflict', `Workflow run ${id} revision does not match.`);
        const tx = new RunMutation(this.db, id, stamp);
        try { const result = mutation(tx); if (isThenable(result)) repositoryError('bad-input', 'Workflow run mutation must be synchronous.');
          if (tx.changed && this.db.prepare('UPDATE workflow_runs SET revision=revision+1 WHERE id=? AND revision=?').run(id, revision).changes !== 1) {
            repositoryError('revision-conflict', `Workflow run ${id} revision does not match.`);
          }
          return result;
        } finally { tx.close(); }
      }).immediate();
    } finally { this.mutating = false; }
  }
  getAttempt(runId: string, nodeId: string, attempt: number): WorkflowAttemptRecord | null {
    const run = parseRunId(runId); const node = parseNodeId(nodeId);
    if (!Number.isInteger(attempt) || attempt < 1) repositoryError('bad-input', 'Workflow attempt number is invalid.');
    return readAttempt(this.db, run, node, attempt);
  }
  listAttempts(runId: string, nodeId: string): WorkflowAttemptRecord[] { return readAttempts(this.db, parseRunId(runId), parseNodeId(nodeId)); }
  listChildRuns(parentRunId: string, nodeId: string): WorkflowChildRunSummary[] { return readRunsByCaller(this.db, parseRunId(parentRunId), parseNodeId(nodeId)); }
  findAttemptBySessionId(sessionId: string): WorkflowAttemptRecord | null {
    return readAttemptBySession(this.db, parseBoundedString(sessionId as unknown as JsonValue, 'Workflow session ID')!);
  }
  findContinuationAttempt(query: ContinuationAttemptQuery): WorkflowAttemptRecord | null { return readContinuationAttempt(this.db, query); }
  findAttemptByRetryKey(runId: string, key: string): WorkflowAttemptRecord | null {
    return readAttemptByRetryKey(this.db, parseRunId(runId),
      parseBoundedString(key as unknown as JsonValue, 'Workflow retry idempotency key', 128)!);
  }
  listRecoverableRuns(): WorkflowRunRecord[] { return readRecoverableRuns(this.db); }
  listMutexNodeRuns(): WorkflowMutexNodeRun[] { return readMutexNodeRuns(this.db); }
  listDueWaits(now: string, limit: number): WorkflowNodeRunRecord[] {
    const stamp = canonicalStamp(now); const parsedLimit = parseLimit(limit as unknown as JsonValue, 'Workflow due wait');
    return readDueWaits(this.db, stamp, parsedLimit);
  }
  nextDueWait(): WorkflowNodeRunRecord | null { return readNextDueWait(this.db); }
  listDueReminders(now: string, limit: number): WorkflowAttemptRecord[] {
    const stamp = canonicalStamp(now); const parsedLimit = parseLimit(limit as unknown as JsonValue, 'Workflow due reminder');
    return readDueReminders(this.db, stamp, parsedLimit);
  }
  nextDueReminder(): { runId: string; nodeId: string; attempt: number; nextReminderAt: string } | null {
    return readNextDueReminder(this.db);
  }
  nextDueTimeout(): string | null { return readNextDueTimeout(this.db); }
}
