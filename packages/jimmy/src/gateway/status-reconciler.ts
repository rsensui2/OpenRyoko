/**
 * Status reconciler — unsticks sessions stuck at status:"running" with no live
 * turn. (Ported from upstream jinn 0.20.0.)
 *
 * A completion event can be lost (process crash between engine settle and
 * status persistence, a thrown error in the delivery path, a lost hook) and
 * the session then shows "running" forever: the dashboard spinner never
 * clears and new messages queue behind a phantom turn. This sweep is the
 * backstop: a "running" session whose lastActivity is stale AND whose engine
 * reports no live turn is reset to idle — but only on the SECOND consecutive
 * sweep that finds it stuck, so a benign turn-boundary race (process exited,
 * final status not yet persisted) never triggers a reset.
 */
import type { Engine } from "../shared/types.js";
import { listSessions, updateSession } from "../sessions/registry.js";
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
  intervalMs?: number;
  staleMs?: number;
  /** Test override. */
  now?: () => number;
  /** Carry-over between sweeps: sessions seen stuck once. A session is only
   *  reset on the SECOND consecutive sweep that finds it stuck. Created by
   *  startStatusReconciler; tests may pass their own. */
  pendingStuck?: Set<string>;
}

/** One sweep: unstick sessions stuck at status:"running" with no live turn.
 *  Returns the number of sessions fixed. Exported for tests. */
export function sweepOnce(deps: StatusReconcilerDeps): number {
  const now = deps.now?.() ?? Date.now();
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  let fixed = 0;
  for (const session of listSessions({ status: "running" })) {
    const last = session.lastActivity ? new Date(session.lastActivity).getTime() : 0;
    const staleFor = now - last;
    if (staleFor < staleMs) {
      deps.pendingStuck?.delete(session.id); // fresh heartbeat — recovered, clear any mark
      continue;
    }
    const engine = deps.engines.get(session.engine);
    // Same live-turn probe as the API status path: interactive engines expose
    // isTurnRunning (warm-but-idle PTYs must not count); headless engines
    // approximate with isAlive; an unknown engine cannot have a live turn.
    const turnRunning = !!engine && (
      "isTurnRunning" in engine
        ? (engine as unknown as { isTurnRunning(id: string): boolean }).isTurnRunning(session.id)
        : (typeof (engine as { isAlive?: (id: string) => boolean }).isAlive === "function"
          ? (engine as unknown as { isAlive(id: string): boolean }).isAlive(session.id)
          : false)
    );
    if (turnRunning) {
      deps.pendingStuck?.delete(session.id); // live turn — clear any mark
      continue;
    }
    // Session qualifies as stuck: stale heartbeat + no live turn.
    const pending = deps.pendingStuck;
    if (pending && !pending.has(session.id)) {
      pending.add(session.id);
      continue; // confirm on the next sweep — could be a turn-boundary race
    }
    pending?.delete(session.id);
    updateSession(session.id, {
      status: "idle",
      lastActivity: new Date(now).toISOString(),
      lastError: null,
    });
    deps.emit("session:completed", {
      sessionId: session.id,
      employee: session.employee ?? undefined,
      title: session.title,
      result: null,
      error: null,
    });
    logger.warn(
      `[reconciler] session ${session.id} (${session.engine}) was stuck status=running with no live turn ` +
      `(heartbeat stale ${Math.round(staleFor / 1000)}s) — reset to idle`,
    );
    fixed++;
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
