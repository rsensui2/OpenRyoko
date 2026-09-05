/**
 * The correlation key a workflow writes onto a Todo approval when it mirrors a
 * parked gate there. Its own module because both sides of the loop need it: the
 * runner formats it, and the Todo layer reads it to tell a mirrored gate (whose
 * consequences the RUN owns) apart from a native Todo review gate.
 */

/** Stable correlation key tying a Todo approval back to the node that parked. */
export function todoApprovalRef(run: { workflowId: string; id: string }, nodeId: string): string {
  return `workflow:${run.workflowId}:${run.id}:${nodeId}`;
}

export function parseTodoApprovalRef(ref: string | null): { workflowId: string; runId: string; nodeId: string } | null {
  const parts = ref?.split(":") ?? [];
  if (parts.length !== 4 || parts[0] !== "workflow") return null;
  return { workflowId: parts[1]!, runId: parts[2]!, nodeId: parts[3]! };
}
