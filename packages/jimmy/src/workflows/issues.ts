/**
 * The one shape every Workflow authoring surface reports a rejection with, and
 * the one way it is rendered as text. A bare "Workflow definition is invalid."
 * makes a large graph unauthorable — the author has to bisect it by hand — so
 * HTTP returns these structured, and MCP and the CLI render them inline.
 */
export interface WorkflowValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  path?: string;
}

/** Beyond this the list stops being a hint and starts being a wall of text. */
const MAX_RENDERED_ISSUES = 10;

function locator(issue: WorkflowValidationIssue): string {
  if (issue.nodeId) return ` (node ${issue.nodeId})`;
  if (issue.edgeId) return ` (edge ${issue.edgeId})`;
  return issue.path ? ` (${issue.path})` : '';
}

/** `message` followed by one bullet per issue. Returns `message` unchanged when
 *  the failure carried no issues, so every caller can render it the same way. */
export function describeWorkflowIssues(message: string, issues: readonly WorkflowValidationIssue[] | undefined): string {
  if (!issues?.length) return message;
  const shown = issues.slice(0, MAX_RENDERED_ISSUES)
    .map((issue) => `\n- ${issue.code}${locator(issue)}: ${issue.message}`);
  const hidden = issues.length - shown.length;
  return `${message}${shown.join('')}${hidden > 0 ? `\n- ... and ${hidden} more.` : ''}`;
}

/** Read an `issues` array off an untrusted error envelope (HTTP body, MCP
 *  response), keeping only entries that carry a usable code and message. */
export function parseWorkflowIssues(value: unknown): WorkflowValidationIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues = value.flatMap((entry): WorkflowValidationIssue[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { code, message, nodeId, edgeId, path } = entry as Record<string, unknown>;
    if (typeof code !== 'string' || typeof message !== 'string') return [];
    return [{
      code,
      message,
      ...(typeof nodeId === 'string' ? { nodeId } : {}),
      ...(typeof edgeId === 'string' ? { edgeId } : {}),
      ...(typeof path === 'string' ? { path } : {}),
    }];
  });
  return issues.length > 0 ? issues : undefined;
}
