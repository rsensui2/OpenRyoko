export interface CurrentConversation {
  connector?: string;
  channel?: string;
  thread?: string;
}

export interface OutgoingMessageTarget {
  connector?: unknown;
  channel?: unknown;
  thread?: unknown;
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function currentConversationFromEnv(env: NodeJS.ProcessEnv = process.env): CurrentConversation {
  return {
    connector: clean(env.JINN_CURRENT_CONNECTOR),
    channel: clean(env.JINN_CURRENT_CHANNEL),
    thread: clean(env.JINN_CURRENT_THREAD),
  };
}

/** Where send_message posts when no connector is named: the session's own
 *  Slack connector (a peer Ryoko's "slack-<name>"), so a peer never speaks
 *  as the main bot by default; "slack" otherwise. */
export function defaultSendConnector(current: CurrentConversation): string {
  const connector = clean(current.connector);
  return connector && /^slack(?:-[a-z0-9-]+)?$/.test(connector) ? connector : "slack";
}

export function isSendToCurrentConversation(
  target: OutgoingMessageTarget,
  current: CurrentConversation,
): boolean {
  const currentConnector = clean(current.connector);
  const currentChannel = clean(current.channel);
  if (!currentConnector || !currentChannel) return false;

  const connector = clean(target.connector) ?? defaultSendConnector(current);
  const channel = clean(target.channel);
  if (!channel) return false;
  if (connector !== currentConnector || channel !== currentChannel) return false;

  const thread = clean(target.thread);
  const currentThread = clean(current.thread);
  if (!thread || !currentThread) return true;
  return thread === currentThread;
}
