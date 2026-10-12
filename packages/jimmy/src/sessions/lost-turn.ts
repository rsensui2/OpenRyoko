/**
 * Terminal receipt for a turn nobody is left to finish.
 *
 * A session can stay at status:"running" after its runner has gone — the web
 * runner writes no receipt for a turn the gateway interrupted, on the
 * understanding that a newer message's turn follows, and sometimes none does;
 * and a queue row cancelled before it ran never reaches a runner at all.
 * (An engine process that dies mid-turn is no longer one of these: the runner
 * settles it as a failed turn itself — see settleUnrequestedStop.) Nothing in
 * the process will ever settle such a session, so the status reconciler does
 * it through this function.
 *
 * It honours the same contract as the runners' own completion
 * (SessionManager.runSession / runWebSession): persist the outcome with its
 * reason, wake the parent session, report the completion. Writing a bare
 * "idle" here instead made a lost turn read as a success, and a parent waiting
 * on the child was never woken.
 */
import type { Session } from "../shared/types.js";
import { notifyParentSession } from "./callbacks.js";
import { updateSession } from "./registry.js";

/** Why the turn has no result. Reaches the operator (lastError), the dashboard
 *  (completion event) and the parent session (notification), so it says what
 *  to do next as well as what happened. */
export const LOST_TURN_ERROR =
  "Interrupted: the engine turn ended without a result (the engine process was lost, or its completion never arrived). "
  + "The last request was not answered — send it again to retry.";

export interface SettleLostTurnInput {
  session: Session;
  /** Wall-clock instant of the settle, in epoch milliseconds. */
  now: number;
  /** The session employee's `alwaysNotify` setting, when it has one. */
  alwaysNotify?: boolean;
  emit: (event: string, payload: unknown) => void;
}

/**
 * Settle a lost turn. The status is "interrupted", not "error": the engine
 * session and transcript are intact, so the next message resumes it, and a
 * parent that lost its own turn keeps receiving its children's completions
 * (callbacks do not wake a parent that is in "error").
 */
export function settleLostTurn(input: SettleLostTurnInput): Session | undefined {
  const settled = updateSession(input.session.id, {
    status: "interrupted",
    lastActivity: new Date(input.now).toISOString(),
    lastError: LOST_TURN_ERROR,
  });
  if (!settled) return undefined; // deleted while the sweep was looking at it
  notifyParentSession(settled, { error: LOST_TURN_ERROR }, { alwaysNotify: input.alwaysNotify });
  input.emit("session:completed", {
    sessionId: settled.id,
    employee: settled.employee ?? undefined,
    title: settled.title,
    result: null,
    error: LOST_TURN_ERROR,
  });
  return settled;
}
