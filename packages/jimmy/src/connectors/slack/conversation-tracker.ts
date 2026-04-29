/**
 * Tracks Slack conversations to decide whether incoming messages should
 * skip the air-reading triage gate.
 *
 * A conversation is "DM-equivalent" — implicitly addressed to the bot —
 * once the bot has engaged with it AND only one human has spoken. The
 * decision is permanent until a third human joins, at which point we
 * fall back to normal triage.
 *
 * Conversation keys:
 *   - Threaded message  (`thread_ts && thread_ts !== ts`):
 *       `${channel}:thread:${thread_ts}`
 *   - Top-level message (no `thread_ts` or `thread_ts === ts`):
 *       `${channel}:user:${user_id}`
 *
 * The thread keying handles the obvious case ("this thread is just me and
 * the bot"). The user keying handles operators who don't reply in threads
 * — once the bot has answered them once in a channel, follow-up top-level
 * messages from the same user skip triage.
 */
import { logger } from "../../shared/logger.js";

export interface ConversationKeyInput {
  channel: string;
  threadTs?: string;
  ts?: string;
  userId: string;
}

interface ConversationState {
  humanSpeakers: Set<string>;
  botEngaged: boolean;
}

const PRUNE_AT_SIZE = 5000;

export class ConversationTracker {
  private readonly entries = new Map<string, ConversationState>();

  /**
   * Compute the conversation key for a Slack message. Returns `null` if
   * required fields (channel + userId) are missing.
   */
  static keyFor(input: ConversationKeyInput): string | null {
    if (!input.channel || !input.userId) return null;
    if (input.threadTs && input.threadTs !== input.ts) {
      return `${input.channel}:thread:${input.threadTs}`;
    }
    return `${input.channel}:user:${input.userId}`;
  }

  /**
   * Compute the future thread key for a top-level message — the key that
   * would apply if the bot replies in-thread to this message. Returns
   * `null` if the message is already a thread reply (no future thread to
   * prime) or required fields are missing.
   */
  static futureThreadKey(input: ConversationKeyInput): string | null {
    if (!input.channel || !input.ts) return null;
    if (input.threadTs && input.threadTs !== input.ts) return null;
    return `${input.channel}:thread:${input.ts}`;
  }

  /**
   * Record a human speaker for the conversation key implied by the given
   * message. Adds the user to the `humanSpeakers` set; multiple distinct
   * users in the same key invalidates DM-equivalence.
   */
  recordHumanMessage(input: ConversationKeyInput): void {
    const key = ConversationTracker.keyFor(input);
    if (!key) return;
    this.addSpeaker(key, input.userId);
  }

  /**
   * Mark the conversation as having received bot engagement (a reply, a
   * reaction, or any other deliberate response). Once set, this flag is
   * permanent for the key.
   *
   * For top-level user messages we also prime the *future* thread key
   * (the thread the bot will create by replying), so follow-ups in that
   * thread inherit the engagement state without a round-trip.
   */
  recordBotEngaged(input: ConversationKeyInput): void {
    if (!input.userId) return;
    const primary = ConversationTracker.keyFor(input);
    if (primary) {
      this.markEngaged(primary, input.userId);
    }
    const future = ConversationTracker.futureThreadKey(input);
    if (future && future !== primary) {
      this.markEngaged(future, input.userId);
    }
  }

  /**
   * Mark a key as bot-engaged without a specific user attribution. Used
   * when the bot initiates a top-level message of its own — the new
   * message becomes a thread root, and any future replies in that thread
   * are implicitly bot-addressed.
   */
  recordBotInitiatedThread(channel: string, threadTs: string): void {
    if (!channel || !threadTs) return;
    const key = `${channel}:thread:${threadTs}`;
    const state = this.entries.get(key) ?? { humanSpeakers: new Set(), botEngaged: false };
    state.botEngaged = true;
    this.touch(key, state);
  }

  /**
   * Should this incoming message skip triage?
   * Returns true when bot has engaged AND exactly one human has spoken in
   * this conversation.
   */
  isDmEquivalent(input: ConversationKeyInput): boolean {
    const key = ConversationTracker.keyFor(input);
    if (!key) return false;
    const state = this.entries.get(key);
    if (!state) return false;
    return state.botEngaged && state.humanSpeakers.size === 1;
  }

  /** For tests / debugging. */
  size(): number {
    return this.entries.size;
  }

  /** Remove a key (e.g. on member_left_channel). */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  private addSpeaker(key: string, userId: string): void {
    const existing = this.entries.get(key);
    if (existing) {
      if (!existing.humanSpeakers.has(userId)) {
        existing.humanSpeakers.add(userId);
        if (existing.humanSpeakers.size === 2 && existing.botEngaged) {
          logger.debug(`[slack] conversation ${key} no longer DM-equivalent (third party joined)`);
        }
      }
      return;
    }
    const state: ConversationState = { humanSpeakers: new Set([userId]), botEngaged: false };
    this.touch(key, state);
  }

  private markEngaged(key: string, userId?: string): void {
    const state = this.entries.get(key) ?? { humanSpeakers: new Set(), botEngaged: false };
    state.botEngaged = true;
    if (userId) state.humanSpeakers.add(userId);
    this.touch(key, state);
  }

  private touch(key: string, state: ConversationState): void {
    this.entries.set(key, state);
    if (this.entries.size > PRUNE_AT_SIZE) {
      const oldest = this.entries.keys().next().value;
      if (oldest && oldest !== key) this.entries.delete(oldest);
    }
  }
}
