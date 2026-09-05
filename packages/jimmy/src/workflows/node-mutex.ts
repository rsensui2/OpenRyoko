/** Serializing employee nodes that must not be live at the same time.
 *
 *  A node authors `mutex: "<key>"` and then dispatches only while no other node
 *  carrying that key is live. The lock is derived rather than stored — see
 *  repository-mutex.ts, which reads it. Waiting is unbounded here on purpose: the
 *  holder's own `timeoutMinutes` is what ends it, and a second clock could only
 *  disagree with the first. */

import { logger } from '../shared/logger.js';
import type { EmployeeNode } from './model.js';
import type { WorkflowMutexNodeRun } from './repository-mutex.js';
import type { WorkflowRepository } from './repository.js';
import { nodeRun } from './run-graph.js';
import type { WorkflowRunDetail } from './runtime.js';

/** Whoever is live on this node's key, if it is not this node itself. A `pending`
 *  node run is another node standing off the same key rather than a holder, so two
 *  waiters never block each other into a deadlock neither can leave. */
export function mutexHolder(repository: WorkflowRepository, run: WorkflowRunDetail,
  node: EmployeeNode): WorkflowMutexNodeRun | null {
  const key = node.config.mutex;
  if (!key) return null;
  return repository.listMutexNodeRuns().find((candidate) => candidate.mutexKey === key
    && candidate.status !== 'pending' && !(candidate.runId === run.id && candidate.nodeId === node.id)) ?? null;
}

/** Write why the run is parked where the operator reads the run, not only into the
 *  log: the key it wants and who holds it. Called once the run has nothing else it
 *  could be doing, so it names the real reason, and only when the holder changes, so
 *  a node standing off for an hour writes once. The record is transient by
 *  construction: dispatching replaces `resolvedConfig` with the config it dispatched. */
export function recordMutexWaits(repository: WorkflowRepository, run: WorkflowRunDetail): void {
  for (const node of run.definition.nodes) {
    if (node.type !== 'employee') continue;
    const runtime = nodeRun(run, node.id);
    if (!runtime.activated || runtime.status !== 'pending') continue;
    const holder = mutexHolder(repository, run, node);
    if (!holder) continue;
    const waiting = { mutexKey: holder.mutexKey, mutexHeldBy: `${holder.runId}:${holder.nodeId}` };
    if (runtime.resolvedConfig?.mutexKey === waiting.mutexKey
      && runtime.resolvedConfig?.mutexHeldBy === waiting.mutexHeldBy) continue;
    const current = repository.getRun(run.workflowId, run.id)!;
    repository.mutateRun(current.id, current.revision, (tx) => {
      tx.setNodeStatus(node.id, runtime.status, { resolvedConfig: { ...runtime.resolvedConfig, ...waiting } });
    });
    logger.info(`Workflow run ${run.id} node ${node.id} is waiting on mutex ${waiting.mutexKey} held by ${waiting.mutexHeldBy}.`);
  }
}

/** A key lives only as long as the node run carrying it, so the moment that node goes
 *  terminal every run standing off the key has a different answer waiting for it — and
 *  nothing else would re-drive them: they are parked on no timer and no child, only on
 *  this. Fired and forgotten, the way a workflow-call caller is woken. */
export function wakeMutexWaiters(repository: WorkflowRepository, run: WorkflowRunDetail, nodeId: string,
  advance: (workflowId: string, runId: string) => Promise<unknown>): void {
  const node = run.definition.nodes.find((candidate) => candidate.id === nodeId);
  const key = node?.type === 'employee' ? node.config.mutex : undefined;
  if (!key) return;
  for (const waiter of repository.listMutexNodeRuns()) {
    if (waiter.mutexKey !== key || waiter.status !== 'pending' || waiter.runId === run.id) continue;
    void advance(waiter.workflowId, waiter.runId).catch((error) => {
      logger.warn(`Workflow run ${waiter.runId} could not resume on mutex ${key}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
