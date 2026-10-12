/**
 * The failure of an engine run that stopped without being asked to — how it is
 * worded, and how a session that failed that way is recognised afterwards.
 *
 * settleUnrequestedStop() (engine-fallback.ts) turns such a run into a failed
 * one: the engine's process died, or its own turn deadline ran out. The session
 * ends up in "error" like any other failure, but it is not like the others. A
 * session stopped by a usage limit or a lost login fails again on its next
 * turn; this one has its engine session and its transcript intact, and its next
 * turn simply starts a new process.
 *
 * Whoever has to tell the two apart asks here. This module is the one place
 * that knows the wording, and it depends on nothing, so that anything — the
 * callback that wakes a parent for its children — can ask without pulling in
 * the engine runner.
 */
import type { Session } from "../shared/types.js";

const STOPPED_UNEXPECTEDLY = " stopped unexpectedly: ";
/** What the wording starts with: the engine's name, and nothing before it. */
const ENGINE_NAME = /^[\w.-]+$/;

/** The error a run that stopped without being asked to is settled with. */
export function unrequestedStopError(engineName: string, detail: string): string {
  return `${engineName}${STOPPED_UNEXPECTEDLY}${detail}`;
}

/**
 * True while a session is in the error its last turn was settled with because
 * its engine stopped without being asked to. The next turn that settles — or
 * anything else that rewrites lastError — ends it.
 */
export function failedByUnrequestedStop(session: Pick<Session, "status" | "lastError">): boolean {
  if (session.status !== "error" || !session.lastError) return false;
  const at = session.lastError.indexOf(STOPPED_UNEXPECTEDLY);
  return at > 0 && ENGINE_NAME.test(session.lastError.slice(0, at));
}
