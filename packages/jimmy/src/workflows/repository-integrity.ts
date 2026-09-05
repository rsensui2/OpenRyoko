import { repositoryError } from './repository-support.js';

type WorkflowSqliteConnection = ConstructorParameters<typeof import('./repository.js').WorkflowRepository>[0];

/* Every invariant the run tables are meant to hold, asserted in SQL before a read trusts them. */
const RUN_INTEGRITY = `SELECT 1 FROM workflow_runs r WHERE r.workflow_id=? AND (
  r.status NOT IN ('pending','running','waiting','completed','failed','cancelled') OR r.revision<1
  OR strftime('%Y-%m-%dT%H:%M:%fZ',r.started_at) IS NOT r.started_at
  OR NOT json_valid(r.definition_json) OR NOT json_valid(r.input_json) OR NOT json_valid(r.trigger_json)
  OR (r.error_json IS NOT NULL AND (NOT json_valid(r.error_json) OR json_type(r.error_json,'$.code') IS NOT 'text'
    OR json_type(r.error_json,'$.message') IS NOT 'text' OR json_type(r.error_json,'$.retryable') NOT IN ('true','false')))
  OR CASE WHEN json_valid(r.definition_json) AND json_valid(r.trigger_json) THEN
    json_type(r.definition_json) IS NOT 'object' OR json_type(r.input_json) IS NOT 'object' OR json_type(r.trigger_json) IS NOT 'object'
    OR json_extract(r.definition_json,'$.schemaVersion') IS NOT 1 OR json_type(r.definition_json,'$.nodes') IS NOT 'array'
    OR json_extract(r.definition_json,'$.id') IS NOT r.workflow_id
    OR json_extract(r.definition_json,'$.title') IS NOT r.workflow_title
    OR json_extract(r.definition_json,'$.revision') IS NOT r.definition_revision
    OR json_extract(r.trigger_json,'$.kind') NOT IN ('manual','schedule','event','todo-status','workflow-call') ELSE 0 END
) LIMIT 1`;
const CHILD_INTEGRITY = `SELECT 1 FROM workflow_runs r WHERE r.workflow_id=? AND (
  (SELECT count(*) FROM workflow_node_runs n WHERE n.run_id=r.id) != json_array_length(r.definition_json,'$.nodes')
  OR NOT EXISTS (SELECT 1 FROM json_each(r.definition_json,'$.nodes') j WHERE j.value->>'$.id'=json_extract(r.trigger_json,'$.nodeId')
    AND j.value->>'$.type'='trigger' AND j.value->>'$.config.kind'=json_extract(r.trigger_json,'$.kind'))
  OR EXISTS (SELECT 1 FROM workflow_node_runs n WHERE n.run_id=r.id AND (n.status NOT IN
    ('pending','ready','dispatching','running','waiting','completed','failed','skipped','cancelled') OR n.activated NOT IN (0,1)
    OR (n.resolved_config_json IS NOT NULL AND NOT json_valid(n.resolved_config_json)) OR (n.input_json IS NOT NULL AND NOT json_valid(n.input_json))
    OR (n.output_json IS NOT NULL AND (NOT json_valid(n.output_json) OR json_type(n.output_json,'$.text') IS NOT 'text'
      OR json_type(n.output_json,'$.fields') IS NOT 'object')) OR (n.error_json IS NOT NULL AND NOT json_valid(n.error_json))
    OR NOT EXISTS (SELECT 1 FROM json_each(r.definition_json,'$.nodes') j WHERE j.value->>'$.id'=n.node_id AND j.value->>'$.type'=n.node_type)))
  OR EXISTS (SELECT 1 FROM workflow_attempts a WHERE a.run_id=r.id AND (a.status NOT IN
    ('dispatching','running','completed','failed','timed-out','cancelled') OR NOT json_valid(a.resolved_config_json) OR NOT json_valid(a.input_json)
    OR json_type(a.resolved_config_json,'$.employeeId') IS NOT 'text' OR strftime('%Y-%m-%dT%H:%M:%fZ',a.started_at) IS NOT a.started_at
    OR (a.output_json IS NOT NULL AND NOT json_valid(a.output_json)) OR (a.error_json IS NOT NULL AND NOT json_valid(a.error_json))
    OR (a.status='dispatching' AND (a.session_id IS NOT NULL OR a.output_json IS NOT NULL OR a.error_json IS NOT NULL OR a.ended_at IS NOT NULL))
    OR (a.status='running' AND (a.session_id IS NULL OR a.output_json IS NOT NULL OR a.error_json IS NOT NULL OR a.ended_at IS NOT NULL))
    OR (a.status='completed' AND (a.session_id IS NULL OR a.output_json IS NULL OR a.error_json IS NOT NULL OR a.ended_at IS NULL))
    OR (a.status IN ('failed','timed-out','cancelled') AND (a.error_json IS NULL OR a.output_json IS NOT NULL OR a.ended_at IS NULL))
    OR (a.session_id IS NOT NULL AND EXISTS (SELECT 1 FROM workflow_attempts d WHERE d.session_id=a.session_id AND d.rowid<>a.rowid))
    OR NOT EXISTS (SELECT 1 FROM json_each(r.definition_json,'$.nodes') j WHERE j.value->>'$.id'=a.node_id AND j.value->>'$.type'='employee')))
  OR EXISTS (SELECT 1 FROM workflow_approvals a WHERE a.run_id=r.id AND (a.status NOT IN ('pending','approved','rejected')
    OR (a.status='pending' AND (a.decided_at IS NOT NULL OR a.decided_by IS NOT NULL OR a.decision IS NOT NULL OR a.reason IS NOT NULL))
    OR (a.status<>'pending' AND (a.decided_at IS NULL OR a.decided_by IS NULL OR a.decision<>CASE a.status WHEN 'approved' THEN 'approve' ELSE 'reject' END))
    OR NOT EXISTS (SELECT 1 FROM json_each(r.definition_json,'$.nodes') j WHERE j.value->>'$.id'=a.node_id AND j.value->>'$.type'='approval')))
) LIMIT 1`;

export function assertHistoryIntegrity(db: WorkflowSqliteConnection, workflowId: string): void {
  let corrupt = false;
  try { corrupt = [RUN_INTEGRITY, CHILD_INTEGRITY].some((sql) => db.prepare(sql).get(workflowId) !== undefined); } catch { corrupt = true; }
  if (corrupt) repositoryError('corrupt-record', `Workflow ${workflowId} run history is invalid.`);
}
