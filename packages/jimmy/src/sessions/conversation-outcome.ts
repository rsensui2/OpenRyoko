import type { EngineResult, Session, SessionGoal } from "../shared/types.js";

export type ConversationOutcome = "awaiting_input" | "completed";

interface ConversationOutcomeInput {
  engine: string;
  beforeGoal?: SessionGoal | null;
  session?: Pick<Session, "goal" | "source" | "workflowProvenance"> | null;
  result: Pick<EngineResult, "error">;
  deliveredReply: boolean;
  interrupted?: boolean;
}

/**
 * The gateway currently owns structured goal assessment only for Codex.
 * Claude's native goal state and unstructured answer text are not evidence.
 * Compare the per-attempt snapshot so an old completed/waiting goal cannot be
 * attributed to a later untracked answer or a fallback engine that skipped it.
 */
export function conversationOutcome(input: ConversationOutcomeInput): ConversationOutcome | undefined {
  if (input.engine !== "codex" || !input.deliveredReply || input.result.error || input.interrupted) return;
  if (!input.session || input.session.source === "cron" || input.session.workflowProvenance) return;
  const goal = input.session.goal;
  if (!goal) return;
  const previous = input.beforeGoal;
  if (previous?.id === goal.id && previous.status === goal.status && previous.updatedAt === goal.updatedAt &&
      previous.waitingFor === goal.waitingFor) return;
  if ((goal.status === "waiting" || goal.status === "blocked") && goal.waitingFor === "user") return "awaiting_input";
  if (goal.status === "complete" || goal.status === "cancelled") return "completed";
  return;
}
