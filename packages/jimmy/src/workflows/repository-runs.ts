import { z } from 'zod';
import {
  jsonValueSchema,
  workflowDefinitionSchema,
  type JsonValue,
  type WorkflowNodeOutput,
} from './model.js';
import {
  WORKFLOW_ATTEMPT_STATUSES, WORKFLOW_NODE_RUN_STATUSES, WORKFLOW_RUN_STATUSES,
  type ResolvedEmployeeConfig, type WorkflowApprovalRecord, type WorkflowAttemptRecord, type WorkflowError,
  type WorkflowChildRunSummary, type WorkflowNodeRunRecord, type WorkflowRunDetail, type WorkflowRunRecord,
} from './runtime.js';
import { assertHistoryIntegrity } from './repository-integrity.js';
import { canonicalJson, isCanonicalInstant, isRunId, parseStoredJson, repositoryError } from './repository-support.js';
import type { WorkflowRunSummary } from './repository.js';
type WorkflowSqliteConnection = ConstructorParameters<typeof import('./repository.js').WorkflowRepository>[0];
const instantSchema = z.string().refine(isCanonicalInstant);
const errorSchema = z.strictObject({
  code: z.string(), message: z.string(), retryable: z.boolean(), nodeId: z.string().optional(),
  attempt: z.number().int().positive().optional(), details: z.record(z.string(), jsonValueSchema).optional(),
});
const outputSchema = z.strictObject({
  text: z.string(), fields: z.record(z.string(), jsonValueSchema), employeeId: z.string().optional(),
  engine: z.string().optional(), model: z.string().optional(), sessionId: z.string().optional(),
  choice: z.string().optional(),
});
const resolvedSchema = z.strictObject({
  employeeId: z.string(), engine: z.string(), model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  retry: z.strictObject({ attempts: z.number().int().min(1), delaySeconds: z.number().int().nonnegative(), backoff: z.enum(['fixed', 'exponential']) }),
  timeoutMinutes: z.number().int().positive().optional(), continuedFrom: z.strictObject({ sessionId: z.string(), engineSessionId: z.string() }).optional(), substitutedFrom: z.strictObject({ engine: z.string(), reason: z.string() }).optional(),
});
const triggerSchema = z.strictObject({
  nodeId: z.string(), kind: z.enum(['manual', 'schedule', 'event', 'todo-status', 'workflow-call']),
  fireId: z.string().optional(), payload: z.record(z.string(), jsonValueSchema), todoId: z.string().optional(),
});
const nodeRecordSchema = z.strictObject({
  runId: z.string(), nodeId: z.string(),
  nodeType: z.enum(['trigger', 'employee', 'workflow-call', 'condition', 'merge', 'approval', 'wait', 'end']),
  status: z.enum(WORKFLOW_NODE_RUN_STATUSES), activated: z.boolean(),
  resolvedConfig: z.record(z.string(), jsonValueSchema).optional(), input: jsonValueSchema.optional(),
  output: outputSchema.optional(), error: errorSchema.optional(), resumeAt: instantSchema.optional(),
  startedAt: instantSchema.optional(), endedAt: instantSchema.optional(),
});
const attemptRecordSchema = z.strictObject({
  runId: z.string(), nodeId: z.string(), attempt: z.number().int().positive(), sessionId: z.string().optional(),
  status: z.enum(WORKFLOW_ATTEMPT_STATUSES), resolvedConfig: resolvedSchema, input: jsonValueSchema,
  promptText: z.string().optional(),
  output: outputSchema.optional(), error: errorSchema.optional(), startedAt: instantSchema, endedAt: instantSchema.optional(),
  remindersSent: z.number().int().nonnegative(), stopNudgesSent: z.number().int().nonnegative(), nextReminderAt: instantSchema.optional(),
  extensions: z.number().int().nonnegative(), lastExtensionReason: z.string().optional(),
  pendingOutputError: z.string().optional(), lastProcessedTurn: z.number().int().nonnegative(),
});
const approvalRecordSchema = z.strictObject({
  runId: z.string(), nodeId: z.string(), status: z.enum(['pending', 'approved', 'rejected']),
  requestedAt: instantSchema, approverRef: z.string().optional(), decidedAt: instantSchema.optional(),
  decidedBy: z.string().optional(), decision: z.enum(['approve', 'reject']).optional(), reason: z.string().optional(),
}).superRefine((record, context) => {
  if (record.status === 'pending' && (record.decidedAt || record.decidedBy || record.decision || record.reason)) {
    context.addIssue({ code: 'custom', message: 'Pending approval has decision audit.' });
  }
  if (record.status !== 'pending' && (!record.decidedAt || !record.decidedBy
    || record.decision !== (record.status === 'approved' ? 'approve' : 'reject'))) {
    context.addIssue({ code: 'custom', message: 'Approval decision audit is incomplete.' });
  }
});
const mutationSchemas = { error: errorSchema, output: outputSchema, resolved: resolvedSchema, approval: approvalRecordSchema } as const;
export function validateMutationValue(kind: keyof typeof mutationSchemas, value: unknown): void {
  if (!mutationSchemas[kind].safeParse(value).success) repositoryError('bad-input', `Workflow ${kind} input is invalid.`);
}
export interface RunRow {
  id: unknown; workflow_id: unknown; workflow_title: unknown; definition_revision: unknown;
  definition_json: unknown; input_json: unknown; trigger_json: unknown; status: unknown; revision: unknown;
  idempotency_key: unknown; invocation_session_id: unknown; cancel_requested_at: unknown;
  started_at: unknown; ended_at: unknown; error_json: unknown;
}
interface NodeRow {
  run_id: unknown; node_id: unknown; node_type: unknown; status: unknown; activated: unknown;
  resolved_config_json: unknown; input_json: unknown; output_json: unknown; error_json: unknown;
  resume_at: unknown; started_at: unknown; ended_at: unknown;
}
export interface AttemptRow {
  run_id: unknown; node_id: unknown; attempt: unknown; session_id: unknown; status: unknown;
  resolved_config_json: unknown; input_json: unknown; output_json: unknown; error_json: unknown;
  started_at: unknown; ended_at: unknown; reminders_sent: unknown; stop_nudges_sent: unknown; next_reminder_at: unknown;
  extensions: unknown; last_extension_reason: unknown; pending_output_error: unknown; last_processed_turn: unknown;
  prompt_text: unknown;
}
interface ApprovalRow {
  run_id: unknown; node_id: unknown; status: unknown; requested_at: unknown; approver_ref: unknown;
  decided_at: unknown; decided_by: unknown; decision: unknown; reason: unknown;
}
export interface NormalizedRunListQuery {
  limit: number;
  cursor?: { startedAt: string; id: string };
  status?: string;
  triggerKind?: string;
  startedFrom?: string;
  startedTo?: string;
  text?: string;
}
function optionalJson(value: unknown, subject: string): JsonValue | undefined {
  return value === null ? undefined : parseStoredJson(value, subject);
}
function optionalString(value: unknown): string | undefined {
  return value === null ? undefined : typeof value === 'string' ? value : repositoryError('corrupt-record', 'Workflow record is invalid.');
}
function parsed<T>(schema: z.ZodType<T>, value: unknown, subject: string): T {
  const result = schema.safeParse(value);
  if (!result.success) repositoryError('corrupt-record', `${subject} is invalid.`);
  return result.data;
}
export function decodeRun(row: RunRow): WorkflowRunRecord {
  const definition = parsed(workflowDefinitionSchema, parseStoredJson(row.definition_json, 'Workflow run definition'), 'Workflow run definition');
  const input = parsed(z.record(z.string(), jsonValueSchema), parseStoredJson(row.input_json, 'Workflow run input'), 'Workflow run input');
  const trigger = parsed(triggerSchema, parseStoredJson(row.trigger_json, 'Workflow run trigger'), 'Workflow run trigger');
  const run = {
    id: row.id, workflowId: row.workflow_id, workflowTitle: row.workflow_title,
    definitionRevision: row.definition_revision, definition, input, trigger, status: row.status, revision: row.revision,
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    ...(row.invocation_session_id === null ? {} : { invocationSessionId: row.invocation_session_id }),
    ...(row.cancel_requested_at === null ? {} : { cancelRequestedAt: row.cancel_requested_at }),
    startedAt: row.started_at, ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.error_json === null ? {} : { error: optionalJson(row.error_json, 'Workflow run error') }),
  };
  const runSchema = z.strictObject({
    id: z.string().refine(isRunId), workflowId: z.string(), workflowTitle: z.string(),
    definitionRevision: z.number().int().positive(), definition: workflowDefinitionSchema,
    input: z.record(z.string(), jsonValueSchema), trigger: triggerSchema, status: z.enum(WORKFLOW_RUN_STATUSES),
    revision: z.number().int().positive(), idempotencyKey: z.string().optional(), invocationSessionId: z.string().optional(),
    cancelRequestedAt: instantSchema.optional(), startedAt: instantSchema, endedAt: instantSchema.optional(), error: errorSchema.optional(),
  });
  const decoded = parsed(runSchema, run, `Workflow run ${String(row.id)}`);
  if (decoded.workflowId !== definition.id || decoded.workflowTitle !== definition.title
    || decoded.definitionRevision !== definition.revision) {
    repositoryError('corrupt-record', `Workflow run ${decoded.id} metadata does not match its definition.`);
  }
  const triggerNode = definition.nodes.find((node) => node.id === decoded.trigger.nodeId);
  if (!triggerNode || triggerNode.type !== 'trigger' || triggerNode.config.kind !== decoded.trigger.kind) {
    repositoryError('corrupt-record', `Workflow run ${decoded.id} has an invalid trigger.`);
  }
  return decoded;
}
export function decodeNode(row: NodeRow): WorkflowNodeRunRecord {
  if (row.activated !== 0 && row.activated !== 1) {
    repositoryError('corrupt-record', `Workflow node ${String(row.node_id)} is invalid.`);
  }
  return parsed(nodeRecordSchema, {
    runId: row.run_id, nodeId: row.node_id, nodeType: row.node_type, status: row.status,
    activated: row.activated === 1,
    ...(row.resolved_config_json === null ? {} : { resolvedConfig: optionalJson(row.resolved_config_json, 'Workflow node config') }),
    ...(row.input_json === null ? {} : { input: optionalJson(row.input_json, 'Workflow node input') }),
    ...(row.output_json === null ? {} : { output: optionalJson(row.output_json, 'Workflow node output') }),
    ...(row.error_json === null ? {} : { error: optionalJson(row.error_json, 'Workflow node error') }),
    ...(row.resume_at === null ? {} : { resumeAt: row.resume_at }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  }, `Workflow node ${String(row.node_id)}`);
}
export function decodeAttempt(row: AttemptRow): WorkflowAttemptRecord {
  const record = parsed(attemptRecordSchema, {
    runId: row.run_id, nodeId: row.node_id, attempt: row.attempt,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }), status: row.status,
    resolvedConfig: parseStoredJson(row.resolved_config_json, 'Workflow attempt config'),
    input: parseStoredJson(row.input_json, 'Workflow attempt input'),
    ...(row.prompt_text === null ? {} : { promptText: row.prompt_text }),
    ...(row.output_json === null ? {} : { output: optionalJson(row.output_json, 'Workflow attempt output') }),
    ...(row.error_json === null ? {} : { error: optionalJson(row.error_json, 'Workflow attempt error') }),
    startedAt: row.started_at, ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    remindersSent: row.reminders_sent, stopNudgesSent: row.stop_nudges_sent,
    ...(row.next_reminder_at === null ? {} : { nextReminderAt: row.next_reminder_at }),
    extensions: row.extensions,
    ...(row.last_extension_reason === null ? {} : { lastExtensionReason: row.last_extension_reason }),
    ...(row.pending_output_error === null ? {} : { pendingOutputError: row.pending_output_error }),
    lastProcessedTurn: row.last_processed_turn,
  }, `Workflow attempt ${String(row.node_id)}:${String(row.attempt)}`);
  const terminal = ['completed', 'failed', 'timed-out', 'cancelled'].includes(record.status);
  if ((record.status === 'dispatching' && (record.sessionId || record.output || record.error || record.endedAt))
    || (record.status === 'running' && (!record.sessionId || record.output || record.error || record.endedAt))
    || (terminal && (!record.endedAt || (record.status === 'completed' ? !record.sessionId || !record.output || record.error : !record.error || record.output)))) {
    repositoryError('corrupt-record', `Workflow attempt ${String(row.node_id)}:${String(row.attempt)} is invalid.`);
  }
  return record;
}
export function decodeApproval(row: ApprovalRow): WorkflowApprovalRecord {
  return parsed(approvalRecordSchema, {
    runId: row.run_id, nodeId: row.node_id, status: row.status, requestedAt: row.requested_at,
    ...(row.approver_ref === null ? {} : { approverRef: optionalString(row.approver_ref) }),
    ...(row.decided_at === null ? {} : { decidedAt: optionalString(row.decided_at) }),
    ...(row.decided_by === null ? {} : { decidedBy: optionalString(row.decided_by) }),
    ...(row.decision === null ? {} : { decision: optionalString(row.decision) }),
    ...(row.reason === null ? {} : { reason: optionalString(row.reason) }),
  }, `Workflow approval ${String(row.node_id)}`);
}
export function readRun(db: WorkflowSqliteConnection, runId: string): WorkflowRunRecord | null {
  const row = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as RunRow | undefined;
  return row ? decodeRun(row) : null;
}
export function readNode(db: WorkflowSqliteConnection, runId: string, nodeId: string): WorkflowNodeRunRecord | null {
  const row = db.prepare('SELECT * FROM workflow_node_runs WHERE run_id = ? AND node_id = ?')
    .get(runId, nodeId) as NodeRow | undefined;
  return row ? decodeNode(row) : null;
}
export function readRunByIdempotency(db: WorkflowSqliteConnection, workflowId: string, key: string): WorkflowRunRecord | null {
  const row = db.prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? AND idempotency_key = ?')
    .get(workflowId, key) as RunRow | undefined;
  return row ? decodeRun(row) : null;
}
export function readWorkflowCallByIdempotency(db: WorkflowSqliteConnection, key: string): WorkflowRunRecord | null {
  const row = db.prepare("SELECT * FROM workflow_runs WHERE idempotency_key = ? AND json_extract(trigger_json, '$.kind') = 'workflow-call' ORDER BY started_at, id LIMIT 1")
    .get(key) as RunRow | undefined;
  return row ? decodeRun(row) : null;
}
export function equivalentRun(run: WorkflowRunRecord, input: Record<string, JsonValue>, trigger: WorkflowRunRecord['trigger'], invocation?: string): boolean {
  return canonicalJson(run.input) === canonicalJson(input) && canonicalJson(run.trigger) === canonicalJson(trigger)
    && run.invocationSessionId === invocation;
}
export function insertRun(db: WorkflowSqliteConnection, run: WorkflowRunRecord): void {
  db.prepare(`INSERT INTO workflow_runs
    (id, workflow_id, workflow_title, definition_revision, definition_json, input_json, trigger_json,
      status, revision, idempotency_key, invocation_session_id, cancel_requested_at, started_at, ended_at, error_json)
    VALUES (@id, @workflowId, @workflowTitle, @definitionRevision, @definition, @input, @trigger,
      @status, @revision, @idempotencyKey, @invocationSessionId, NULL, @startedAt, NULL, NULL)`).run({
    ...run, definition: JSON.stringify(run.definition), input: canonicalJson(run.input), trigger: canonicalJson(run.trigger),
    idempotencyKey: run.idempotencyKey ?? null, invocationSessionId: run.invocationSessionId ?? null,
  });
  const insert = db.prepare(`INSERT INTO workflow_node_runs
    (run_id, node_id, node_type, status, activated) VALUES (?, ?, ?, 'pending', 0)`);
  for (const node of run.definition.nodes) insert.run(run.id, node.id, node.type);
}
function orderedNodes(db: WorkflowSqliteConnection, run: WorkflowRunRecord): WorkflowNodeRunRecord[] {
  const rows = db.prepare('SELECT * FROM workflow_node_runs WHERE run_id = ?').all(run.id) as NodeRow[];
  const byId = new Map(rows.map((row) => {
    const node = decodeNode(row);
    return [node.nodeId, node];
  }));
  if (byId.size !== rows.length || rows.length !== run.definition.nodes.length) {
    repositoryError('corrupt-record', `Workflow run ${run.id} has invalid node rows.`);
  }
  return run.definition.nodes.map((node) => {
    const record = byId.get(node.id);
    if (!record || record.nodeType !== node.type) repositoryError('corrupt-record', `Workflow run ${run.id} has invalid node rows.`);
    return record;
  });
}
export function readRunDetail(db: WorkflowSqliteConnection, workflowId: string, runId: string): WorkflowRunDetail | null {
  const run = readRun(db, runId);
  if (!run || run.workflowId !== workflowId) return null;
  const nodeRuns = orderedNodes(db, run);
  const order = new Map(run.definition.nodes.map((node, index) => [node.id, index]));
  const attempts = (db.prepare('SELECT * FROM workflow_attempts WHERE run_id = ?').all(run.id) as AttemptRow[])
    .map(decodeAttempt).sort((a, b) => (order.get(a.nodeId)! - order.get(b.nodeId)!) || a.attempt - b.attempt);
  const approvals = (db.prepare('SELECT * FROM workflow_approvals WHERE run_id = ?').all(run.id) as ApprovalRow[])
    .map(decodeApproval).sort((a, b) => order.get(a.nodeId)! - order.get(b.nodeId)!);
  const sessions = attempts.flatMap((attempt) => attempt.sessionId ? [attempt.sessionId] : []);
  if (attempts.some((attempt) => !order.has(attempt.nodeId) || run.definition.nodes[order.get(attempt.nodeId)!]?.type !== 'employee')
    || approvals.some((approval) => !order.has(approval.nodeId) || run.definition.nodes[order.get(approval.nodeId)!]?.type !== 'approval')
    || sessions.length !== new Set(sessions).size) {
    repositoryError('corrupt-record', `Workflow run ${run.id} has foreign history rows.`);
  }
  const childRuns = run.definition.nodes
    .filter((node) => node.type === 'workflow-call' || node.type === 'employee')
    .flatMap((node) => readRunsByCaller(db, run.id, node.id));
  return { ...run, nodeRuns, attempts, approvals, childRuns };
}

