import type { Session, WorkflowAttemptInterruptionCause } from "../shared/types.js";

export const USER_MESSAGE_INTERRUPTION_REASON = "Interrupted: new message received";

/** Prefer the turn-fenced boundary marker; retain error matching for legacy rows. */
export function workflowAttemptInterruptionCause(
  error: string | null | undefined,
  session?: Pick<Session, "attemptInterruptionCause" | "attemptInterruptionTurn">,
  turn?: number,
): WorkflowAttemptInterruptionCause {
  if (
    session?.attemptInterruptionCause
    && session.attemptInterruptionTurn === turn
  ) {
    return session.attemptInterruptionCause;
  }
  return error === USER_MESSAGE_INTERRUPTION_REASON
    ? "user-message"
    : "attempt-stop";
}

export function isDurableWorkflowUserMessageInterruption(
  session: Pick<Session, "attemptInterruptionCause" | "attemptInterruptionTurn">,
  turn: number,
): boolean {
  return session.attemptInterruptionCause === "user-message"
    && session.attemptInterruptionTurn === turn;
}
