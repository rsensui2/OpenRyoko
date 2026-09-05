import { getQueueItem, markQueueItemRunning, markQueueItemCompleted } from "./registry.js";

export class SessionQueue {
  private queues = new Map<string, Promise<void>>();
  /** Track which sessions are currently running */
  private running = new Set<string>();
  /** Track how many tasks exist per session key, including the active one. */
  private pending = new Map<string, number>();
  /** Per-session cancellation generation. clearQueue() bumps it; each task captures
   *  the generation at enqueue time and runs only while it still matches. This cancels
   *  exactly the tasks that existed at /stop time WITHOUT a sticky per-session flag:
   *  a later inbound message enqueues at the new generation and runs normally, so a
   *  reset session neither stays permanently muted (the bug this replaces) nor revives
   *  already-cancelled work when the next message arrives. */
  private cancelGeneration = new Map<string, number>();
  /** Track which session keys are paused - queued tasks wait until resumed. */
  private paused = new Set<string>();

  /**
   * Check if a session is currently running.
   */
  isRunning(sessionKey: string): boolean {
    return this.running.has(sessionKey);
  }

  getPendingCount(sessionKey: string): number {
    const total = this.pending.get(sessionKey) || 0;
    return this.running.has(sessionKey) ? Math.max(0, total - 1) : total;
  }

  getTransportState(sessionKey: string, status?: "idle" | "running" | "error" | "waiting" | "interrupted"): "idle" | "queued" | "running" | "error" | "interrupted" {
    if (status === "error") return "error";
    if (status === "interrupted") return "interrupted";
    if (this.running.has(sessionKey)) return "running";
    if (this.getPendingCount(sessionKey) > 0) return "queued";
    return status === "running" ? "running" : "idle";
  }

  /**
   * Cancel every task currently queued for this session. Tasks enqueued AFTER this
   * call run normally (they capture the bumped generation), so cancellation is scoped
   * to the moment of the call rather than sticky.
   *
   * NB: pending is intentionally NOT reset here. Cancelled tasks still drain through
   * runTask (they skip fn but run their finally → decrementPending), so each task
   * accounts for its own slot. Zeroing pending here would let those in-flight
   * decrements eat the count of a task enqueued afterwards, corrupting the queued
   * state — the count converges naturally as the cancelled tasks drain.
   */
  clearQueue(sessionKey: string): void {
    this.cancelGeneration.set(sessionKey, (this.cancelGeneration.get(sessionKey) ?? 0) + 1);
  }

  /**
   * No-op retained for API compatibility. Cancellation is now generational: a new
   * message enqueues at the current generation and runs without needing an explicit
   * un-cancel, so callers no longer have to clear a sticky flag before dispatching.
   */
  clearCancelled(_sessionKey: string): void {
    /* intentionally empty — see cancelGeneration */
  }

  pauseQueue(sessionKey: string): void {
    this.paused.add(sessionKey);
  }

  resumeQueue(sessionKey: string): void {
    this.paused.delete(sessionKey);
  }

  isPaused(sessionKey: string): boolean {
    return this.paused.has(sessionKey);
  }

  /**
   * Enqueue a task for a session. Tasks are serialized per session key.
   */
  async enqueue(sessionKey: string, fn: () => Promise<void>, queueItemId?: string, claimed = false): Promise<void> {
    this.pending.set(sessionKey, (this.pending.get(sessionKey) || 0) + 1);
    // Snapshot the cancellation generation at enqueue time. A later clearQueue()
    // bumps it and skips this task; tasks enqueued after that clearQueue capture the
    // new value and still run.
    const taskGeneration = this.cancelGeneration.get(sessionKey) ?? 0;
    const prev = this.queues.get(sessionKey) || Promise.resolve();
    const runTask = async () => {
      this.running.add(sessionKey);
      let queueItemStarted = false;
      try {
        // Wait while paused (500ms poll)
        while (this.paused.has(sessionKey)) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        // pending→running is a CAS: only the winner runs the prompt, so two
        // dispatchers holding the same durable row id can never both execute
        // it. A `claimed` caller already holds the row as 'running' (a boot
        // redispatch of a row recoverStaleQueueItems put back) and only
        // verifies it is still theirs.
        if (queueItemId) {
          const item = getQueueItem(queueItemId);
          if (!item || (claimed ? item.status !== "running" && !markQueueItemRunning(queueItemId)
            : item.status !== "pending" || !markQueueItemRunning(queueItemId))) return;
          queueItemStarted = true;
        }
        if ((this.cancelGeneration.get(sessionKey) ?? 0) === taskGeneration) {
          await fn();
        }
      } finally {
        // Mark the DB row done in finally so an errored/cancelled task can't
        // leave the item stuck as 'running'.
        if (queueItemId && queueItemStarted) markQueueItemCompleted(queueItemId);
        this.running.delete(sessionKey);
        this.decrementPending(sessionKey);
      }
    };
    const next = prev.then(runTask, runTask);
    this.queues.set(sessionKey, next);
    void next.finally(() => {
      if (this.queues.get(sessionKey) === next) {
        this.queues.delete(sessionKey);
      }
    });
    return next;
  }

  private decrementPending(sessionKey: string): void {
    const remaining = (this.pending.get(sessionKey) || 1) - 1;
    if (remaining <= 0) {
      this.pending.delete(sessionKey);
      return;
    }
    this.pending.set(sessionKey, remaining);
  }
}
