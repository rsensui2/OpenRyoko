import type { JsonValue } from './model.js';
import type { WorkflowRunTransaction } from './repository.js';
import {
  decodeApproval,
  jsonColumn,
  readAttempt,
  readNode,
  readRun,
  validateMutationValue,
} from './repository-runs.js';
import {
  assertExactKeys,
  canonicalJson,
  canonicalStamp,
  parseJsonRecord,
  parseNodeId,
  repositoryError,
} from './repository-support.js';
import {
  WORKFLOW_NODE_RUN_STATUSES,
  WORKFLOW_RUN_STATUSES,
  type WorkflowApprovalRecord,
  type WorkflowAttemptRecord,
  type WorkflowNodeRunRecord,
  type WorkflowRunRecord,
} from './runtime.js';

type WorkflowSqliteConnection = ConstructorParameters<typeof import('./repository.js').WorkflowRepository>[0];

function normalizedRecord(value: unknown, allowed: readonly string[], message: string): Record<string, JsonValue> {
  const record = parseJsonRecord(value, message);
  assertExactKeys(record, allowed, message);
  return record;
}

function recordChanged(before: object, after: object): boolean {
  return canonicalJson(before as JsonValue) !== canonicalJson(after as JsonValue);
}

function requireStatus<T extends string>(value: unknown, values: readonly T[], message: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) repositoryError('bad-input', message);
  return value as T;
}

function optionalInstant(record: Record<string, JsonValue>, key: string): void {
  if (Object.hasOwn(record, key)) canonicalStamp(record[key]);
}

export class RunMutation implements WorkflowRunTransaction {
  private didChange = false;
  private closed = false;

  constructor(
    private readonly db: WorkflowSqliteConnection,
    private readonly runId: string,
    private readonly stamp: string,
  ) {}

  get changed(): boolean {
    return this.didChange;
  }
  close(): void { this.closed = true; }
  private assertOpen(): void {
    if (this.closed) repositoryError('bad-input', 'Workflow run mutation is closed.');
  }

  setRunStatus(status: WorkflowRunRecord['status'], patch: Parameters<WorkflowRunTransaction['setRunStatus']>[1] = {}): WorkflowRunRecord {
    this.assertOpen();
    const nextStatus = requireStatus(status, WORKFLOW_RUN_STATUSES, 'Workflow run status is invalid.');
    const values = normalizedRecord(patch, ['cancelRequestedAt', 'endedAt', 'error'], 'Workflow run patch is invalid.');
    optionalInstant(values, 'cancelRequestedAt');
    optionalInstant(values, 'endedAt');
    if (values.error !== undefined) validateMutationValue('error', values.error);
    const current = readRun(this.db, this.runId);
    if (!current) repositoryError('not-found', `Workflow run ${this.runId} was not found.`);
    const next = { ...current, status: nextStatus, ...values } as WorkflowRunRecord;
    if (!recordChanged(current, next)) return current;
    this.db.prepare(`UPDATE workflow_runs SET status = @status, cancel_requested_at = @cancel,
      ended_at = @ended, error_json = @error WHERE id = @id`).run({
      id: this.runId, status: next.status, cancel: next.cancelRequestedAt ?? null,
      ended: next.endedAt ?? null, error: jsonColumn(next.error),
    });
    this.didChange = true;
    return readRun(this.db, this.runId)!;
  }

