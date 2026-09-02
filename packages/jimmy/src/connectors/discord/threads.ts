import type { Message } from "discord.js";

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
 * trimmed to Discord's 100-character thread-name limit.
 */
export function threadNameFor(content: string | undefined | null): string {
  const firstLine = (content ?? "").split("\n")[0].trim();
  return (firstLine || "conversation").slice(0, 100);
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
