import { describe, it, expect, vi, afterEach } from "vitest";
import { ChannelType, MessageType, type Message } from "discord.js";
import { DiscordConnector } from "../index.js";
import { deriveSessionKey, threadNameFor, supportsMessageThreads } from "../threads.js";

const BOT = "999000999";

describe("threadNameFor", () => {
  it("uses the starter's first line, trimmed", () => {
    expect(threadNameFor("  こんにちは Ryoko  \n二行目は無視")).toBe("こんにちは Ryoko");
  });

  it("caps at 100 code points without splitting surrogate pairs", () => {
    expect(threadNameFor("あ".repeat(300))).toBe("あ".repeat(100));
    expect(threadNameFor("😀".repeat(120))).toBe("😀".repeat(100));
  });

  it("falls back when the starter has no text (attachment-only)", () => {
    expect(threadNameFor("")).toBe("conversation");
    expect(threadNameFor(undefined)).toBe("conversation");
  });
});

describe("supportsMessageThreads", () => {
  it("allows guild text and announcement channels only", () => {
    expect(supportsMessageThreads({ type: ChannelType.GuildText })).toBe(true);
    expect(supportsMessageThreads({ type: ChannelType.GuildAnnouncement })).toBe(true);
    expect(supportsMessageThreads({ type: ChannelType.GuildVoice })).toBe(false);
    expect(supportsMessageThreads({ type: ChannelType.GuildStageVoice })).toBe(false);
    expect(supportsMessageThreads({ type: ChannelType.GuildForum })).toBe(false);
  });
});

describe("deriveSessionKey threadPerMessage", () => {
  function msg(input: { isDM?: boolean; isThread?: boolean }) {
    return {
      id: "M1",
      author: { id: "U1" },
      channel: {
        id: "C1",
        isDMBased: () => input.isDM ?? false,
        isThread: () => input.isThread ?? false,
      },
    } as unknown as Message;
  }

  it("keys flat-channel messages to their future thread (thread id = message id)", () => {
    expect(deriveSessionKey(msg({}), "discord", { threadPerMessage: true })).toBe(
      "discord:thread:M1",
    );
  });

  it("leaves DMs, threads, and the default mapping unchanged", () => {
    expect(deriveSessionKey(msg({}), "discord")).toBe("discord:C1");
    expect(deriveSessionKey(msg({ isDM: true }), "discord", { threadPerMessage: true })).toBe(
      "discord:dm:U1",
    );
    expect(deriveSessionKey(msg({ isThread: true }), "discord", { threadPerMessage: true })).toBe(
      "discord:thread:C1",
    );
  });
});

let sendCounter = 0;

function fakeThreadChannel(id: string, parentId?: string) {
  return {
    id,
    parentId: parentId ?? null,
    type: ChannelType.PublicThread,
    isThread: () => true,
    isDMBased: () => false,
    isTextBased: () => true,
    send: vi.fn(async (_payload: unknown) => ({ id: `S${++sendCounter}` })),
  };
}

function fakeFlatChannel(input: {
  id?: string;
  type?: ChannelType;
  starterContent?: string;
  startThreadResult?: ReturnType<typeof fakeThreadChannel>;
  startThreadError?: unknown;
} = {}) {
  const thread = input.startThreadResult ?? fakeThreadChannel("M0", input.id ?? "C1");
  const starterMessage = {
    content: input.starterContent ?? "元メッセージ",
    startThread:
      input.startThreadError !== undefined
        ? vi.fn().mockRejectedValue(input.startThreadError)
        : vi.fn(async () => thread),
  };
  return {
    id: input.id ?? "C1",
    type: input.type ?? ChannelType.GuildText,
    isThread: () => false,
    isDMBased: () => false,
    isTextBased: () => true,
    send: vi.fn(async (_payload: unknown) => ({ id: `S${++sendCounter}` })),
    messages: { fetch: vi.fn(async () => starterMessage) },
    _starter: starterMessage,
    _thread: thread,
  };
}

