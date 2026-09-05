import type { WorkflowDefinition } from './model.js';
import type { WorkflowValidationIssue } from './issues.js';

/**
 * The rules a Workflow Call node has to pass, split by when they can be judged.
 *
 * `workflowCallSaveIssues` are node-local and refused at save, alongside the
 * other rules a definition must never be stored carrying. A loop nobody bounded
 * belongs here: "every loop bounded by construction" is not a property that can
 * wait until someone enables the Workflow. `maxRounds` parses as optional only
 * because a missing bound has to survive far enough to be named — a definition
 * that fails the schema can report nothing more useful than "invalid".
 *
 * `workflowCallIterationIssues` are about wiring, so they can only be judged
 * once the graph is whole, and are refused at the executable gate. Holding a
 * half-drawn loop to them would make the node unsaveable while it is being
 * drawn, the same reason `unreachable-node` waits.
 */

export const ITERATION_EXHAUSTED_PORT = 'exhausted';

export function workflowCallSaveIssues(definition: WorkflowDefinition): WorkflowValidationIssue[] {
  return definition.nodes.flatMap((node, index) => {
    if (node.type !== 'workflow-call') return [];
    const issues: WorkflowValidationIssue[] = [];
    if (node.config.workflowId.source === 'fixed' && node.config.workflowId.value === definition.id) {
      issues.push({ code: 'workflow-call-self-reference',
        message: 'A Workflow Call cannot target its own defining Workflow.',
        nodeId: node.id, path: `nodes.${index}.config.workflowId` });
    }
    if (node.config.iterate?.maxRounds === undefined && node.config.iterate) {
      issues.push({ code: 'unbounded-iteration',
        message: 'A Workflow Call that iterates must set maxRounds, so the loop is bounded by the definition rather than by whatever the rounds decide.',
        nodeId: node.id, path: `nodes.${index}.config.iterate.maxRounds` });
    }
    if (node.config.iterate && node.config.items) {
      issues.push({ code: 'iteration-with-fanout',
        message: 'A Workflow Call cannot both iterate and fan out over items. Fan-out is a width fixed up front; iteration is a depth decided round by round.',
        nodeId: node.id, path: `nodes.${index}.config.items` });
    }
    return issues;
  });
}

export function workflowCallIterationIssues(definition: WorkflowDefinition): WorkflowValidationIssue[] {
  return definition.nodes.flatMap((node, index) => node.type === 'workflow-call' && node.config.iterate
    && !definition.edges.some((edge) => edge.from.nodeId === node.id && edge.from.port === ITERATION_EXHAUSTED_PORT)
    ? [{
        code: 'iteration-missing-exhausted-route',
        message: `A Workflow Call that iterates must wire its ${ITERATION_EXHAUSTED_PORT} port, so a loop that spends every round still has somewhere to go.`,
        nodeId: node.id,
        path: `nodes.${index}.config.iterate`,
      }]
    : []);
}