const CHILD_SESSION = 'SELECT session_id FROM workflow_attempts WHERE run_id = ? AND session_id IS NOT NULL ORDER BY rowid DESC LIMIT 1';
export function readRunsByCaller(
  db: WorkflowSqliteConnection,
  parentRunId: string,
  nodeId: string,
): WorkflowChildRunSummary[] {
  let rows: RunRow[];
  try {
    // Only manual and workflow-call payloads are ours to write, so a `caller` under any other kind is the fire's own data.
    rows = db.prepare(`SELECT * FROM workflow_runs WHERE json_extract(trigger_json, '$.kind') IN ('manual', 'workflow-call')
        AND json_extract(trigger_json, '$.payload.caller.runId') = ? AND json_extract(trigger_json, '$.payload.caller.nodeId') = ?
      ORDER BY json_extract(trigger_json, '$.payload.itemIndex'), started_at, id`).all(parentRunId, nodeId) as RunRow[];
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      repositoryError('corrupt-record', `Workflow child runs for ${parentRunId}:${nodeId} contain invalid JSON.`);
    }
    throw error;
  }
  const seen = new Set<number>();
  return rows.map((row) => {
    const run = decodeRun(row);
    const itemIndex = run.trigger.payload.itemIndex;
    // An index means one item of a fan-out batch; a direct call and a session-started run are single spawns and carry none.
    if (itemIndex !== undefined && (!Number.isInteger(itemIndex) || (itemIndex as number) < 0 || seen.has(itemIndex as number))) {
      repositoryError('corrupt-record', `Workflow child runs for ${parentRunId}:${nodeId} have invalid item indexes.`);
    }
    if (itemIndex !== undefined) seen.add(itemIndex as number);
    const nodes = orderedNodes(db, run);
    const end = nodes.find((candidate) => candidate.nodeType === 'end' && candidate.status === 'completed');
    // The session this child ran in. Only a completed node writes it into its output, so a running or failed round reads it off its attempt row.
    const session = nodes.filter((candidate) => candidate.output?.sessionId).at(-1)?.output?.sessionId
      ?? (db.prepare(CHILD_SESSION).get(run.id) as { session_id: string } | undefined)?.session_id;
    return {
      runId: run.id,
      workflowId: run.workflowId,
      nodeId,
      ...(itemIndex === undefined ? {} : { itemIndex: itemIndex as number }),
      status: run.status,
      startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(end?.output ? { endOutput: end.output.fields } : {}),
      ...(session ? { sessionId: session } : {}),
      ...(run.error ? { error: run.error } : {}),
    };
  });
}
function summary(db: WorkflowSqliteConnection, run: WorkflowRunRecord): WorkflowRunSummary {
  const nodeRuns = orderedNodes(db, run);
  const failing = nodeRuns.find((node) => node.status === 'failed');
  const current = failing ?? nodeRuns.find((node) => ['ready', 'dispatching', 'running', 'waiting'].includes(node.status));
  const authored = current ? run.definition.nodes.find((node) => node.id === current.nodeId)! : undefined;
  const fixedEmployee = authored?.type === 'employee' && authored.config.employee.source === 'fixed'
    ? authored.config.employee.value : undefined;
  const employeeId = authored?.type === 'employee' ? current?.resolvedConfig?.employeeId : undefined;
  return {
    id: run.id, workflowId: run.workflowId, workflowTitle: run.workflowTitle,
    definitionRevision: run.definitionRevision, status: run.status,
    trigger: { nodeId: run.trigger.nodeId, kind: run.trigger.kind }, startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    currentOrFailingNode: current && authored ? {
      nodeId: current.nodeId, label: authored.name,
      employeeId: typeof employeeId === 'string' ? employeeId : fixedEmployee ?? null,
      state: failing ? 'failing' : 'current',
    } : null,
  };
}
export function listRunSummaries(db: WorkflowSqliteConnection, workflowId: string, query: NormalizedRunListQuery): WorkflowRunSummary[] {
  assertHistoryIntegrity(db, workflowId);
  const clauses = ['r.workflow_id = @workflowId'];
  const values: Record<string, string | number> = { workflowId, limit: query.limit + 1 };
  if (query.status) { clauses.push('r.status = @status'); values.status = query.status; }
  if (query.triggerKind) { clauses.push("json_extract(r.trigger_json, '$.kind') = @triggerKind"); values.triggerKind = query.triggerKind; }
  if (query.startedFrom) { clauses.push('r.started_at >= @startedFrom'); values.startedFrom = query.startedFrom; }
  if (query.startedTo) { clauses.push('r.started_at <= @startedTo'); values.startedTo = query.startedTo; }
  if (query.text) { clauses.push(`(instr(lower(r.workflow_title), @text)>0 OR instr(lower(r.id), @text)>0 OR EXISTS
    (SELECT 1 FROM workflow_node_runs n JOIN json_each(r.definition_json,'$.nodes') j ON j.value->>'$.id'=n.node_id
      WHERE n.run_id=r.id AND n.status IN ('ready','dispatching','running','waiting','failed') AND instr(lower(j.value->>'$.name'),@text)>0))`); values.text = query.text; }
  if (query.cursor) {
    clauses.push('(r.started_at < @cursorAt OR (r.started_at = @cursorAt AND r.id < @cursorId))');
    values.cursorAt = query.cursor.startedAt; values.cursorId = query.cursor.id;
  }
  let rows: RunRow[];
  try {
    rows = db.prepare(`SELECT r.* FROM workflow_runs r WHERE ${clauses.join(' AND ')}
      ORDER BY r.started_at DESC, r.id DESC LIMIT @limit`).all(values) as RunRow[];
  } catch (error) {
    if (error instanceof Error && /malformed JSON/i.test(error.message)) {
      repositoryError('corrupt-record', 'Workflow run trigger contains invalid JSON.');
    }
    throw error;
  }
  return rows.map(decodeRun).map((run) => summary(db, run));
}
export function readAttempt(db: WorkflowSqliteConnection, runId: string, nodeId: string, attempt: number): WorkflowAttemptRecord | null {
  const row = db.prepare('SELECT * FROM workflow_attempts WHERE run_id = ? AND node_id = ? AND attempt = ?')
    .get(runId, nodeId, attempt) as AttemptRow | undefined;
  return row ? decodeAttempt(row) : null;
}
export function readAttempts(db: WorkflowSqliteConnection, runId: string, nodeId: string): WorkflowAttemptRecord[] {
  return (db.prepare('SELECT * FROM workflow_attempts WHERE run_id = ? AND node_id = ? ORDER BY attempt')
    .all(runId, nodeId) as AttemptRow[]).map(decodeAttempt);
}
export function readAttemptBySession(db: WorkflowSqliteConnection, sessionId: string): WorkflowAttemptRecord | null {
  const rows = db.prepare('SELECT * FROM workflow_attempts WHERE session_id = ? LIMIT 2').all(sessionId) as AttemptRow[];
  if (rows.length > 1) repositoryError('corrupt-record', `Workflow session ${sessionId} owns multiple attempts.`);
  return rows[0] ? decodeAttempt(rows[0]) : null;
}
export function readAttemptByRetryKey(db: WorkflowSqliteConnection, runId: string, key: string): WorkflowAttemptRecord | null {
  const rows = db.prepare('SELECT * FROM workflow_attempts WHERE run_id = ? AND retry_idempotency_key = ? LIMIT 2')
    .all(runId, key) as AttemptRow[];
  if (rows.length > 1) repositoryError('corrupt-record', `Workflow retry key ${key} owns multiple attempts.`);
  return rows[0] ? decodeAttempt(rows[0]) : null;
}

