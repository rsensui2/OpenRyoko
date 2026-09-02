/**
 * In-memory record of conversation anchors the bot has engaged: threads it
 * replied or reacted in, plus the IDs of messages it sent or reacted to —
 * a Discord public thread created from a message reuses that message's ID,
 * so recording message IDs makes future threads rooted on the bot's own
 * messages count as engaged from their first reply.
 *
 * Backs the `respondTo.engagedThreads` continuation. Unbounded by design,
 * matching the Slack ConversationTracker: engagement is a promise ("mention
 * once, then converse"), and silently evicting it would re-arm the mention
 * requirement mid-conversation. Entries are single ~20-byte IDs, so even a
 * very busy year of uptime stays in the tens of megabytes. In-memory only —
 * engagement resets on gateway restart.
 */
export class EngagedThreadTracker {
  private readonly ids = new Set<string>();

  record(id: string): void {
    this.ids.add(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
}
