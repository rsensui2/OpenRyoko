/** work-items shim — with no Todo event log there is no owning workflow. */
export function owningWorkflowId(_todoId: string): string | undefined {
  return undefined;
}
