/**
 * In-memory record of conversation anchors the bot has engaged: threads it
 * replied or reacted in, plus the IDs of eligible messages it sent or
 * reacted to — a Discord public thread created from a message reuses that
 * message's ID, so recording message IDs makes future threads rooted on the
 * bot's own messages count as engaged from their first reply.
 *
 * Backs the `respondTo.engagedThreads` continuation. No eviction, matching
 * the Slack ConversationTracker: engagement is a promise ("mention once,
 * then converse"), and silently evicting it would re-arm the mention
 * requirement mid-conversation. Memory stays bounded by what the connector
 * feeds in (see `DiscordConnector.recordEngagement`): nothing at all unless
 * a consumer exists, and only anchor-eligible IDs — DM and in-thread message
 * IDs can never root a thread and are never recorded. At the ~60-70 bytes a
 * Set entry really costs, even hundreds of thousands of anchors stay in the
 * tens of megabytes. Entries live until the connector is recreated (gateway
 * restart, config save, connector reload).
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
