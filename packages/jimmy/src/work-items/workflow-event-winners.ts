/** work-items shim — with no Todo event claims there are never later winners. */
export function startedAfterEvent(_eventId: string): Map<string, string> {
  return new Map();
}
