import { logger } from "../shared/logger.js";
import { gitLandingEvidence } from "./git-landing-evidence.js";
import type { EndNode } from "./model.js";
import type { WorkflowApprovalRecord, WorkflowRunDetail } from "./runtime.js";
import type { WorkflowTodoLifecycle } from "./todo-ports.js";

/**
 * What a run that reached a success End owes its bound Todo.
 *
 * Reaching one used to be proof enough: the runner closed the Todo whenever a
 * success End completed behind an approved operator-only gate, without ever
 * asking what the run had produced. A landing phase that aborted on five rebase
 * conflicts reported "nothing merged" and satisfied that exactly as well as a
 * real merge did, because its node contract asked for a summary and not for a
 * commit — so the board read `done` for work that never left its branch.
 *
 * A success End may now declare what has to be true first. Ends that declare
 * nothing behave exactly as before: most Todo-closing Workflows land nothing,
 * and a demand they cannot meet would close nothing at all.
 */

/** Proof that a commit a run reported really reached the canonical branch. A port so the rule
 *  can be judged without a repository; the default shells git. */
export interface WorkflowLandingVerifier {
  mergedIntoMain(input: { commit: string; checkout: string }): Promise<boolean>;
}

/** Why a landing cannot be believed, and the End that demanded it. */
export interface WorkflowLandingShortfall {
  nodeId: string;
  reason: string;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** Long enough to recognise what a phase reported, short enough to stay a comment. */
const MAX_QUOTED = 80;

function completedSuccessEnds(run: WorkflowRunDetail): EndNode[] {
  return run.definition.nodes.filter((node): node is EndNode => node.type === "end"
    && node.config.result === "success"
    && run.nodeRuns.some((runtime) => runtime.nodeId === node.id && runtime.status === "completed"));
}

export function reachedSuccessEnd(run: WorkflowRunDetail): boolean {
  return completedSuccessEnds(run).length > 0;
}

/** What a node reported for one of its output fields, trimmed — empty for a node
 *  that never ran, never completed, or left the field out. */
function reported(run: WorkflowRunDetail, nodeId: string, field: string): string {
  const value = run.nodeRuns.find((runtime) => runtime.nodeId === nodeId)?.output?.fields[field];
  return typeof value === "string" ? value.trim() : "";
}

function quoted(value: string): string {
  return value.length > MAX_QUOTED ? `${value.slice(0, MAX_QUOTED)}…` : value;
}

/** `undefined` when the question could not be put. Unproven delivery must block
 *  closure just as firmly as disproven delivery. */
async function onMain(verifier: WorkflowLandingVerifier, commit: string, checkout: string): Promise<boolean | undefined> {
  try {
    return await verifier.mergedIntoMain({ commit, checkout });
  } catch (error) {
    logger.warn(`Workflow could not check whether ${commit} is on the canonical branch in ${checkout}: `
      + `${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Why a completed run must NOT close its Todo, or `undefined` when every success
 * End it reached is satisfied.
 *
 * A missing field, a blank one and a value that is not a SHA are the same
 * failure in different clothes: the phase landed nothing and said so in the
 * only place it had. A declared checkout makes canonical delivery mandatory;
 * an unavailable repository or remote is failed proof, never permission to close.
 */
export async function landingShortfall(run: WorkflowRunDetail,
  verifier: WorkflowLandingVerifier = gitLandingEvidence): Promise<WorkflowLandingShortfall | undefined> {
  for (const end of completedSuccessEnds(run)) {
    const requires = end.config.requires;
    if (!requires) continue;
    const commit = reported(run, requires.nodeId, requires.field);
    if (commit === "") {
      return { nodeId: end.id, reason: `Step ${requires.nodeId} reported no ${requires.field}, so nothing was landed.` };
    }
    if (!COMMIT_SHA.test(commit)) {
      return { nodeId: end.id,
        reason: `Step ${requires.nodeId} reported ${requires.field} "${quoted(commit)}", which is not a commit SHA.` };
    }
    const checkout = requires.commitIn ? reported(run, requires.commitIn.nodeId, requires.commitIn.field) : "";
    if (checkout !== "") {
      const delivered = await onMain(verifier, commit, checkout);
      if (delivered === false) {
        return { nodeId: end.id,
          reason: `Commit ${commit} reported by step ${requires.nodeId} is not on the canonical branch.` };
      }
      if (delivered === undefined) {
        return { nodeId: end.id,
          reason: `Commit ${commit} reported by step ${requires.nodeId} could not be verified on the canonical branch.` };
      }
    }
  }
  return undefined;
}

/** The operator-only gate whose approval authorized this run to close its Todo. */
function approvedGate(run: WorkflowRunDetail): WorkflowApprovalRecord | undefined {
  return run.approvals.find((approval) => {
    const authored = run.definition.nodes.find((node) => node.id === approval.nodeId);
    const runtime = run.nodeRuns.find((node) => node.nodeId === approval.nodeId);
    return authored?.type === "approval" && authored.config.operatorOnly === true
      && runtime?.status === "completed" && approval.status === "approved"
      && approval.decidedBy !== undefined && approval.decidedAt !== undefined;
  });
}

/** Close the bound Todo of a run that completed behind an approved operator-only
 *  gate. Best-effort like every other Todo-side write from a run: the Todo may
 *  have been closed or deleted since the run started. */
export function completeBoundTodo(lifecycle: WorkflowTodoLifecycle | undefined, run: WorkflowRunDetail): void {
  const todoId = run.trigger.todoId;
  const gate = approvedGate(run);
  if (!todoId || !lifecycle || !gate?.decidedBy || !gate.decidedAt) return;
  try {
    lifecycle.complete({ todoId, workflowId: run.workflowId, runId: run.id, nodeId: gate.nodeId,
      approvedBy: gate.decidedBy, approvedAt: gate.decidedAt });
  } catch (error) {
    logger.warn(`Workflow run ${run.id} could not complete Todo ${todoId}: `
      + `${error instanceof Error ? error.message : String(error)}`);
  }
}