function connectorWith(
  config: ConstructorParameters<typeof DiscordConnector>[0],
  channels: Record<string, unknown>,
): DiscordConnector {
  const connector = new DiscordConnector({ botToken: "test-token", ...config });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (connector as any).client = {
    user: { id: BOT },
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (id in channels) return channels[id];
        throw new Error("Unknown Channel");
      }),
    },
  };
  return connector;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("replyMessage replyStyle", () => {
  it("channel style (default) sends plain messages", async () => {
    const channel = fakeFlatChannel();
    const connector = connectorWith({}, { C1: channel });
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "hi");
    expect(channel.send).toHaveBeenCalledWith("hi");
  });

  it("reply style attaches the first chunk to the triggering message", async () => {
    const channel = fakeFlatChannel();
    const connector = connectorWith({ replyStyle: "reply" }, { C1: channel });
    const long = "a".repeat(1900) + "\n" + "b".repeat(500);
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, long);
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send.mock.calls[0][0]).toMatchObject({
      reply: { messageReference: "M0", failIfNotExists: false },
    });
    expect(typeof channel.send.mock.calls[1][0]).toBe("string");
  });

  it("reply style falls back to a plain send without a triggering message", async () => {
    const channel = fakeFlatChannel();
    const connector = connectorWith({ replyStyle: "reply" }, { C1: channel });
    await connector.replyMessage({ channel: "C1" }, "hi");
    expect(channel.send).toHaveBeenCalledWith("hi");
  });

  it("thread style creates a thread on the starter and responds there", async () => {
    const channel = fakeFlatChannel({ starterContent: "質問です\n詳細" });
    const connector = connectorWith(
      { replyStyle: "thread", respondTo: { channel: "mention" } },
      { C1: channel },
    );
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "answer");
    expect(channel._starter.startThread).toHaveBeenCalledWith({ name: "質問です" });
    expect(channel._thread.send).toHaveBeenCalledWith("answer");
    expect(channel.send).not.toHaveBeenCalled();
    // The created thread counts as engaged for respondTo.engagedThreads.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((connector as any).engagedThreads.has("M0")).toBe(true);
  });

  it("thread style reuses an existing thread by fetching its id (cache-independent)", async () => {
    const channel = fakeFlatChannel();
    const existingThread = fakeThreadChannel("M0", "C1");
    const connector = connectorWith({ replyStyle: "thread" }, { C1: channel, M0: existingThread });
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "answer");
    expect(existingThread.send).toHaveBeenCalledWith("answer");
    expect(channel._starter.startThread).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("thread style skips channels that can't host message threads (voice/stage)", async () => {
    const channel = fakeFlatChannel({ type: ChannelType.GuildVoice });
    const connector = connectorWith({ replyStyle: "thread" }, { C1: channel });
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "hi");
    expect(channel._starter.startThread).not.toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ reply: { messageReference: "M0", failIfNotExists: false } }),
    );
  });

  it("remembers a channel-level thread refusal and stops attempting from the next turn", async () => {
    const channel = fakeFlatChannel({ startThreadError: { code: 50013 } });
    const connector = connectorWith({ replyStyle: "thread" }, { C1: channel });
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "hi");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((connector as any).threadStyleFailed.has("C1")).toBe(true);
    await connector.replyMessage({ channel: "C1", messageTs: "M1" }, "hi again");
    expect(channel._starter.startThread).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it("does not mark the channel for a message-level failure (deleted starter)", async () => {
    const channel = fakeFlatChannel({ startThreadError: new Error("Unknown Message") });
    const connector = connectorWith({ replyStyle: "thread" }, { C1: channel });
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "hi");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((connector as any).threadStyleFailed.has("C1")).toBe(false);
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ reply: { messageReference: "M0", failIfNotExists: false } }),
    );
  });

  it("falls back to a parent-channel reply when the resolved thread accepts nothing", async () => {
    const channel = fakeFlatChannel();
    channel._thread.send.mockRejectedValue(new Error("Thread is locked"));
    const connector = connectorWith({ replyStyle: "thread" }, { C1: channel });
    const result = await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "hi");
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ reply: { messageReference: "M0", failIfNotExists: false } }),
    );
    expect(result).toBeDefined();
  });

  it("ignores replyStyle inside threads — they are already precise destinations", async () => {
    const thread = fakeThreadChannel("T1", "C1");
    const connector = connectorWith({ replyStyle: "reply" }, { T1: thread });
    await connector.replyMessage({ channel: "C1", thread: "T1", messageTs: "M5" }, "hi");
    expect(thread.send).toHaveBeenCalledWith("hi");
  });

  it("degrades an invalid replyStyle value to channel", async () => {
    const channel = fakeFlatChannel();
    const connector = connectorWith(
      { replyStyle: "sometimes" as unknown as "reply" },
      { C1: channel },
    );
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "hi");
    expect(channel.send).toHaveBeenCalledWith("hi");
  });
});

describe("threads inherit their parent channel's route and restriction", () => {
  function fakeIncoming(input: { channelId: string; isThread?: boolean; parentId?: string }) {
    return {
      id: "M9",
      type: MessageType.Default,
      content: "hello",
      author: { id: "U1", username: "user", bot: false },
      system: false,
      webhookId: undefined,
      createdTimestamp: Date.now() + 60_000,
      guild: { id: "G1" },
      channel: {
        id: input.channelId,
        name: "general",
        parentId: input.parentId ?? null,
        type: input.isThread ? ChannelType.PublicThread : ChannelType.GuildText,
        isDMBased: () => false,
        isThread: () => input.isThread ?? false,
        isTextBased: () => true,
      },
      mentions: { users: new Map(), repliedUser: null },
      reference: undefined,
      fetchReference: vi.fn().mockRejectedValue(new Error("no reference")),
      attachments: new Map(),
    };
  }

  it("routes a thread's messages via its parent channel's route", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        calls.push(JSON.parse(init?.body ?? "{}"));
        return { ok: true, status: 200, statusText: "OK" };
      }),
    );
    const connector = connectorWith({ channelRouting: { C1: "http://remote.test" } }, {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (connector as any).handleMessage(
      fakeIncoming({ channelId: "M1", isThread: true, parentId: "C1" }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].channel).toBe("M1");
  });

  it("lets a thread through the channelId restriction when its parent matches", async () => {
    const connector = connectorWith({ channelId: "C1" }, {});
    const received: unknown[] = [];
    connector.onMessage((m) => received.push(m));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (connector as any).handleMessage(
      fakeIncoming({ channelId: "M1", isThread: true, parentId: "C1" }),
    );
    expect(received).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (connector as any).handleMessage(fakeIncoming({ channelId: "X9" }));
    expect(received).toHaveLength(1);
  });

  it("records engagement for a thread whose parent channel is routed", async () => {
    const thread = fakeThreadChannel("T9", "C1");
    const connector = connectorWith({ channelRouting: { C1: "http://remote.test" } }, { T9: thread });
    await connector.replyMessage({ channel: "C1", thread: "T9" }, "hi");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((connector as any).engagedThreads.has("T9")).toBe(true);
  });
});
