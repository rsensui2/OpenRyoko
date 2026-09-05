import { ChannelType, type Message } from "discord.js";

export function deriveSessionKey(
  message: Message,
  prefix = "discord",
  opts: { threadPerMessage?: boolean } = {},
): string {
  if (message.channel.isDMBased()) {
    return `${prefix}:dm:${message.author.id}`;
  }
  if (message.channel.isThread()) {
    return `${prefix}:thread:${message.channel.id}`;
  }
  if (opts.threadPerMessage) {
    // replyStyle=thread: the response will land in a thread rooted on this
    // message, and a public thread reuses its root message's ID — key the
    // session to it now so follow-ups inside the thread continue the same
    // conversation.
    return `${prefix}:thread:${message.id}`;
  }
  return `${prefix}:${message.channel.id}`;
}

/**
 * Thread title for replyStyle=thread: the starter message's first line,
 * trimmed to Discord's 100-character thread-name limit. Trimming is by code
 * point, so a boundary emoji is dropped whole rather than split into a
 * broken surrogate half.
 */
export function threadNameFor(content: string | undefined | null): string {
  const firstLine = (content ?? "").split("\n")[0].trim();
  return Array.from(firstLine || "conversation").slice(0, 100).join("");
}

/**
 * True when Discord allows creating a thread from a message in this channel
 * — only guild text and announcement channels do. Voice/stage text chat and
 * forum posts don't, so replyStyle=thread must not key sessions to a thread
 * that can never exist there.
 */
export function supportsMessageThreads(channel: { type: ChannelType }): boolean {
  return channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement;
}

export function buildReplyContext(message: Message): Record<string, string | null> {
  const threadId = message.channel.isThread() ? message.channel.id : null;
  return {
    channel: message.channel.id,
    thread: threadId,
    messageTs: message.id,
    guildId: message.guild?.id ?? null,
  };
}

export function isOldMessage(createdTimestamp: number, bootTimeMs: number): boolean {
  return createdTimestamp < bootTimeMs;
}
