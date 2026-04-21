/**
 * Tracks which Slack threads the bot has recently participated in,
 * so the triage layer can skip air-reading for threads that are
 * already mid-conversation (e.g. a skill is in progress, or the user
 * is following up on a prior reply).
 *
 * Keyed by `${channelId}:${threadTs}`. `threadTs` is the root ts of
 * a Slack thread — for a bot reply, it's whatever we passed as
 * `thread_ts` in `chat.postMessage`; for a bot's root message, it's
 * the ts of that message (since future replies will use it as
 * thread_ts).
 */

const DEFAULT_TTL_MS = 600_000; // 10 minutes

export class ActiveThreadTracker {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;
  /**
   * Prune when the map grows past this size. Cheap defense against
   * unbounded growth in long-running daemons.
   */
  private static readonly PRUNE_AT_SIZE = 1000;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  private makeKey(channel: string, threadKey: string): string {
    return `${channel}:${threadKey}`;
  }

  /**
   * Record that the bot just did something in this thread (reply, react, etc.).
   * `threadKey` should be the thread_ts the bot used, or the ts of a new
   * root message the bot posted (so future replies that use it as thread_ts
   * will match).
   */
  touch(channel: string, threadKey: string | undefined, now: number = Date.now()): void {
    if (!channel || !threadKey) return;
    this.entries.set(this.makeKey(channel, threadKey), now);
    if (this.entries.size > ActiveThreadTracker.PRUNE_AT_SIZE) {
      this.prune(now);
    }
  }

  /**
   * Is this thread currently considered active (bot participated within TTL)?
   */
  isActive(channel: string, threadKey: string | undefined, now: number = Date.now()): boolean {
    if (!channel || !threadKey) return false;
    const lastSeen = this.entries.get(this.makeKey(channel, threadKey));
    if (lastSeen === undefined) return false;
    if (now - lastSeen > this.ttlMs) {
      // lazy cleanup of this specific entry
      this.entries.delete(this.makeKey(channel, threadKey));
      return false;
    }
    return true;
  }

  /** Remove entries older than TTL. */
  prune(now: number = Date.now()): void {
    for (const [key, ts] of this.entries) {
      if (now - ts > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  /** For tests / debugging. */
  size(): number {
    return this.entries.size;
  }
}