  setNodeStatus(
    nodeId: string,
    status: WorkflowNodeRunRecord['status'],
    patch: Parameters<WorkflowRunTransaction['setNodeStatus']>[2] = {},
  ): WorkflowNodeRunRecord {
    this.assertOpen();
    const id = parseNodeId(nodeId);
    const nextStatus = requireStatus(status, WORKFLOW_NODE_RUN_STATUSES, 'Workflow node status is invalid.');
    const keys = ['activated', 'resolvedConfig', 'input', 'output', 'error', 'resumeAt', 'startedAt', 'endedAt'];
    const values = normalizedRecord(patch, keys, 'Workflow node patch is invalid.');
    for (const key of ['resumeAt', 'startedAt', 'endedAt']) optionalInstant(values, key);
    if (Object.hasOwn(values, 'activated') && typeof values.activated !== 'boolean') {
      repositoryError('bad-input', 'Workflow node patch is invalid.');
    }
    if (values.resolvedConfig !== undefined) parseJsonRecord(values.resolvedConfig, 'Workflow node config is invalid.');
    if (values.output !== undefined) validateMutationValue('output', values.output);
    if (values.error !== undefined) validateMutationValue('error', values.error);
    const current = readNode(this.db, this.runId, id);
    if (!current) repositoryError('not-found', `Workflow node ${id} was not found.`);
    const next = { ...current, status: nextStatus, ...values } as WorkflowNodeRunRecord;
    if (!recordChanged(current, next)) return current;
    this.db.prepare(`UPDATE workflow_node_runs SET status = @status, activated = @activated,
      resolved_config_json = @config, input_json = @input, output_json = @output, error_json = @error,
      resume_at = @resume, started_at = @started, ended_at = @ended WHERE run_id = @runId AND node_id = @nodeId`).run({
      runId: this.runId, nodeId: id, status: next.status, activated: next.activated ? 1 : 0,
      config: jsonColumn(next.resolvedConfig), input: jsonColumn(next.input), output: jsonColumn(next.output),
      error: jsonColumn(next.error), resume: next.resumeAt ?? null, started: next.startedAt ?? null, ended: next.endedAt ?? null,
    });
    this.didChange = true;
    return readNode(this.db, this.runId, id)!;
  }

