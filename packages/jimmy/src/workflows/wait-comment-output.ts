import { formatAttachmentRef } from "./attachment-ref.js";
import type { WorkflowNode, WorkflowNodeOutput } from "./model.js";

/**
 * What a `todo-comment` Wait completes with. Its own module because the two
 * endings have to agree: `attachments` rides both, so a downstream binding on
 * it resolves whether the operator answered or the deadline did — a Condition
 * on the timeout path must not throw `missing-value`.
 */

/** A parked Wait hands the operator's reply straight into downstream prompts, so
 *  a pasted essay must not become the run's whole context. */
const MAX_WAIT_COMMENT_CHARS = 4_000;

function boundedComment(body: string): string {
  return body.length <= MAX_WAIT_COMMENT_CHARS ? body : `${body.slice(0, MAX_WAIT_COMMENT_CHARS)}\n… (truncated)`;
}

/** The operator answered. Their files come through as refs — never bytes, so
 *  nothing binary ever enters the run. */
export function commentReplyOutput(
  todoId: string,
  comment: { id: string; body: string; attachments: ReadonlyArray<{ id: string; mime: string }> },
): WorkflowNodeOutput {
  const body = boundedComment(comment.body);
  return { text: body, fields: {
    outcome: "reply",
    commentId: comment.id,
    comment: body,
    attachments: comment.attachments.map((item) => formatAttachmentRef({ ...item, workItemId: todoId })),
  } };
}

/** A Wait that reaches its own `resumeAt`. Only `todo-comment` distinguishes
 *  the two ways it can end, and it says so on the way out. */
export function waitDueOutput(node: WorkflowNode | undefined): WorkflowNodeOutput {
  return node?.type === "wait" && node.config.mode === "todo-comment"
    ? { text: "", fields: { outcome: "timeout", attachments: [] } }
    : { text: "", fields: {} };
}
