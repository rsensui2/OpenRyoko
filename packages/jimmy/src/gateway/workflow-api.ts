import type { IncomingMessage, ServerResponse } from "node:http";
import { WorkflowRepositoryError, WorkflowServiceError, type WorkflowService } from "../workflows/service.js";
import { CALLER_SESSION_HEADER } from "../mcp/identity.js";
import { logger } from "../shared/logger.js";
import { getSession } from "../sessions/registry.js";
import type { DefinitionListQuery, RunListQuery } from "../workflows/repository.js";
import type { WorkflowAttemptWire, WorkflowRunDetail, WorkflowRunDetailWire, WorkflowRunLeanWire } from "../workflows/wire.js";
import { WorkflowOutputError } from "../workflows/output.js";
import { readJsonBody } from "./http-helpers.js";
import { isJsonMediaType } from "./media-type.js";
import { json, type ParsedRoute } from "./route-helpers.js";

export interface WorkflowApiOptions {
  service: WorkflowService;
  authenticated: boolean;
}

// Only the argument order is local: `{ code, message }` envelopes rule out badRequest/serverError.
const send = (res: ServerResponse, status: number, body: unknown): void => json(res, body, status);

function errorStatus(error: WorkflowRepositoryError): number {
  if (error.code === "not-found") return 404;
  if (error.code === "id-conflict" || error.code === "revision-conflict" || error.code === "idempotency-conflict") return 409;
  if (error.code === "corrupt-record") return 500;
  return 422;
}

