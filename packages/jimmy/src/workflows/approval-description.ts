import { logger } from "../shared/logger.js";
import { interpolateWorkflowPrompt } from "./bindings.js";
import type { ApprovalNode } from "./model.js";
import { bindingContext } from "./node-dispatch.js";
import type { WorkflowRunDetail } from "./runtime.js";

/** What the operator reads at a mirrored gate. Interpolated like any other
 *  authored string, so an upstream step's output — a screenshot ref included —
 *  can reach the gate the decision is actually made at. A template that cannot
 *  resolve must not sink a gate that is already parked: the raw text still
 *  mirrors, and the gate is still decidable. */
export function approvalDescription(run: WorkflowRunDetail, node: ApprovalNode): string {
  try {
    return interpolateWorkflowPrompt(node.config.description, bindingContext(run));
  } catch (error) {
    logger.warn(`Workflow run ${run.id} could not interpolate the description of approval gate ${node.id}: `
      + `${error instanceof Error ? error.message : String(error)}`);
    return node.config.description;
  }
}
