import type { WorkflowRepository } from "./repository.js";
import type { WorkflowAttemptRecord, WorkflowRunDetail } from "./runtime.js";
import type { WorkflowSessionExecutor } from "./session-executor.js";

/**
 * The time half of "this attempt has not submitted anything yet": three rungs at
 * 5, 15 and 30 minutes, each one a real turn in the attempt's own session, and
 * after the last one the runner settles the attempt as `workflow-no-output`.
 *
 * A rung is only spent on a session that is idle with no running children. A
 * busy one is deferred five minutes without consuming a rung, because the point
 * is to wake a stalled step, not to interrupt a working one.
 */
const REMINDER_TEXT = "Workflow reminder: if you have finished this step, call `workflow_submit_output` now. If you are still working or waiting on delegated work, continue.";
const FINAL_REMINDER_TEXT = `${REMINDER_TEXT} This is the final reminder. If you genuinely need more time, call \`workflow_extend_deadline\`.`;

export const REMINDER_RUNGS_MINUTES = [5, 15, 30] as const;

export function addMinutes(at: string, minutes: number): string {
  return new Date(Date.parse(at) + minutes * 60_000).toISOString();
}

export function hasWorkflowOutputBlock(text: string): boolean {
  return /(?:^|\n)```jinn-output[ \t]*(?:\r?\n|$)/.test(text);
}

/** What the sweep borrows from the runner: the two collaborators it reads, plus
 *  the run lookup and change notification the runner owns privately. */
export interface ReminderLadderPorts {
  repository: WorkflowRepository;
  executor: WorkflowSessionExecutor;
  activeRun: (attempt: WorkflowAttemptRecord) => WorkflowRunDetail;
  changed: (run: WorkflowRunDetail) => void;
}

/** A rung is owed only to a running attempt that still holds a session and whose
 *  scheduled moment has actually arrived. */
function isDue(attempt: WorkflowAttemptRecord | null, now: string): attempt is DueAttempt {
  return Boolean(attempt && attempt.status === "running" && attempt.sessionId
    && attempt.nextReminderAt && attempt.nextReminderAt <= now);
}

type DueAttempt = WorkflowAttemptRecord & { sessionId: string; nextReminderAt: string };

/** The third rung is the last one, so it carries the deadline-extension escape.
 *  An output block that failed to parse is quoted back ahead of it. */
function rungText(attempt: WorkflowAttemptRecord, rung: number): string {
  const reminder = rung === 3 ? FINAL_REMINDER_TEXT : REMINDER_TEXT;
  return attempt.pendingOutputError
    ? `Your previous output block was invalid: ${attempt.pendingOutputError}\n\n${reminder}`
    : reminder;
}

export async function remindDueAttempts(now: string, ports: ReminderLadderPorts): Promise<void> {
  for (const due of ports.repository.listDueReminders(now, 100)) {
    const current = ports.repository.getAttempt(due.runId, due.nodeId, due.attempt);
    if (!isDue(current, now)) continue;
    const run = ports.activeRun(current);
    const state = ports.executor.attemptState(current.sessionId);
    if (!state?.idle || state.runningChildren > 0) {
      ports.repository.mutateRun(run.id, run.revision, (tx) => {
        tx.setAttemptReminder(current.nodeId, current.attempt, { nextReminderAt: addMinutes(now, 5) });
      });
      ports.changed(run);
      continue;
    }
    const rung = current.remindersSent + 1;
    await ports.executor.remind({ sessionId: current.sessionId, text: rungText(current, rung) });
    const refreshed = ports.activeRun(current);
    const latest = refreshed.attempts.find((candidate) => candidate.nodeId === current.nodeId
      && candidate.attempt === current.attempt);
    if (!latest || latest.status !== "running") continue;
    ports.repository.mutateRun(refreshed.id, refreshed.revision, (tx) => {
      tx.setAttemptReminder(latest.nodeId, latest.attempt, {
        remindersSent: rung,
        nextReminderAt: null,
        pendingOutputError: null,
      });
    });
    ports.changed(refreshed);
  }
}
