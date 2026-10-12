import type { Session } from "../shared/types.js";
import { getSession } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";
import { redactText } from "../shared/redact.js";

const MAX_REASON_LENGTH = 1000;

/** `lastError` is raw engine output: it can be a whole reply and may echo a
 *  credential, and the run log and the alert are new places for it to land. */
function recordedReason(session: Session): string {
  return redactText(session.lastError ?? "").trim().slice(0, MAX_REASON_LENGTH);
}

/**
 * Why the turn a cron fire just ran did not end in a result, or null when it
 * did. Meant for the session row as it reads the moment route() returns.
 *
 * A recorded `lastError` is a failure whatever the status says: a turn that
 * ends cleanly resets it to null, and a reply that could not be delivered can
 * leave the session `idle` with the failure noted only there. The wording is
 * never inspected.
 *
 * With nothing recorded, `idle` is a finished turn. So is `running`: it means a
 * wake-up queued behind the cron turn (child-session callback, detached job)
 * has already started, and starting a turn does not touch `lastError`. `error`,
 * `waiting` and `interrupted` are failures that left no reason behind.
 */
export function sessionRunFailure(session: Session | undefined): string | null {
  if (!session) return null;
  const reason = recordedReason(session);
  if (reason) return reason;
  if (session.status === "idle" || session.status === "running") return null;
  if (session.status === "error") return "Session ended in error without reporting a reason";
  return `Session did not settle (status: ${session.status})`;
}

/** Failure of the session route() reported for this fire. An unreadable
 *  registry must not fail a run that otherwise worked, so it reads as none. */
export function settledRunFailure(sessionId: string | null | undefined, jobName: string): string | null {
  if (!sessionId) return null;
  try {
    return sessionRunFailure(getSession(sessionId));
  } catch (error) {
    logger.warn(`Cron job "${jobName}" could not read its settled session: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
