/** Reading who holds a node mutex, straight off each run's own definition snapshot.
 *
 *  There is no lock table on purpose: a key is held for exactly as long as a node run
 *  carrying it is live, so a holder that crashed cannot leave a stale lock behind —
 *  the thing that represents the lock is the thing that died. What the runner does
 *  with the answer lives in node-mutex.ts; this file only reads.
 *
 *  Nothing here may reach the logger. The repository is imported before a test or a
 *  CLI has set `JINN_HOME`, and `logger.ts` resolves its log directory from it once,
 *  at import: pulling it into this graph would freeze the wrong home. */

import { z } from 'zod';
import { repositoryError } from './repository-support.js';
import { WORKFLOW_NODE_RUN_STATUSES } from './runtime.js';

type WorkflowSqliteConnection = ConstructorParameters<typeof import('./repository.js').WorkflowRepository>[0];

const mutexNodeRunSchema = z.strictObject({
  workflowId: z.string(), runId: z.string(), nodeId: z.string(), mutexKey: z.string(),
  status: z.enum(WORKFLOW_NODE_RUN_STATUSES),
});
/** An employee node run of a live run that authors a mutex key. `pending` is a node
 *  standing off the key; every other status here is a node live enough to hold it. */
export type WorkflowMutexNodeRun = z.infer<typeof mutexNodeRunSchema>;

export function readMutexNodeRuns(db: WorkflowSqliteConnection): WorkflowMutexNodeRun[] {
  const rows = db.prepare(`SELECT r.workflow_id AS workflowId, n.run_id AS runId, n.node_id AS nodeId,
      n.status AS status, j.value->>'$.config.mutex' AS mutexKey
    FROM workflow_node_runs n
      JOIN workflow_runs r ON r.id = n.run_id
      JOIN json_each(r.definition_json, '$.nodes') j ON j.value->>'$.id' = n.node_id
    WHERE n.node_type = 'employee' AND n.activated = 1
      AND n.status IN ('pending', 'dispatching', 'running', 'waiting')
      AND r.status IN ('pending', 'running', 'waiting')
      AND j.value->>'$.config.mutex' IS NOT NULL
    ORDER BY n.run_id, n.node_id`).all() as unknown[];
  return rows.map((row) => {
    const result = mutexNodeRunSchema.safeParse(row);
    return result.success ? result.data : repositoryError('corrupt-record', 'Workflow mutex node run is invalid.');
  });
}