  createAttempt(input: Parameters<WorkflowRunTransaction['createAttempt']>[0]): WorkflowAttemptRecord {
    this.assertOpen();
    const value = normalizedRecord(input, ['nodeId', 'resolvedConfig', 'input', 'promptText', 'retryIdempotencyKey'], 'Workflow attempt input is invalid.');
    const nodeId = parseNodeId(value.nodeId);
    const retryKey = value.retryIdempotencyKey;
    if (retryKey !== undefined && (typeof retryKey !== 'string' || retryKey.length < 1 || retryKey.length > 128)) {
      repositoryError('bad-input', 'Workflow retry idempotency key is invalid.');
    }
    const promptText = value.promptText;
    if (promptText !== undefined && (typeof promptText !== 'string' || promptText.length < 1)) {
      repositoryError('bad-input', 'Workflow attempt prompt is invalid.');
    }
    validateMutationValue('resolved', value.resolvedConfig);
    const node = readNode(this.db, this.runId, nodeId);
    if (!node) repositoryError('not-found', `Workflow node ${nodeId} was not found.`);
    if (node.nodeType !== 'employee') repositoryError('bad-input', `Workflow node ${nodeId} cannot own attempts.`);
    const attempt = (this.db.prepare(`SELECT COALESCE(MAX(attempt), 0) + 1 FROM workflow_attempts
      WHERE run_id = ? AND node_id = ?`).pluck().get(this.runId, nodeId) as number);
    this.db.prepare(`INSERT INTO workflow_attempts
      (run_id, node_id, attempt, status, resolved_config_json, input_json, prompt_text, started_at, retry_idempotency_key)
      VALUES (?, ?, ?, 'dispatching', ?, ?, ?, ?, ?)`).run(
      this.runId, nodeId, attempt, canonicalJson(value.resolvedConfig!), canonicalJson(value.input!),
      promptText ?? null, this.stamp, retryKey,
    );
    this.didChange = true;
    return readAttempt(this.db, this.runId, nodeId, attempt)!;
  }
  settleAttempt(
    nodeId: string,
    attempt: number,
    patch: Parameters<WorkflowRunTransaction['settleAttempt']>[2],
  ): WorkflowAttemptRecord {
    this.assertOpen();
    const id = parseNodeId(nodeId);
    if (!Number.isInteger(attempt) || attempt < 1) repositoryError('bad-input', 'Workflow attempt number is invalid.');
    const value = normalizedRecord(patch, ['status', 'sessionId', 'output', 'error', 'endedAt'], 'Workflow attempt patch is invalid.');
    const status = requireStatus(value.status, ['running', 'completed', 'failed', 'timed-out', 'cancelled'], 'Workflow attempt status is invalid.');
    const expected = status === 'running' ? ['sessionId', 'status']
      : status === 'completed' ? ['endedAt', 'output', 'sessionId', 'status']
        : ['endedAt', 'error', 'sessionId', 'status'];
    const required = status === 'running' ? ['sessionId'] : status === 'completed' ? ['endedAt', 'output'] : ['endedAt', 'error'];
    if (Object.keys(value).some((key) => !expected.includes(key)) || required.some((key) => !Object.hasOwn(value, key))
      || (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || value.sessionId.length < 1 || value.sessionId.length > 256))) {
      repositoryError('bad-input', 'Workflow attempt patch is invalid.');
    }
    if (status !== 'running') optionalInstant(value, 'endedAt');
    if (value.output !== undefined) validateMutationValue('output', value.output);
    if (value.error !== undefined) validateMutationValue('error', value.error);
    const current = readAttempt(this.db, this.runId, id, attempt);
    if (!current) repositoryError('not-found', `Workflow attempt ${id}:${attempt} was not found.`);
    const next = { ...current, ...value } as WorkflowAttemptRecord;
    if (!recordChanged(current, next)) return current;
    if (current.sessionId && value.sessionId !== undefined && value.sessionId !== current.sessionId) {
      repositoryError('bad-input', 'Workflow attempt session does not match its owner.');
    }
    if (value.sessionId !== undefined && this.db.prepare(`SELECT 1 FROM workflow_attempts WHERE session_id=?
      AND NOT (run_id=? AND node_id=? AND attempt=?) LIMIT 1`).get(value.sessionId, this.runId, id, attempt)) {
      repositoryError('bad-input', 'Workflow attempt session is already owned.');
    }
    const legal = status === 'running' ? current.status === 'dispatching'
      : current.status === 'running' || (current.status === 'dispatching' && status !== 'completed' && value.sessionId === undefined);
    if (!legal) repositoryError('bad-input', 'Workflow attempt transition is invalid.');
    this.db.prepare(`UPDATE workflow_attempts SET session_id = @sessionId, status = @status,
      output_json = @output, error_json = @error, ended_at = @ended
      WHERE run_id = @runId AND node_id = @nodeId AND attempt = @attempt`).run({
      runId: this.runId, nodeId: id, attempt, sessionId: next.sessionId ?? null, status: next.status,
      output: jsonColumn(next.output), error: jsonColumn(next.error), ended: next.endedAt ?? null,
    });
    this.didChange = true;
    return readAttempt(this.db, this.runId, id, attempt)!;
  }
  setAttemptReminder(
    nodeId: string,
    attempt: number,
    patch: Parameters<WorkflowRunTransaction['setAttemptReminder']>[2],
  ): WorkflowAttemptRecord {
    this.assertOpen();
    const id = parseNodeId(nodeId);
    if (!Number.isInteger(attempt) || attempt < 1) repositoryError('bad-input', 'Workflow attempt number is invalid.');
    const keys = ['remindersSent', 'stopNudgesSent', 'nextReminderAt', 'extensions', 'lastExtensionReason', 'pendingOutputError', 'lastProcessedTurn'];
    const values = normalizedRecord(patch, keys, 'Workflow attempt reminder patch is invalid.');
    for (const key of ['remindersSent', 'stopNudgesSent', 'extensions', 'lastProcessedTurn'] as const) {
      if (values[key] !== undefined && (!Number.isInteger(values[key]) || (values[key] as number) < 0)) {
        repositoryError('bad-input', 'Workflow attempt reminder patch is invalid.');
      }
    }
    if (values.nextReminderAt !== undefined && values.nextReminderAt !== null) canonicalStamp(values.nextReminderAt);
    for (const key of ['lastExtensionReason', 'pendingOutputError'] as const) {
      if (values[key] !== undefined && values[key] !== null && typeof values[key] !== 'string') {
        repositoryError('bad-input', 'Workflow attempt reminder patch is invalid.');
      }
    }
    const current = readAttempt(this.db, this.runId, id, attempt);
    if (!current) repositoryError('not-found', `Workflow attempt ${id}:${attempt} was not found.`);
    if (current.status !== 'running') repositoryError('bad-input', 'Workflow attempt reminder state requires a running attempt.');
    const next = { ...current } as WorkflowAttemptRecord;
    if (values.remindersSent !== undefined) next.remindersSent = values.remindersSent as number;
    if (values.stopNudgesSent !== undefined) next.stopNudgesSent = values.stopNudgesSent as number;
    if (Object.hasOwn(values, 'nextReminderAt')) {
      if (values.nextReminderAt === null) delete next.nextReminderAt;
      else next.nextReminderAt = values.nextReminderAt as string;
    }
    if (values.extensions !== undefined) next.extensions = values.extensions as number;
    if (Object.hasOwn(values, 'lastExtensionReason')) {
      if (values.lastExtensionReason === null) delete next.lastExtensionReason;
      else next.lastExtensionReason = values.lastExtensionReason as string;
    }
    if (Object.hasOwn(values, 'pendingOutputError')) {
      if (values.pendingOutputError === null) delete next.pendingOutputError;
      else next.pendingOutputError = values.pendingOutputError as string;
    }
    if (values.lastProcessedTurn !== undefined) next.lastProcessedTurn = values.lastProcessedTurn as number;
    if (!recordChanged(current, next)) return current;
    this.db.prepare(`UPDATE workflow_attempts SET reminders_sent = @remindersSent,
      stop_nudges_sent = @stopNudgesSent,
      next_reminder_at = @nextReminderAt, extensions = @extensions,
      last_extension_reason = @lastExtensionReason, pending_output_error = @pendingOutputError,
      last_processed_turn = @lastProcessedTurn
      WHERE run_id = @runId AND node_id = @nodeId AND attempt = @attempt`).run({
      runId: this.runId,
      nodeId: id,
      attempt,
      remindersSent: next.remindersSent,
      stopNudgesSent: next.stopNudgesSent,
      nextReminderAt: next.nextReminderAt ?? null,
      extensions: next.extensions,
      lastExtensionReason: next.lastExtensionReason ?? null,
      pendingOutputError: next.pendingOutputError ?? null,
      lastProcessedTurn: next.lastProcessedTurn,
    });
    this.didChange = true;
    return readAttempt(this.db, this.runId, id, attempt)!;
  }
  putApproval(input: Omit<WorkflowApprovalRecord, 'runId'>): WorkflowApprovalRecord {
    this.assertOpen();
    const keys = ['nodeId', 'status', 'requestedAt', 'approverRef', 'decidedAt', 'decidedBy', 'decision', 'reason'];
    const value = normalizedRecord(input, keys, 'Workflow approval input is invalid.');
    const nodeId = parseNodeId(value.nodeId);
    const candidate = { runId: this.runId, nodeId, ...value } as WorkflowApprovalRecord;
    validateMutationValue('approval', candidate);
    if (!readNode(this.db, this.runId, nodeId)) repositoryError('not-found', `Workflow node ${nodeId} was not found.`);
    const row = this.db.prepare('SELECT * FROM workflow_approvals WHERE run_id = ? AND node_id = ?')
      .get(this.runId, nodeId) as Parameters<typeof decodeApproval>[0] | undefined;
    const current = row ? decodeApproval(row) : null;
    if (current && !recordChanged(current, candidate)) return current;
    this.db.prepare(`INSERT INTO workflow_approvals
      (run_id, node_id, status, requested_at, approver_ref, decided_at, decided_by, decision, reason)
      VALUES (@runId, @nodeId, @status, @requestedAt, @approverRef, @decidedAt, @decidedBy, @decision, @reason)
      ON CONFLICT(run_id, node_id) DO UPDATE SET status=excluded.status, requested_at=excluded.requested_at,
      approver_ref=excluded.approver_ref, decided_at=excluded.decided_at, decided_by=excluded.decided_by,
      decision=excluded.decision, reason=excluded.reason`).run({
      ...candidate, approverRef: candidate.approverRef ?? null, decidedAt: candidate.decidedAt ?? null,
      decidedBy: candidate.decidedBy ?? null, decision: candidate.decision ?? null, reason: candidate.reason ?? null,
    });
    this.didChange = true;
    return candidate;
  }
}
