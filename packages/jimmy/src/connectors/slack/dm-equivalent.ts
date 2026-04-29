/**
 * DM-equivalent channel detector.
 *
 * Slack's `im` channel type only covers 1:1 native DMs. Operators commonly
 * create a *private channel* with just themselves and the bot — visually
 * identical to a DM, but classified as `channel` by the Slack API. Such
 * channels should bypass air-reading triage for the same reason real DMs do:
 * every message is implicitly addressed to the bot.
 *
 * This module wraps `conversations.info` with a small TTL cache so we can
 * answer "does this channel have exactly the bot + one other member?"
 * cheaply on the hot path.
 */

import { logger } from "../../shared/logger.js";

const DEFAULT_TTL_MS = 600_000; // 10 minutes — channel membership is stable
const PRUNE_AT_SIZE = 500;

interface SlackConversationsInfoClient {
  info(args: { channel: string }): Promise<{
    ok?: boolean;
    channel?: { num_members?: number };
  }>;
}

interface CacheEntry {
  numMembers: number;
  expiresAt: number;
}

export class DmEquivalentDetector {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    private readonly client: SlackConversationsInfoClient,
    ttlMs: number = DEFAULT_TTL_MS,
  ) {
    this.ttlMs = ttlMs;
  }

  /**
   * Resolve whether the channel has exactly 2 members (the bot + one other).
   * Returns `true` / `false` on success, or `null` when membership couldn't
   * be determined — callers should treat `null` as "unknown, fall through to
   * regular triage" rather than as a skip signal.
   */
  async isTwoMember(channel: string, now: number = Date.now()): Promise<boolean | null> {
    if (!channel) return null;

    const cached = this.cache.get(channel);
    if (cached && cached.expiresAt > now) {
      return cached.numMembers === 2;
    }

    try {
      const result = await this.client.info({ channel });
      const numMembers = result?.channel?.num_members;
      if (typeof numMembers !== "number") {
        return null;
      }
      this.cache.set(channel, { numMembers, expiresAt: now + this.ttlMs });
      if (this.cache.size > PRUNE_AT_SIZE) {
        this.prune(now);
      }
      return numMembers === 2;
    } catch (err) {
      logger.debug(`[slack] dm-equivalent lookup failed for ${channel}: ${err}`);
      return null;
    }
  }

  /**
   * Drop the cache entry for a channel — useful when a join/leave event
   * tells us the membership just changed.
   */
  invalidate(channel: string): void {
    this.cache.delete(channel);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}
