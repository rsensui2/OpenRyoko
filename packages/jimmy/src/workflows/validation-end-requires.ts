import type { WorkflowDefinition } from './model.js';
import type { WorkflowValidationIssue } from './issues.js';

/**
 * A success End that demands landing evidence has to name an output field some
 * node in the same definition actually declares. Refused at save, because a
 * demand pointing at nothing can never be met — and the run that would discover
 * that is one that has already done the work.
 */

function reference(definition: WorkflowDefinition, endId: string, path: string,
  ref: { nodeId: string; field: string }): WorkflowValidationIssue[] {
  const target = definition.nodes.find((node) => node.id === ref.nodeId);
  const named = `field \`${ref.field}\` from node \`${ref.nodeId}\``;
  if (!target) {
    return [{ code: 'unknown-required-node', message: `An End requires ${named}, which this Workflow does not define.`,
      nodeId: endId, path: `${path}.nodeId` }];
  }
  if (target.type !== 'employee' || !Object.hasOwn(target.config.output?.fields ?? {}, ref.field)) {
    return [{ code: 'unknown-required-field', message: `An End requires ${named}, which that node does not declare as an output field.`,
      nodeId: endId, path: `${path}.field` }];
  }
  return [];
}

export function endRequirementIssues(definition: WorkflowDefinition): WorkflowValidationIssue[] {
  return definition.nodes.flatMap((node, index) => {
    if (node.type !== 'end' || !node.config.requires) return [];
    const { commitIn, ...evidence } = node.config.requires;
    const path = `nodes.${index}.config.requires`;
    return [...reference(definition, node.id, path, evidence),
      ...(commitIn ? reference(definition, node.id, `${path}.commitIn`, commitIn) : [])];
  });
}