export function readDueReminders(db: WorkflowSqliteConnection, now: string, limit: number): WorkflowAttemptRecord[] {
  return (db.prepare(`SELECT * FROM workflow_attempts WHERE status = 'running' AND next_reminder_at <= ?
    ORDER BY next_reminder_at, run_id, node_id, attempt LIMIT ?`).all(now, limit) as AttemptRow[]).map(decodeAttempt);
}

export function readNextDueReminder(db: WorkflowSqliteConnection): {
  runId: string; nodeId: string; attempt: number; nextReminderAt: string;
} | null {
  const row = db.prepare(`SELECT * FROM workflow_attempts WHERE status = 'running' AND next_reminder_at IS NOT NULL
    ORDER BY next_reminder_at, run_id, node_id, attempt LIMIT 1`).get() as AttemptRow | undefined;
  if (!row) return null;
  const attempt = decodeAttempt(row);
  return {
    runId: attempt.runId,
    nodeId: attempt.nodeId,
    attempt: attempt.attempt,
    nextReminderAt: attempt.nextReminderAt!,
  };
}

export function readNextDueTimeout(db: WorkflowSqliteConnection): string | null {
  const row = db.prepare(`SELECT * FROM workflow_attempts
    WHERE status = 'running' AND json_extract(resolved_config_json, '$.timeoutMinutes') IS NOT NULL
    ORDER BY julianday(started_at) + json_extract(resolved_config_json, '$.timeoutMinutes') / 1440.0,
      run_id, node_id, attempt LIMIT 1`).get() as AttemptRow | undefined;
  if (!row) return null;
  const attempt = decodeAttempt(row);
  const timeoutMinutes = attempt.resolvedConfig.timeoutMinutes;
  if (timeoutMinutes === undefined) repositoryError('corrupt-record', 'Workflow attempt timeout is invalid.');
  return new Date(Date.parse(attempt.startedAt) + timeoutMinutes * 60_000).toISOString();
}

