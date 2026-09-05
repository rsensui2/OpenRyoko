import type { TriggerNode, WorkflowDefinition } from "./model.js";
import type { WorkflowRearmTarget } from "./todo-ports.js";

/**
 * Where a re-armed Todo has to land, read off the CURRENT definition rather than
 * the snapshot a run started with: a workflow disabled or retired since then
 * fires nothing, and a Todo left sitting at its trigger status would look queued
 * forever. The status comes from the trigger, never from a hardcoded default —
 * every Todo-triggered workflow gets this, not one of them.
 *
 * Two callers now read the same trigger: a rejection sending work round again,
 * and the availability sweep bringing a quota-parked Todo back.
 */
export function resolveRearmTarget(
  definition: WorkflowDefinition | null,
  workflowId: string,
): WorkflowRearmTarget {
  if (!definition) return { unavailable: `workflow \`${workflowId}\` no longer exists` };
  if (definition.retiredAt !== undefined) return { unavailable: `workflow \`${workflowId}\` is retired` };
  if (!definition.enabled) return { unavailable: `workflow \`${workflowId}\` is disabled` };
  const trigger = definition.nodes.find((node): node is TriggerNode =>
    node.type === "trigger" && node.config.kind === "todo-status");
  if (trigger?.config.kind !== "todo-status") {
    return { unavailable: `workflow \`${workflowId}\` has no Todo trigger to re-arm` };
  }
  return { status: trigger.config.status,
    ...(trigger.config.actor !== undefined ? { actor: trigger.config.actor } : {}),
    ...(trigger.config.label !== undefined ? { label: trigger.config.label } : {}) };
}
