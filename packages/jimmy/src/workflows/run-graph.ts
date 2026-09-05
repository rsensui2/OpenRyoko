/** Reading a run's node graph: what a node's runtime record is, what feeds it,
 *  which of its edges have fired, which of its nodes can still be reached, and
 *  which sessions upstream of it are still readable. */

import type { WorkflowNodeRunRecord, WorkflowRunDetail } from "./runtime.js";

export function nodeRun(run: WorkflowRunDetail, nodeId: string): WorkflowNodeRunRecord {
  const found = run.nodeRuns.find((node) => node.nodeId === nodeId);
  if (!found) throw new Error(`Workflow node ${nodeId} was not found.`);
  return found;
}

export function incoming(run: WorkflowRunDetail, nodeId: string) {
  return run.definition.edges.filter((edge) => edge.to.nodeId === nodeId);
}

/** Every completed ancestor of `nodeId`, with the session that produced it when
 *  there is one — the transcripts a phase is allowed to read for context. */
export function upstreamSessions(run: WorkflowRunDetail, nodeId: string): Array<{ nodeId: string; sessionId?: string }> {
  const ancestors = new Set<string>();
  const pending = incoming(run, nodeId).map((edge) => edge.from.nodeId);
  while (pending.length > 0) {
    const upstreamId = pending.pop()!;
    if (ancestors.has(upstreamId)) continue;
    ancestors.add(upstreamId);
    pending.push(...incoming(run, upstreamId).map((edge) => edge.from.nodeId));
  }
  return run.definition.nodes.flatMap((authored) => {
    const runtime = nodeRun(run, authored.id);
    if (!ancestors.has(authored.id) || runtime.status !== "completed") return [];
    const attempt = run.attempts.filter((candidate) => candidate.nodeId === authored.id
      && candidate.status === "completed" && candidate.sessionId).at(-1);
    const sessionId = runtime.output?.sessionId ?? attempt?.sessionId;
    return [{ nodeId: authored.id, ...(sessionId ? { sessionId } : {}) }];
  });
}

export function terminalNode(node: WorkflowNodeRunRecord): boolean {
  return ["completed", "failed", "skipped", "cancelled"].includes(node.status);
}

/** Whether an edge has fired: its source is done, and the port it leaves by is the
 *  one that source chose. Only a routing node chooses; everything else leaves by
 *  `success`, and a failed employee leaves by `error` if anything is wired there. */
export function edgeActivated(run: WorkflowRunDetail, edge: WorkflowRunDetail["definition"]["edges"][number]): boolean {
  const source = run.definition.nodes.find((node) => node.id === edge.from.nodeId)!;
  const runtime = nodeRun(run, source.id);
  if (!runtime.activated) return false;
  if (runtime.status === "failed" && source.type === "employee") return edge.from.port === "error";
  if (runtime.status !== "completed") return false;
  const routed = source.type === "condition" || source.type === "approval"
    || (source.type === "workflow-call" && source.config.iterate !== undefined);
  const port = routed ? runtime.output?.fields.port : "success";
  return port === edge.from.port;
}

function activationPossible(run: WorkflowRunDetail, nodeId: string, seen = new Set<string>()): boolean {
  const runtime = nodeRun(run, nodeId);
  if (runtime.activated) return true;
  if (runtime.status === "skipped" || runtime.status === "cancelled" || seen.has(nodeId)) return false;
  const path = new Set(seen).add(nodeId);
  return incoming(run, nodeId).some((edge) => {
    const source = nodeRun(run, edge.from.nodeId);
    if (!source.activated) return activationPossible(run, edge.from.nodeId, path);
    return terminalNode(source) ? edgeActivated(run, edge) : true;
  });
}

export function canNeverActivate(run: WorkflowRunDetail, nodeId: string): boolean {
  return incoming(run, nodeId).length > 0 && !activationPossible(run, nodeId);
}

export function mergeReady(run: WorkflowRunDetail, nodeId: string): boolean {
  return incoming(run, nodeId).every((edge) => {
    const source = nodeRun(run, edge.from.nodeId);
    return source.activated ? terminalNode(source) : !activationPossible(run, edge.from.nodeId);
  });
}
