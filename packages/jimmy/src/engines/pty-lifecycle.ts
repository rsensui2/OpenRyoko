/**
 * PTY lifecycle for the interactive Claude engine (CLI/xterm view).
 *
 * Rules:
 *   - A PTY stays alive while: a turn is running, OR at least one user is viewing
 *     the session, OR less than CLI_KEEPALIVE_AFTER_LEAVE_MS has elapsed since
 *     BOTH viewing ended AND the last turn ended (whichever happened later).
 *   - A 30s sweep enforces the grace cap once both conditions lapse.
 *   - When at capacity (maxLivePtys), adopt() evicts the LRU eligible entry
 *     (no viewer, no running turn, oldest viewingEndedAt/lastTurnEndedAt).
 */

export const CLI_KEEPALIVE_AFTER_LEAVE_MS = 10 * 60 * 1000;

export interface PtyHandle {
  pid: number;
  killed: boolean;
  kill: (signal?: string) => void;
}

export interface PtyLifecycleOpts {
  maxLivePtys: number;
  /** Called after a new PTY session is adopted — used to refresh gateway.json pids. */
  onAdopt?: (sessionId: string) => void;
  /** Called after a PTY is killed/removed — used to clean the --settings file, hook registry, gateway.json pids. */
  onCleanup?: (sessionId: string) => void;
  /** Extra liveness probe consulted by the sweep/eviction: return true while the
   *  PTY's engine is still doing work the lifecycle can't see as a "turn" (e.g.
   *  an autonomous background continuation streaming API requests). A busy PTY
   *  is never reaped or LRU-evicted — killing it would abort in-flight work. */
  isBusy?: (sessionId: string) => boolean;
}

interface Entry {
  handle: PtyHandle;
  turnRunning: boolean;
  viewerCount: number;
  viewingEndedAt: number; // epoch ms; 0 while at least one viewer is attached
  lastTurnEndedAt: number; // epoch ms; 0 if no turn has completed yet
}

function shouldStayAlive(e: Entry, now: number): boolean {
  if (e.turnRunning) return true;
  if (e.viewerCount > 0) return true;
  const since = Math.max(e.viewingEndedAt, e.lastTurnEndedAt);
  if (since > 0 && now - since < CLI_KEEPALIVE_AFTER_LEAVE_MS) return true;
  return false;
}

export class PtyLifecycleManager {
  private entries = new Map<string, Entry>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private opts: PtyLifecycleOpts) {
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.sweepTimer.unref();
  }

  adopt(sessionId: string, handle: PtyHandle): void {
    if (this.entries.size >= this.opts.maxLivePtys) this.evictLru();
    this.entries.set(sessionId, {
      handle,
      turnRunning: false,
      viewerCount: 0,
      viewingEndedAt: 0,
      lastTurnEndedAt: 0,
    });
    this.opts.onAdopt?.(sessionId);
  }

  getWarm(sessionId: string): PtyHandle | undefined {
    return this.entries.get(sessionId)?.handle;
  }

  isAtCapacity(): boolean {
    return this.entries.size >= this.opts.maxLivePtys;
  }

  livePids(): number[] {
    return [...this.entries.values()].map((e) => e.handle.pid);
  }

  viewerEnter(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.viewerCount += 1;
    e.viewingEndedAt = 0;
  }

  viewerLeave(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.viewerCount = Math.max(0, e.viewerCount - 1);
    if (e.viewerCount === 0) {
      e.viewingEndedAt = Date.now();
      this.reevaluate(sessionId);
    }
  }

  turnStarted(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (e) e.turnRunning = true;
  }

  turnEnded(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    e.turnRunning = false;
    e.lastTurnEndedAt = Date.now();
    this.reevaluate(sessionId);
  }

  /** Signal out-of-turn engine activity (e.g. an orphan hook from a background
   *  continuation). Restarts the keep-warm grace window so an actively-working
   *  PTY isn't reaped between activity signals. No-op while a turn is running. */
  touch(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e || e.turnRunning) return;
    e.lastTurnEndedAt = Date.now();
  }

  releaseSession(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    this.entries.delete(sessionId);
    if (!e.handle.killed) e.handle.kill("SIGTERM");
    this.opts.onCleanup?.(sessionId);
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.releaseSession(id);
  }

  private reevaluate(sessionId: string): void {
    const e = this.entries.get(sessionId);
    if (!e) return;
    if (this.opts.isBusy?.(sessionId)) return;
    if (!shouldStayAlive(e, Date.now())) this.releaseSession(sessionId);
  }

  private sweep(): void {
    for (const id of [...this.entries.keys()]) this.reevaluate(id);
  }

  /** LRU eviction when at capacity: pick the eligible entry (no viewer, no running turn)
   *  with the oldest max(viewingEndedAt, lastTurnEndedAt). If none are eligible, no-op. */
  private evictLru(): void {
    let victim: string | null = null;
    let oldest = Infinity;
    for (const [id, e] of this.entries.entries()) {
      if (e.turnRunning || e.viewerCount > 0) continue;
      if (this.opts.isBusy?.(id)) continue;
      const since = Math.max(e.viewingEndedAt, e.lastTurnEndedAt);
      if (since < oldest) {
        oldest = since;
        victim = id;
      }
    }
    if (victim) this.releaseSession(victim);
  }

  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.killAll();
  }
}
