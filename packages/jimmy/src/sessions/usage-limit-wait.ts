/**
 * When a parked turn expects its usage limit to reset.
 *
 * A turn that meets a usage limit with no engine to switch to is parked: its
 * session goes to "waiting", and the runner notes the reset it is waiting for
 * in `lastError`, as an ISO time ("<engine> usage limit — resumes <ISO>").
 * The wait itself is a loop in the gateway process, so that note is all that
 * is left of it on disk. This is the one place that reads it.
 */
import type { Session } from "../shared/types.js";

const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/;

/** The reset (ISO) the usage-limit wait of a "waiting" session expects, when
 *  that wait knows it. Undefined for a session that is not waiting. */
export function usageLimitWaitResetsAt(session: Pick<Session, "status" | "lastError">): string | undefined {
  if (session.status !== "waiting") return undefined;
  return session.lastError?.match(ISO_TIME)?.[0];
}
