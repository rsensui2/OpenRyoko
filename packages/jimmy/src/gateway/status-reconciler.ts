/**
 * Status reconciler — unsticks sessions stuck at status:"running" with no live
 * turn. (Ported from upstream jinn 0.20.0.)
 *
 * A completion event can be lost (process crash between engine settle and
 * status persistence, a thrown error in the delivery path, a lost hook) and
 * the session then shows "running" forever: the dashboard spinner never
 * clears and new messages queue behind a phantom turn. This sweep is the
 * backstop: a "running" session whose lastActivity is stale AND whose engine
 * reports no live turn AND that no runner in this process still owns is
 * settled — but only on the SECOND consecutive sweep that finds it stuck, so a
 * benign turn-boundary race (process exited, final status not yet persisted)
 * never triggers it.
 *
 * Settling means reporting the turn as lost (see sessions/lost-turn.ts), not
 * resetting to idle: a hand-written "idle" made a dead turn read as a success
 * and left a parent session waiting on a child that would never report.
 */
import type { Engine, Session } from "../shared/types.js";
import { getMessagePage, listSessions, updateSession } from "../sessions/registry.js";
import { settleLostTurn } from "../sessions/lost-turn.js";
import { logger } from "../shared/logger.js";

const DEFAULT_INTERVAL_MS = 15_000;
/** A "running" session whose lastActivity is older than this has no live turn
 *  heartbeat driving it. Correctness does NOT hinge on this value — a stale
 *  session is still probed against the engine's live-turn state below; this
 *  only gates how soon a lost completion is noticed. */
const DEFAULT_STALE_MS = 45_000;

export interface StatusReconcilerDeps {
  engines: Map<string, Engine>;
  emit: (event: string, payload: unknown) => void;
  /** True while a runner in this process still holds the session's queue slot.
   *  That runner writes the terminal receipt itself (its engine waits are
   *  bounded by the engine's own watchdogs), so the sweep leaves it alone. The
   *  engine probe alone cannot tell: a connector turn has no heartbeat, and it
   *  has no engine turn while it posts its reply, reviews a goal, or runs on
   *  the SSH fallback of the interactive engine. */
  isOwned?: (session: Session) => boolean;
  /** The session employee's `alwaysNotify` setting, so a settled turn wakes
   *  the parent under the same rule the runners apply. */
  alwaysNotifyFor?: (session: Session) => boolean | undefined;
  intervalMs?: number;
  staleMs?: number;
  /** Test override. */
  now?: () => number;
  /** Carry-over between sweeps: sessions seen stuck once. A session is only
   *  settled on the SECOND consecutive sweep that finds it stuck. Created by
   *  startStatusReconciler; tests may pass their own. */
  pendingStuck?: Set<string>;
}

/** Same live-turn probe as the API status path: interactive engines expose
 *  isTurnRunning (warm-but-idle PTYs must not count); headless engines
 *  approximate with isAlive; an unknown engine cannot have a live turn. */
function hasLiveTurn(engine: Engine | undefined, sessionId: string): boolean {
  if (!engine) return false;
  if ("isTurnRunning" in engine) {
    return (engine as unknown as { isTurnRunning(id: string): boolean }).isTurnRunning(sessionId);
  }
  return typeof (engine as { isAlive?: (id: string) => boolean }).isAlive === "function"
    ? (engine as unknown as { isAlive(id: string): boolean }).isAlive(sessionId)
    : false;
}

/** The newest transcript entry is the assistant's reply: the turn did produce
 *  its answer, and whoever recorded it already delivered it (the orphan-Stop
 *  path wakes the parent itself but leaves a "running" status untouched). */
function replyAlreadyLanded(sessionId: string): boolean {
  return getMessagePage(sessionId, { limit: 1 }).messages.at(-1)?.role === "assistant";
}

/** Clear a phantom "running" status with nothing left to report. */
function resetToIdle(session: Session, now: number, emit: StatusReconcilerDeps["emit"]): void {
  updateSession(session.id, {
    status: "idle",
    lastActivity: new Date(now).toISOString(),
    lastError: null,
  });
  emit("session:completed", {
    sessionId: session.id,
    employee: session.employee ?? undefined,
    title: session.title,
    result: null,
    error: null,
  });
}

/** Settle one session confirmed stuck. Returns what was done, for the log. */
function settleStuck(session: Session, now: number, deps: StatusReconcilerDeps): string {
  // Workflow attempts carry their own terminal receipts and reminder ladder;
  // the workflow runtime re-drives an idle attempt, so their reset is unchanged.
  if (session.workflowProvenance?.kind === "phase") {
    resetToIdle(session, now, deps.emit);
    return "reset to idle (workflow attempt)";
  }
  if (replyAlreadyLanded(session.id)) {
    resetToIdle(session, now, deps.emit);
    return "reset to idle (its reply was already recorded)";
  }
  settleLostTurn({ session, now, alwaysNotify: deps.alwaysNotifyFor?.(session), emit: deps.emit });
  return "settled as a lost turn";
}

/** One sweep: settle sessions stuck at status:"running" with no live turn.
 *  Returns the number of sessions settled. Exported for tests.
 *
 *  Synchronous on purpose: the stuck check and the settle run in one tick, so
 *  no runner can start or finish a turn in between. */
export function sweepOnce(deps: StatusReconcilerDeps): number {
  const now = deps.now?.() ?? Date.now();
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  const pending = deps.pendingStuck;
  const stuckNow = new Set<string>();
  let fixed = 0;
  try {
    for (const session of listSessions({ status: "running" })) {
      const last = session.lastActivity ? new Date(session.lastActivity).getTime() : 0;
      const staleFor = now - last;
      if (staleFor < staleMs) continue; // fresh heartbeat
      if (hasLiveTurn(deps.engines.get(session.engine), session.id)) continue;
      if (deps.isOwned?.(session)) continue; // its runner is still there
      // Session qualifies as stuck: stale heartbeat + no live turn + no runner.
      if (pending && !pending.has(session.id)) {
        stuckNow.add(session.id);
        continue; // confirm on the next sweep — could be a turn-boundary race
      }
      const outcome = settleStuck(session, now, deps);
      logger.warn(
        `[reconciler] session ${session.id} (${session.engine}) was stuck status=running with no live turn ` +
        `(heartbeat stale ${Math.round(staleFor / 1000)}s) — ${outcome}`,
      );
      fixed++;
    }
  } finally {
    // "Consecutive" is literal: a mark survives only into the very next sweep.
    // A session that recovered (fresh heartbeat, live turn, owned again), left
    // the running list, or was just settled starts over from an unmarked state.
    if (pending) {
      pending.clear();
      for (const id of stuckNow) pending.add(id);
    }
  }
  return fixed;
}

/** Start the periodic sweep. Returns a stop function. */
export function startStatusReconciler(deps: StatusReconcilerDeps): () => void {
  const pendingStuck = deps.pendingStuck ?? new Set<string>();
  const timer = setInterval(() => {
    try {
      sweepOnce({ ...deps, pendingStuck });
    } catch (err) {
      logger.warn(`[reconciler] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
