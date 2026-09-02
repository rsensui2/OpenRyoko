import { logger } from "../../shared/logger.js";

/**
 * In-memory record of conversation anchors the bot has engaged: threads it
 * replied or reacted in, plus the IDs of messages it sent or reacted to —
 * a Discord public thread created from a message reuses that message's ID,
 * so recording message IDs makes future threads rooted on the bot's own
 * messages count as engaged from their first reply.
 *
 * Backs the `respondTo.engagedThreads` continuation. In-memory only —
 * engagement resets on restart, same as the Slack ConversationTracker.
 *
 * The cap is a memory safety valve, not a semantic TTL: at the default size
 * it is effectively unbounded for real deployments (IDs are ~20-byte
 * strings). Eviction silently re-arms the mention requirement for the
 * evicted thread, so it is logged. Eviction order is least-recently-engaged
 * (Set preserves insertion order, `record` re-inserts).
 */
export class EngagedThreadTracker {
  private readonly ids = new Set<string>();

  constructor(private readonly maxEntries = 50_000) {}

  record(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > this.maxEntries) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) {
        this.ids.delete(oldest);
        logger.warn(
          `[discord] engaged-thread tracker over ${this.maxEntries} entries — evicted ${oldest}; un-mentioned messages there need a re-mention`,
        );
      }
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
}
