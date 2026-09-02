import { describe, it, expect, vi } from "vitest";
import { DiscordConnector } from "../index.js";
import type { IncomingMessage } from "../../../shared/types.js";

const BOT = "999000999";

interface FakeMessageInput {
  content?: string;
  channelId?: string;
  isDM?: boolean;
  isThread?: boolean;
  mentionedUserIds?: string[];
  repliedToUserId?: string;
  reference?: { messageId: string; type?: number };
  fetchReference?: () => Promise<{ author: { id: string } }>;
  system?: boolean;
  webhookId?: string;
  authorBot?: boolean;
}

function fakeMessage(input: FakeMessageInput = {}) {
  return {
    id: "M1",
    content: input.content ?? "hello",
    author: { id: "U1", username: "user", bot: input.authorBot ?? false },
    system: input.system ?? false,
    webhookId: input.webhookId,
    createdTimestamp: Date.now() + 60_000,
    guild: undefined,
    channel: {
      id: input.channelId ?? "C1",
      name: "general",
      isDMBased: () => input.isDM ?? false,
      isThread: () => input.isThread ?? false,
      isTextBased: () => true,
    },
    mentions: {
      users: new Map((input.mentionedUserIds ?? []).map((id) => [id, { id }])),
      repliedUser: input.repliedToUserId ? { id: input.repliedToUserId } : null,
    },
    reference: input.reference,
    fetchReference: input.fetchReference ?? vi.fn().mockRejectedValue(new Error("no reference")),
    attachments: new Map(),
  };
}

async function deliver(
  connectorConfig: ConstructorParameters<typeof DiscordConnector>[0],
  message: ReturnType<typeof fakeMessage>,
  opts: { engagedThreadIds?: string[] } = {},
): Promise<IncomingMessage[]> {
  const connector = new DiscordConnector({ botToken: "test-token", ...connectorConfig });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (connector as any).client = { user: { id: BOT } };
  for (const id of opts.engagedThreadIds ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (connector as any).engagedThreads.record(id);
  }
  const received: IncomingMessage[] = [];
  connector.onMessage((msg) => received.push(msg));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (connector as any).handleMessage(message);
  return received;
}

describe("DiscordConnector.handleMessage respondTo gating", () => {
  it("responds to plain channel messages with respondTo unset (legacy default)", async () => {
    const received = await deliver({}, fakeMessage());
    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("hello");
  });

  it("stays silent when the message @-mentions somebody else, even with respondTo unset", async () => {
    const received = await deliver({}, fakeMessage({ mentionedUserIds: ["12345"] }));
    expect(received).toHaveLength(0);
  });

  it("stays silent when the message replies to somebody else without a ping", async () => {
    const received = await deliver({}, fakeMessage({ repliedToUserId: "12345" }));
    expect(received).toHaveLength(0);
  });

  it("does not apply the sibling rule in DMs", async () => {
    const received = await deliver({}, fakeMessage({ isDM: true, repliedToUserId: "12345" }));
    expect(received).toHaveLength(1);
  });

  it("drops un-mentioned channel messages under channel=mention", async () => {
    const received = await deliver({ respondTo: { channel: "mention" } }, fakeMessage());
    expect(received).toHaveLength(0);
  });

  it("responds to @-mentions under channel=mention", async () => {
    const received = await deliver(
      { respondTo: { channel: "mention" } },
      fakeMessage({ mentionedUserIds: [BOT] }),
    );
    expect(received).toHaveLength(1);
  });

  it("responds to replies to the bot under channel=mention", async () => {
    const received = await deliver(
      { respondTo: { channel: "mention" } },
      fakeMessage({ repliedToUserId: BOT }),
    );
    expect(received).toHaveLength(1);
  });

  it("falls back to fetchReference when Discord omitted the reply resolution", async () => {
    const received = await deliver(
      { respondTo: { channel: "mention" } },
      fakeMessage({
        reference: { messageId: "M0" },
        fetchReference: async () => ({ author: { id: BOT } }),
      }),
    );
    expect(received).toHaveLength(1);
  });

  it("treats a deleted reply reference as no addressee (drops under mention, responds under always)", async () => {
    const deleted = { reference: { messageId: "M0" } };
    expect(await deliver({ respondTo: { channel: "mention" } }, fakeMessage(deleted))).toHaveLength(0);
    expect(await deliver({}, fakeMessage(deleted))).toHaveLength(1);
  });

  it("keeps replying without a re-mention inside engaged threads", async () => {
    const received = await deliver(
      { respondTo: { channel: "mention" } },
      fakeMessage({ channelId: "T1", isThread: true }),
      { engagedThreadIds: ["T1"] },
    );
    expect(received).toHaveLength(1);
  });

  it("still answers DMs without a mention under channel=mention", async () => {
    const received = await deliver({ respondTo: { channel: "mention" } }, fakeMessage({ isDM: true }));
    expect(received).toHaveLength(1);
  });

  it("ignores system messages and webhook messages", async () => {
    expect(await deliver({}, fakeMessage({ system: true }))).toHaveLength(0);
    expect(await deliver({}, fakeMessage({ webhookId: "W1" }))).toHaveLength(0);
  });
});
