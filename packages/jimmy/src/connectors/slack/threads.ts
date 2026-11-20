import type { ReplyContext } from "../../shared/types.js";

export interface SlackMessageEventLike {
  channel: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
  channel_type?: string;
}

/** The session-key prefix of the default (top-level) Slack connector. */
export const DEFAULT_SLACK_KEY_PREFIX = "slack";

/**
 * `prefix` is the connector instance: the default top-level connector keeps
 * the historical "slack:…" keys (so existing conversations continue), and
 * every other Slack instance — a peer Ryoko's bot, an employee's bot — uses
 * its own instance id ("slack-hana:dm:U…"). Two bots in one workspace see the
 * same user and the same threads; without the prefix a DM to one bot would
 * continue the other bot's engine session.
 */
export function deriveSessionKey(event: SlackMessageEventLike, prefix: string = DEFAULT_SLACK_KEY_PREFIX): string {
  if (event.channel_type === "im") {
    // A threaded DM message gets its own per-thread session, so opening a
    // new thread starts a fresh conversation — same as channels. The
    // non-threaded DM timeline stays one long-lived session per user.
    if (event.thread_ts && event.thread_ts !== event.ts) {
      return `${prefix}:dm:${event.user || "unknown"}:${event.thread_ts}`;
    }
    return `${prefix}:dm:${event.user || "unknown"}`;
  }

  // Thread reply — use thread_ts (which is the root message's ts)
  if (event.thread_ts && event.thread_ts !== event.ts) {
    return `${prefix}:${event.channel}:${event.thread_ts}`;
  }

  // Root channel message — use ts so thread replies will match
  return `${prefix}:${event.channel}:${event.ts}`;
}

export function buildReplyContext(event: SlackMessageEventLike): ReplyContext {
  // For DMs: a threaded message → reply inside that thread so the per-thread
  // session's replies stay in their thread; a non-threaded message → reply on
  // the DM's main timeline (thread: null).
  if (event.channel_type === "im") {
    return {
      channel: event.channel,
      thread: event.thread_ts && event.thread_ts !== event.ts ? event.thread_ts : null,
      messageTs: event.ts ?? null,
    };
  }

  // For channel messages, always set thread so bot replies in a thread
  // For root messages: thread = ts (starts a thread under the root)
  // For thread replies: thread = thread_ts (continues existing thread)
  const thread = event.thread_ts && event.thread_ts !== event.ts
    ? event.thread_ts
    : event.ts ?? null;

  return {
    channel: event.channel,
    thread,
    messageTs: event.ts ?? null,
  };
}

export function isOldSlackMessage(ts: string | undefined, bootTimeMs: number): boolean {
  if (!ts) return false;
  const secs = Number(ts.split(".")[0]);
  if (!Number.isFinite(secs)) return false;
  return secs * 1000 < bootTimeMs;
}
