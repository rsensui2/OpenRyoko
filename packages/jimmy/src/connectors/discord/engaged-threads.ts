/**
 * Bounded in-memory record of threads the bot has engaged (replied or
 * reacted in). Backs the `respondTo.engagedThreads` continuation: once the
 * bot participates in a thread, follow-ups there flow without a re-mention.
 *
 * In-memory only — engagement resets on restart, same as the Slack
 * ConversationTracker. The cap bounds memory over long uptimes; eviction is
 * least-recently-engaged (Set preserves insertion order, `record` re-inserts).
 */
export class EngagedThreadTracker {
  private readonly ids = new Set<string>();

  constructor(private readonly maxEntries = 500) {}

  record(threadId: string): void {
    this.ids.delete(threadId);
    this.ids.add(threadId);
    if (this.ids.size > this.maxEntries) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }

  has(threadId: string): boolean {
    return this.ids.has(threadId);
  }
}
