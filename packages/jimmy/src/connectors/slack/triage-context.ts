/** Bounded, chronological context ending immediately before the current event. */
export interface TriageHistoryMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
}

/** Who posted one earlier message of a thread; never its content. */
export interface ThreadSpeaker {
  user?: string;
  botId?: string;
}

export interface TriageHistory {
  messages: TriageHistoryMessage[];
  incomplete: boolean;
  /** Thread reads only: every earlier message's author, including messages without text. */
  threadSpeakers?: ThreadSpeaker[];
}

interface HistoryPage {
  messages?: TriageHistoryMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface TriageHistoryClient {
  replies(args: {
    channel: string; ts: string; limit: number; latest?: string;
    inclusive: boolean; cursor?: string;
  }): Promise<HistoryPage>;
  history(args: {
    channel: string; limit: number; latest?: string; inclusive: boolean;
  }): Promise<HistoryPage>;
}

export async function readTriageHistory(
  client: TriageHistoryClient,
  input: { channel: string; threadTs?: string; messageTs?: string; limit: number },
): Promise<TriageHistory> {
  const limit = Number.isFinite(input.limit) ? Math.max(1, Math.min(10, Math.floor(input.limit))) : 10;
  const collected: TriageHistoryMessage[] = [];
  let incomplete = false;
  try {
    if (input.threadTs) {
      // replies is oldest-first. One small page is NOT the latest context.
      // Bound pagination, and defer semantic decisions if the tail is missing.
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
        const page = await client.replies({
          channel: input.channel, ts: input.threadTs, limit: 100,
          latest: input.messageTs, inclusive: false, ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(page.messages)) { incomplete = true; break; }
        collected.push(...page.messages);
        const next = page.response_metadata?.next_cursor?.trim();
        const more = page.has_more === true || !!next;
        if (!more) break;
        if (!next || next === cursor || pageIndex === 3) { incomplete = true; break; }
        cursor = next;
      }
    } else {
      const page = await client.history({
        channel: input.channel, limit, latest: input.messageTs, inclusive: false,
      });
      if (!Array.isArray(page.messages)) incomplete = true;
      else collected.push(...page.messages);
    }
  } catch {
    // Do not log provider errors or message bodies; the caller can log this flag.
    incomplete = true;
  }
  const cutoff = input.messageTs ? Number(input.messageTs) : undefined;
  const deduplicated = new Map<string, TriageHistoryMessage>();
  // Authorship covers the whole thread, not just the tail: a person who spoke
  // early, or only attached a file, is still a participant.
  const speakers = new Map<string, ThreadSpeaker>();
  for (const message of collected) {
    if (!message.ts || !Number.isFinite(Number(message.ts))) { incomplete = true; continue; }
    if (cutoff !== undefined && Number(message.ts) >= cutoff) continue;
    speakers.set(message.ts, {
      ...(message.user ? { user: message.user } : {}),
      ...(message.bot_id ? { botId: message.bot_id } : {}),
    });
    if (!message.text?.trim()) continue;
    deduplicated.set(message.ts, message);
  }
  const messages = [...deduplicated.values()]
    .sort((a, b) => Number(a.ts) - Number(b.ts)).slice(-limit);
  if (!input.threadTs) return { messages, incomplete };
  const threadSpeakers = [...speakers]
    .sort(([a], [b]) => Number(a) - Number(b)).map(([, speaker]) => speaker);
  return { messages, incomplete, threadSpeakers };
}