export function readRecoverableRuns(db: WorkflowSqliteConnection): WorkflowRunRecord[] {
  return (db.prepare("SELECT * FROM workflow_runs WHERE status IN ('pending','running','waiting') ORDER BY started_at, id")
    .all() as RunRow[]).map(decodeRun);
}

export function readDueWaits(db: WorkflowSqliteConnection, now: string, limit: number): WorkflowNodeRunRecord[] {
  return (db.prepare(`SELECT * FROM workflow_node_runs WHERE status = 'waiting' AND resume_at <= ?
    ORDER BY resume_at, run_id, node_id LIMIT ?`).all(now, limit) as NodeRow[]).map(decodeNode);
}

export function readNextDueWait(db: WorkflowSqliteConnection): WorkflowNodeRunRecord | null {
  const row = db.prepare(`SELECT * FROM workflow_node_runs WHERE status = 'waiting' AND resume_at IS NOT NULL
    ORDER BY resume_at, run_id, node_id LIMIT 1`).get() as NodeRow | undefined;
  return row ? decodeNode(row) : null;
}

export function jsonColumn(value: JsonValue | WorkflowNodeOutput | WorkflowError | ResolvedEmployeeConfig | undefined): string | null {
  return value === undefined ? null : canonicalJson(value as JsonValue);
}
