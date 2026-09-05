import type { WorkflowRepository } from "./repository.js";
import type { WorkflowRunDetail } from "./runtime.js";
import { callerIdentity, fail } from "./service-input.js";
import type { WorkflowCallInput } from "./service.js";

/**
 * Which Workflow invocation a new run is being started on behalf of, and whether
 * that invocation may reach the target at all. A Workflow Call names its caller
 * outright; a run started from an attempt session has to be traced back to one.
 */

type CallerRepository = Pick<WorkflowRepository, "getRun" | "findAttemptBySessionId" | "listRecoverableRuns">;
type WorkflowCaller = WorkflowCallInput["caller"];

/** The trigger kinds whose payload the service writes itself, and so the only
 *  ones where a `caller` key is ancestry. A schedule, event, or todo-status
 *  payload is the fire's own data, in which `caller` is just a business field. */
const PARENTED_TRIGGER_KINDS: ReadonlyArray<WorkflowRunDetail["trigger"]["kind"]> = ["manual", "workflow-call"];

/** The invocation a session speaks for, or null when the session is not one —
 *  an operator, a cron run, or an attempt that has already settled. */
export function callerForSession(repository: CallerRepository, sessionId: string | undefined): WorkflowCaller | null {
  if (sessionId === undefined) return null;
  const attempt = repository.findAttemptBySessionId(sessionId);
  if (!attempt || !["dispatching", "running"].includes(attempt.status)) return null;
  const run = repository.listRecoverableRuns().find((candidate) => candidate.id === attempt.runId);
  return run ? { workflowId: run.workflowId, runId: run.id, nodeId: attempt.nodeId } : null;
}

/** Whether the node a caller names is mid-invocation right now: an Employee node
 *  with a live attempt, or a Workflow Call still waiting on its children. */
function isActiveInvocation(run: WorkflowRunDetail, caller: WorkflowCaller): boolean {
  const runtime = run.nodeRuns.find((node) => node.nodeId === caller.nodeId);
  if (!runtime?.activated) return false;
  const authored = run.definition.nodes.find((node) => node.id === caller.nodeId);
  if (authored?.type === "workflow-call") return runtime.status === "running";
  if (authored?.type !== "employee") return false;
  const attempt = run.attempts.filter((item) => item.nodeId === caller.nodeId).at(-1);
  return attempt !== undefined && ["dispatching", "running"].includes(attempt.status);
}

/** The invocation that started this run, or undefined where the ancestry ends. A
 *  Workflow Call always names its caller; a manual run names one only when an
 *  attempt session started it. */
function parentCaller(run: WorkflowRunDetail): WorkflowCaller | undefined {
  if (!PARENTED_TRIGGER_KINDS.includes(run.trigger.kind)) return undefined;
  const parent = run.trigger.payload.caller;
  if (parent === undefined && run.trigger.kind !== "workflow-call") return undefined;
  if (!callerIdentity(parent)) fail("bad-input", "Workflow caller ancestry is invalid.");
  return parent;
}

/** The run one hop up the ancestry, refusing a parent whose named node could not
 *  have made the call. */
function parentRun(repository: CallerRepository, parent: WorkflowCaller): WorkflowRunDetail {
  const run = repository.getRun(parent.workflowId, parent.runId)
    ?? fail("bad-input", "Workflow caller ancestry was not found.");
  if (!run.definition.nodes.some((node) => node.id === parent.nodeId
    && (node.type === "employee" || node.type === "workflow-call"))) {
    fail("bad-input", "Workflow caller ancestry is invalid.");
  }
  return run;
}

/** Refuse a caller that is not a live invocation, or whose ancestry re-enters the
 *  target, loops, unwinds into a run already being cancelled, or nests deeper than
 *  a Workflow tree has any reason to go. */
export function assertCallableCaller(repository: CallerRepository, targetWorkflowId: string, caller: WorkflowCaller): void {
  let current = repository.getRun(caller.workflowId, caller.runId)
    ?? fail("bad-input", "Workflow caller run was not found.");
  if (!isActiveInvocation(current, caller)) fail("bad-input", "Workflow caller node is not an active invocation.");
  const seen = new Set<string>();
  for (let depth = 0; depth < 128; depth += 1) {
    if (current.cancelRequestedAt) fail("bad-input", "Workflow caller run is being cancelled.");
    if (current.workflowId === targetWorkflowId) fail("bad-input", "Workflow call recursion is not allowed.");
    if (seen.has(current.id)) fail("bad-input", "Workflow caller ancestry contains a cycle.");
    seen.add(current.id);
    const parent = parentCaller(current);
    if (!parent) return;
    current = parentRun(repository, parent);
  }
  fail("bad-input", "Workflow caller ancestry is too deep.");
}
