import { getSessionBySessionKey } from "../sessions/registry.js";
import { usageLimitWaitResetsAt } from "../sessions/usage-limit-wait.js";
import { logger } from "../shared/logger.js";

/**
 * Fires that have been handed to the session manager and have not come back,
 * by job, so that a new fire can tell whether an earlier one of the same job is
 * parked on a usage limit.
 *
 * Kept in memory on purpose. A fire that was waiting when the gateway went down
 * is not waiting any more — nothing in the new process will resume it, though
 * its session row may still say so — and a record that outlived the process
 * would hold every later fire of the job back for good.
 */
const inFlight = new Map<string, ReadonlySet<string>>();

/** Note a fire of `jobId` running under `sessionKey`. Call what it returns once
 *  the fire has come back, however it ended. */
export function trackFire(jobId: string, sessionKey: string): () => void {
  inFlight.set(jobId, new Set([...(inFlight.get(jobId) ?? []), sessionKey]));
  return () => {
    const rest = [...(inFlight.get(jobId) ?? [])].filter((key) => key !== sessionKey);
    if (rest.length > 0) inFlight.set(jobId, new Set(rest));
    else inFlight.delete(jobId);
  };
}

export interface WaitingFire {
  /** The session that is waiting for the limit to reset. */
  waitingSessionId: string;
  /** ISO. When that wait expects the reset, if it knows. */
  resetsAt?: string;
}

/**
 * The fire of `jobId` that is parked waiting for a usage limit to reset, if one
 * is. `waiting` is the status of exactly that: a turn that met a usage limit
 * with no engine to switch to. A fire that is merely still running is not
 * reported — a long job overlapping its next fire is no business of this — and
 * a registry that cannot be read reports nothing, so it never holds a fire back.
 */
export function fireWaitingOnUsageLimit(jobId: string): WaitingFire | null {
  for (const sessionKey of inFlight.get(jobId) ?? []) {
    try {
      const session = getSessionBySessionKey(sessionKey);
      if (session?.status !== "waiting") continue;
      const resetsAt = usageLimitWaitResetsAt(session);
      return { waitingSessionId: session.id, ...(resetsAt ? { resetsAt } : {}) };
    } catch (error) {
      logger.warn(`Could not read the session of an earlier cron fire (${sessionKey}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}
