export interface HookPayload {
  hook_event_name: "SessionStart" | "Stop" | "StopFailure" | "PreToolUse" | "PostToolUse" | string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  last_assistant_message?: string;
  tool_name?: string;
  /** Present on StopFailure: enum — rate_limit | authentication_failed | billing_error | invalid_request | server_error | max_output_tokens | unknown */
  error?: string;
  error_details?: string;
  [k: string]: unknown;
}

export interface HookDelivery {
  buffered: boolean;
  receivedAt: number;
}

type HookListener = (h: HookPayload, delivery: HookDelivery) => void;
interface Buffered { payload: HookPayload; at: number; }

export class HookRegistry {
  private listeners = new Map<string, HookListener>();
  private buffer = new Map<string, Buffered[]>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Invoked for hooks that arrive with NO registered listener (no turn in
   *  flight). Stop/StopFailure orphans are the final output of autonomous
   *  post-turn work (background sub-agents / tasks finishing after the turn
   *  settled) — they are handed here for delivery instead of being buffered
   *  (a buffered stale Stop could otherwise drain into the NEXT turn's resolver
   *  and settle it with the previous turn's message). Other events are still
   *  buffered as before, but also surfaced here as a liveness signal. */
  private orphanHandler: ((jinnSessionId: string, payload: HookPayload) => void) | null = null;
  constructor(private ttlMs = 30_000, sweepIntervalMs = 5_000) {
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    // Don't keep the event loop alive for the sweep timer.
    this.sweepTimer.unref?.();
  }

  register(jinnSessionId: string, listener: HookListener): void {
    if (this.listeners.has(jinnSessionId)) {
      // Engine guards against concurrent turns per session, so this should
      // never happen. Warn loudly if it does — silently overwriting the
      // previous listener would mean the prior turn's resolver never fires.
      console.warn(
        `[HookRegistry] duplicate listener registration for session ${jinnSessionId}; previous listener will be replaced`,
      );
    }
    this.listeners.set(jinnSessionId, listener);
    const pending = this.buffer.get(jinnSessionId);
    if (pending) {
      this.buffer.delete(jinnSessionId);
      const now = Date.now();
      for (const b of pending) {
        if (now - b.at <= this.ttlMs) listener(b.payload, { buffered: true, receivedAt: b.at });
      }
    }
  }

  unregister(jinnSessionId: string): void {
    this.listeners.delete(jinnSessionId);
    this.buffer.delete(jinnSessionId);
  }

  /** Register the orphan-hook handler (see `orphanHandler`). Errors thrown by
   *  the handler are swallowed — a delivery failure must never break the hook
   *  endpoint. */
  setOrphanHandler(fn: (jinnSessionId: string, payload: HookPayload) => void): void {
    this.orphanHandler = fn;
  }

  deliver(jinnSessionId: string, payload: HookPayload): void {
    const listener = this.listeners.get(jinnSessionId);
    if (listener) { listener(payload, { buffered: false, receivedAt: Date.now() }); return; }
    const isTerminal = payload.hook_event_name === "Stop" || payload.hook_event_name === "StopFailure";
    if (this.orphanHandler) {
      try { this.orphanHandler(jinnSessionId, payload); } catch { /* never break the endpoint */ }
      // Terminal orphans are CONSUMED by the handler: buffering them would let a
      // stale Stop drain into the next turn's resolver and settle it instantly
      // with the previous turn's text.
      if (isTerminal) return;
    }
    const arr = this.buffer.get(jinnSessionId) ?? [];
    arr.push({ payload, at: Date.now() });
    this.buffer.set(jinnSessionId, arr);
  }

  /** Drop buffered entries whose `at` is older than ttlMs. */
  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [sid, arr] of this.buffer) {
      const fresh = arr.filter((b) => b.at >= cutoff);
      if (fresh.length === 0) this.buffer.delete(sid);
      else if (fresh.length !== arr.length) this.buffer.set(sid, fresh);
    }
  }

  /** Stop the periodic sweep timer. Call when shutting down the registry. */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
