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
 * `error` is a failed turn and `idle` a finished one. `running` means a wake-up
 * queued behind the cron turn (child-session callback, detached job) has
 * already started: starting a turn does not touch `lastError`, so that field
 * still holds what the cron turn left — a reason if it failed, nothing if it
 * finished. `waiting` and `interrupted` are a turn that never settled.
 */
export function sessionRunFailure(session: Session | undefined): string | null {
  if (!session || session.status === "idle") return null;
  const reason = recordedReason(session);
  if (session.status === "error") return reason || "Session ended in error without reporting a reason";
  if (session.status === "running") return reason || null;
  return reason || `Session did not settle (status: ${session.status})`;
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
