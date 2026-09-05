/**
 * Atomic workflow creation — fork-specific gateway composition (not an
 * upstream file). Lives under gateway/ deliberately: the workflows runtime
 * itself never touches a raw database handle (see
 * todo-capability-boundary.test.ts).
 *
 * The three writes go through the REPOSITORY inside one better-sqlite3
 * transaction (the inner repository transactions become savepoints), so any
 * failure rolls the whole create back to nothing. Trigger re-arming and the
 * definition-changed notification happen exactly once, AFTER the commit —
 * never from inside the transaction, where they could observe (and act on) a
 * state that is about to roll back.
 */
import type Database from "better-sqlite3";
import type { WorkflowRepository } from "../workflows/repository.js";
import type { WorkflowService } from "../workflows/service.js";
import type { WorkflowNode } from "../workflows/model.js";

export interface AtomicCreateInput {
  id: string;
  title: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: Array<{ id: string; from: { nodeId: string; port: string }; to: { nodeId: string; port: string } }>;
  enable: boolean;
}

export interface AtomicCreateResult {
  id: string;
  revision: number;
  enabled: boolean;
}

export function createWorkflowAtomically(
  database: Database.Database,
  repository: WorkflowRepository,
  service: WorkflowService,
  input: AtomicCreateInput,
): AtomicCreateResult {
  const run = database.transaction(() => {
    const created = repository.createDefinition({
      id: input.id, title: input.title,
      ...(input.description ? { description: input.description } : {}),
    });
    const saved = repository.saveDefinition(
      { ...created, nodes: input.nodes, edges: input.edges } as never,
      created.revision,
    );
    const armed = input.enable
      ? repository.setEnabled(saved.id, true, saved.revision)
      : saved;
    return { id: armed.id, revision: armed.revision, enabled: armed.enabled };
  });
  const result = run.immediate();
  service.definitionWritten(result.id);
  return result;
}