function failure(res: ServerResponse, error: unknown): void {
  if (error instanceof WorkflowServiceError) {
    const status = error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : 422;
    send(res, status, { code: error.code, message: error.message,
      ...(error.issues ? { issues: error.issues } : {}) });
    return;
  }
  if (error instanceof WorkflowRepositoryError) {
    send(res, errorStatus(error), { code: error.code, message: error.message,
      ...(error.issues ? { issues: error.issues } : {}) });
    return;
  }
  // The 500 says nothing, so this is the only record the cause ever gets.
  logger.error(`Workflow API unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  send(res, 500, { code: "internal-error", message: "Workflow operation failed." });
}

function approvalActor(req: IncomingMessage): string {
  const caller = req.headers[CALLER_SESSION_HEADER];
  if (typeof caller !== "string" || !caller) return "operator";
  return getSession(caller)?.employee ?? `session:${caller}`;
}

function segments(pathname: string): string[] | null {
  try {
    return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

function record(value: unknown, keys: readonly string[], message = "Workflow request is invalid."): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new WorkflowRepositoryError("bad-input", message);
  }
  return value as Record<string, unknown>;
}

function plainObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowRepositoryError("bad-input", message);
  return value as Record<string, unknown>;
}

async function body(req: IncomingMessage, res: ServerResponse, maxBytes = 256 * 1024): Promise<unknown | undefined> {
  if (!isJsonMediaType(req.headers["content-type"])) {
    send(res, 422, { code: "bad-input", message: "Workflow requests require JSON content." });
    return undefined;
  }
  const invalid = { code: "bad-input", message: "Request body must be canonical JSON." };
  const parsed = await readJsonBody(req, res, { maxBytes, rejectDuplicateTopLevelKeys: true,
    invalidJsonResponse: invalid, invalidJsonStatus: 422,
    tooLargeResponse: { code: "payload-too-large", message: "Request body is too large." } });
  return parsed.ok ? parsed.body : undefined;
}

function definitionQuery(url: URL): DefinitionListQuery {
  const query: DefinitionListQuery = {};
  const allowed = new Set(["cursor", "limit", "enabled", "retired"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new WorkflowRepositoryError("bad-input", "Workflow definition query is invalid.");
  if (url.searchParams.has("cursor")) query.cursor = url.searchParams.get("cursor")!;
  if (url.searchParams.has("limit")) query.limit = Number(url.searchParams.get("limit"));
  for (const key of ["enabled", "retired"] as const) if (url.searchParams.has(key)) {
    const value = url.searchParams.get(key); if (value !== "true" && value !== "false") throw new WorkflowRepositoryError("bad-input", "Workflow definition query is invalid.");
    query[key] = value === "true";
  }
  return query;
}

function runQuery(url: URL): RunListQuery {
  const query: Record<string, unknown> = {};
  const allowed = new Set(["cursor", "limit", "status", "triggerKind", "startedFrom", "startedTo", "text"]);
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key)) throw new WorkflowRepositoryError("bad-input", "Workflow run query is invalid.");
    query[key] = key === "limit" ? Number(value) : value;
  }
  return query as RunListQuery;
}

function runDetailIsFull(url: URL): boolean {
  const allowed = new Set(["view"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new WorkflowRepositoryError("bad-input", "Workflow run query is invalid.");
  const view = url.searchParams.get("view");
  if (view !== null && view !== "full") throw new WorkflowRepositoryError("bad-input", 'Workflow run view must be "full".');
  return view === "full";
}

/** An attempt's `input` always repeats the input already on its own node run:
 *  both are `inputFor(run, nodeId)` read in the same transaction at dispatch, a
 *  retry copies the first attempt's value, and the graph is acyclic so a node
 *  activates once. The node run keeps it — that is the only copy for a node type
 *  that owns no attempts — and the wire carries it once. */
function withoutAttemptInput(detail: WorkflowRunDetail): WorkflowAttemptWire[] {
  return detail.attempts.map(({ input, ...attempt }) => attempt);
}

/** Run detail is lean by default so that polling a run costs a status page, not
 *  the whole definition snapshot plus every interpolated prompt. The definition
 *  is still reachable through GET /api/workflows/:id, and prompts through the
 *  attempt transcript route. */
function leanRunDetail(detail: WorkflowRunDetail, spendUsd: number): WorkflowRunLeanWire {
  const { definition, attempts, ...run } = detail;
  return { ...run, attempts: withoutAttemptInput(detail).map(({ promptText, ...attempt }) => attempt), spendUsd };
}

function fullRunDetail(detail: WorkflowRunDetail, spendUsd: number): WorkflowRunDetailWire {
  return { ...detail, attempts: withoutAttemptInput(detail), spendUsd };
}

/** Fork adaptation (see the PUT handler below): the node kinds that need the
 *  unported Todo subsystem, reported by name so the author knows what to drop. */
function unsupportedTodoCapability(definition: Record<string, unknown>): string | undefined {
  const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const { type, config } = node as { type?: unknown; config?: { kind?: unknown; mode?: unknown } };
    if (type === "trigger" && config?.kind === "todo-status") {
      return "todo-status triggers need the Todo (work-items) subsystem, which this build does not include.";
    }
    if (type === "wait" && config?.mode === "todo-comment") {
      return "todo-comment waits need the Todo (work-items) subsystem, which this build does not include.";
    }
  }
  return undefined;
}

async function definitions(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], options: WorkflowApiOptions): Promise<boolean> {
  const { service } = options; const method = req.method ?? "GET";
  if (parts.length === 2 && method === "GET") { send(res, 200, service.listDefinitions(definitionQuery(url))); return true; }
  if (parts.length === 2 && method === "POST") {
    const value = body(req, res); const parsed = await value; if (parsed === undefined) return true;
    send(res, 201, service.createDefinition(record(parsed, ["id", "title", "description"]) as never)); return true;
  }
  const id = parts[2]; if (!id) return false;
  if (parts.length === 3 && method === "GET") { const value = service.getDefinition(id); if (!value) throw new WorkflowRepositoryError("not-found", `Workflow definition ${id} was not found.`); send(res, 200, value); return true; }
  if (parts.length === 3 && method === "PUT") {
    const parsed = await body(req, res); if (parsed === undefined) return true;
    const value = record(parsed, ["definition", "expectedRevision"]); const definition = plainObject(value.definition, "Workflow definition is invalid.");
    // Fork adaptation: OpenRyoko has not ported the Todo (work-items) subsystem,
    // so a todo-status trigger would never fire and a todo-comment wait could
    // never resume. Refuse to SAVE them rather than let a definition look armed
    // while silently dead. Remove this guard when work-items lands.
    const unsupported = unsupportedTodoCapability(definition);
    if (unsupported) { send(res, 422, { code: "unsupported-capability", message: unsupported }); return true; }
    send(res, 200, service.saveDefinition({ ...definition, id } as never, value.expectedRevision as number)); return true;
  }
  if (parts.length === 4 && parts[3] === "duplicate" && method === "POST") {
    const parsed = await body(req, res); if (parsed === undefined) return true; const value = record(parsed, ["id", "title"]);
    send(res, 201, service.duplicateDefinition(id, value as never)); return true;
  }
  if (parts.length === 4 && ["retire", "unretire", "enable", "disable"].includes(parts[3]!) && method === "POST") {
    const parsed = await body(req, res); if (parsed === undefined) return true; const value = record(parsed, ["expectedRevision"]); const retiring = parts[3] === "retire" || parts[3] === "unretire";
    const saved = retiring ? service.setRetired({ id, retired: parts[3] === "retire", expectedRevision: value.expectedRevision as number })
      : service.setEnabled({ id, enabled: parts[3] === "enable", expectedRevision: value.expectedRevision as number });
    send(res, 200, saved); return true;
  }
  return false;
}

async function runs(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], service: WorkflowService): Promise<boolean> {
  const method = req.method ?? "GET"; const workflowId = parts[2]; if (!workflowId || parts[3] !== "runs") return false;
  if (parts.length === 4 && method === "GET") { send(res, 200, service.listRuns(workflowId, runQuery(url))); return true; }
  if (parts.length === 4 && method === "POST") {
    const parsed = await body(req, res); if (parsed === undefined) return true; const value = record(parsed, ["input", "idempotencyKey", "todoId"]);
    const caller = callerSessionId(req);
    send(res, 201, await service.startManual({ workflowId, input: value.input as never,
      ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: value.idempotencyKey as string }),
      ...(value.todoId === undefined ? {} : { todoId: value.todoId as string }),
      ...(caller === undefined ? {} : { callerSessionId: caller }) })); return true;
  }
  const runId = parts[4]; if (!runId) return false;
  if (parts.length === 5 && method === "GET") {
    const full = runDetailIsFull(url); const value = service.getRun(workflowId, runId);
    if (!value) throw new WorkflowRepositoryError("not-found", `Workflow run ${runId} was not found.`);
    const spendUsd = service.getRunSpend(workflowId, runId);
    send(res, 200, full ? fullRunDetail(value, spendUsd) : leanRunDetail(value, spendUsd)); return true;
  }
  if (parts.length === 6 && parts[5] === "cancel" && method === "POST") {
    const parsed = await body(req, res); if (parsed === undefined) return true; const value = record(parsed, ["reason"]);
    send(res, 200, await service.cancelRun({ workflowId, runId, reason: value.reason === undefined ? "" : value.reason as string })); return true;
  }
  if (parts.length === 6 && parts[5] === "rerun" && method === "POST") {
    const parsed = await body(req, res); if (parsed === undefined) return true; const value = record(parsed, ["definition", "idempotencyKey"]);
    send(res, 201, await service.rerun({ workflowId, runId, definition: value.definition as never, idempotencyKey: value.idempotencyKey as string })); return true;
  }
  if (parts.length === 8 && parts[5] === "nodes" && parts[7] === "approval" && method === "POST") {
    const parsed = await body(req, res); if (parsed === undefined) return true;
    const value = record(parsed, ["decision", "reason", "choice", "expectedRevision"]);
    send(res, 200, await service.decideApproval({ workflowId, runId, nodeId: parts[6]!,
      decision: value.decision as never, expectedRevision: value.expectedRevision as number, decidedBy: approvalActor(req),
      ...(value.reason === undefined ? {} : { reason: value.reason as string }),
      ...(value.choice === undefined ? {} : { choice: value.choice as string }) })); return true;
  }
  if (parts.length === 8 && parts[5] === "nodes" && parts[7] === "retry" && method === "POST") {
    const parsed = await body(req, res); if (parsed === undefined) return true;
    const value = record(parsed, ["idempotencyKey"]);
    send(res, 200, await service.retryNode({ workflowId, runId, nodeId: parts[6]!,
      idempotencyKey: value.idempotencyKey as string })); return true;
  }
  if (parts.length === 10 && parts[5] === "nodes" && parts[7] === "attempts" && parts[9] === "transcript" && method === "GET") {
    send(res, 200, service.getAttemptTranscript({ workflowId, runId, nodeId: parts[6]!, attempt: Number(parts[8]) })); return true;
  }
  return false;
}

async function event(req: IncomingMessage, res: ServerResponse, parts: string[], service: WorkflowService): Promise<boolean> {
  if (parts.length !== 4 || parts[2] !== "events" || req.method !== "POST") return false;
  const parsed = await body(req, res, 65 * 1024); if (parsed === undefined) return true;
  const value = record(parsed, ["fireId", "payload"], "Workflow event request is invalid.");
  send(res, 202, await service.fireEvent({ eventName: parts[3]!, fireId: value.fireId as string, payload: value.payload as never }));
  return true;
}

function callerSessionId(req: IncomingMessage): string | undefined {
  const value = req.headers[CALLER_SESSION_HEADER];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function attemptFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof WorkflowOutputError) {
    send(res, 422, { code: error.code, message: error.message });
    return;
  }
  if (error instanceof WorkflowRepositoryError) {
    if (error.code === "not-found") {
      send(res, 409, {
        code: "not-a-workflow-attempt",
        message: "The caller is not a running Workflow attempt.",
      });
      return;
    }
    if (error.code === "already-submitted") {
      send(res, 409, { code: error.code, message: error.message });
      return;
    }
  }
  failure(res, error);
}

async function attempts(req: IncomingMessage, res: ServerResponse, parts: string[], service: WorkflowService): Promise<boolean> {
  if (parts.length !== 4 || parts[2] !== "attempts" || req.method !== "POST"
    || !["submit", "extend"].includes(parts[3]!)) return false;
  const sessionId = callerSessionId(req);
  if (!sessionId) {
    send(res, 409, {
      code: "not-a-workflow-attempt",
      message: "The caller is not a running Workflow attempt.",
    });
    return true;
  }
  const parsed = await body(req, res);
  if (parsed === undefined) return true;
  try {
    if (parts[3] === "submit") {
      const value = record(parsed, ["outcome", "fields", "summary"]);
      if (value.outcome !== undefined && value.outcome !== "success" && value.outcome !== "failure") {
        throw new WorkflowRepositoryError("bad-input", "Workflow attempt outcome must be success or failure.");
      }
      if (value.summary !== undefined && typeof value.summary !== "string") {
        throw new WorkflowRepositoryError("bad-input", "Workflow attempt summary must be a string.");
      }
      await service.submitAttemptOutput({
        sessionId,
        ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
        ...(value.fields === undefined ? {} : { fields: value.fields }),
        ...(value.summary === undefined ? {} : { summary: value.summary }),
      });
    } else {
      const value = record(parsed, ["reason"]);
      if (value.reason !== undefined && typeof value.reason !== "string") {
        throw new WorkflowRepositoryError("bad-input", "Workflow attempt extension reason must be a string.");
      }
      await service.extendAttemptDeadline({
        sessionId,
        ...(value.reason === undefined ? {} : { reason: value.reason }),
      });
    }
    send(res, 200, { ok: true });
  } catch (error) {
    attemptFailure(res, error);
  }
  return true;
}

export async function handleWorkflowApi(req: IncomingMessage, res: ServerResponse, route: ParsedRoute, options: WorkflowApiOptions): Promise<boolean> {
  const { url } = route; const parts = segments(route.pathname);
  if (!parts || parts[0] !== "api" || parts[1] !== "workflows") return false;
  const writing = ["POST", "PUT", "PATCH", "DELETE"].includes(route.method);
  if (writing && !options.authenticated) { send(res, 401, { code: "unauthorized", message: "Workflow authentication required." }); return true; }
  try {
    if (await attempts(req, res, parts, options.service)) return true;
    if (await event(req, res, parts, options.service)) return true;
    if (await runs(req, res, url, parts, options.service)) return true;
    return await definitions(req, res, url, parts, options);
  } catch (error) { failure(res, error); return true; }
}
