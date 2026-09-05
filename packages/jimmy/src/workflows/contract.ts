import { ATTACHMENT_REF_SHAPE } from "./attachment-ref.js";
import type { EmployeeNode } from "./model.js";

function tableText(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

export function buildNodeContract(
  node: EmployeeNode,
  upstream: Array<{ nodeId: string; sessionId?: string }>,
): string {
  const lines = ["## Workflow step completion contract"];
  if (node.config.output) {
    lines.push(
      "",
      "| Field | Type | Required | Description |",
      "| --- | --- | --- | --- |",
    );
    for (const [name, field] of Object.entries(node.config.output.fields)) {
      lines.push(`| \`${name}\` | ${field.type} | ${field.required ? "yes" : "no"} | ${
        field.description ? tableText(field.description) : ""
      } |`);
    }
    if (Object.values(node.config.output.fields).some((field) => field.type.startsWith("attachment"))) {
      lines.push(
        "",
        `An attachment field takes a reference, never bytes: attach the file to this Todo with \`attach_to_work_item\`, then submit the \`${ATTACHMENT_REF_SHAPE}\` ref it returns.`,
      );
    }
    lines.push(
      "",
      "When your work is truly finished, call the `workflow_submit_output` tool with these fields.",
    );
  }
  lines.push(
    "",
    "Calling `workflow_submit_output` is what completes this workflow step; ending your turn does not. If you delegate to other employees and are waiting on them, end your turn; you will be woken when they reply.",
  );
  const readableSessions = upstream.filter(
    (entry): entry is { nodeId: string; sessionId: string } => Boolean(entry.sessionId),
  );
  if (readableSessions.length > 0) {
    lines.push(
      "",
      "Upstream step sessions you may read via jinn session tools (`read_session`, `get_message_context`):",
      ...readableSessions.map((entry) => `- \`${entry.nodeId}: ${entry.sessionId}\``),
    );
  }
  lines.push(
    "",
    "If the `workflow_submit_output` tool is unavailable, end your final message with a ```jinn-output fenced block containing the JSON fields.",
  );
  return lines.join("\n");
}
