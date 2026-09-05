export interface UrlSessionSelection {
  appliedMarker: string | null
  sessionIdToSelect: string | null
}

export function consumeUrlSessionSelection(
  requestedSessionId: string | null,
  appliedMarker: string | null,
  selectedSessionId: string | null,
): UrlSessionSelection {
  if (!requestedSessionId) return { appliedMarker: null, sessionIdToSelect: null }
  if (requestedSessionId === appliedMarker) {
    return { appliedMarker, sessionIdToSelect: null }
  }
  return {
    appliedMarker: requestedSessionId,
    sessionIdToSelect: requestedSessionId === selectedSessionId ? null : requestedSessionId,
  }
}
