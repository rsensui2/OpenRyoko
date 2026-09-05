/**
 * Carrying an engine session from one workflow attempt to the next.
 *
 * Every attempt gets its own session row — the workflow bookkeeping is keyed
 * on that one-to-one mapping — and a fresh row resumes nothing, so a rework
 * round re-derives all the context its predecessor already holds. Seeding the
 * new row with the previous attempt's engine session id before its first turn
 * makes the ordinary resume path fire instead.
 *
 * OpenRyoko adaptation: the fork's registry tracks a single `engineSessionId`
 * per session (no per-engine ref map, no codex rollout store), so continuation
 * is offered only when the engines match — and codex, whose threads upstream
 * carries by copying rollout files this fork does not track, always dispatches
 * cold rather than resuming a thread that may no longer resolve.
 */

import type { Session, WorkflowAttemptContinuation } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { getSession, updateSession } from "./registry.js";

/**
 * The engine thread `sessionId` still holds and a new session could pick up, or
 * null. Null covers every reason a candidate is unusable: the session is gone,
 * it ran on a different engine, it never recorded a thread, or the engine is
 * codex (no rollout tracking in this fork — see the module note).
 */
export function resumableEngineSession(sessionId: string, engine: string): string | null {
  const session = getSession(sessionId);
  if (!session || session.engine !== engine) return null;
  if (engine === "codex") return null;
  return session.engineSessionId || null;
}

/**
 * Seed a freshly created attempt session with the engine session it continues.
 * A no-op once the session already carries an engine session id, so replaying
 * a dispatch after a crash never rewinds a turn that has since run.
 */
export function continueWorkflowAttemptSession(
  session: Session,
  continueFrom: WorkflowAttemptContinuation | undefined,
): Session {
  if (!continueFrom || session.engineSessionId) return session;
  const { engine, engineSessionId, sourceSessionId } = continueFrom;
  if (engine !== session.engine || engine === "codex") return session;
  logger.info(`Session ${session.id} continues ${engine} session ${engineSessionId} from session ${sourceSessionId}.`);
  return updateSession(session.id, { engineSessionId }) ?? session;
}
