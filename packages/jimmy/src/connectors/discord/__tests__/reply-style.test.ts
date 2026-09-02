import { describe, it, expect, vi } from "vitest";
import type { Message } from "discord.js";
import { DiscordConnector } from "../index.js";
import { deriveSessionKey, threadNameFor } from "../threads.js";

const BOT = "999000999";

describe("threadNameFor", () => {
  it("uses the starter's first line, trimmed", () => {
    expect(threadNameFor("  こんにちは Ryoko  \n二行目は無視")).toBe("こんにちは Ryoko");
  });

  it("caps at Discord's 100-character limit", () => {
    expect(threadNameFor("あ".repeat(300))).toHaveLength(100);
  });

  it("falls back when the starter has no text (attachment-only)", () => {
    expect(threadNameFor("")).toBe("conversation");
    expect(threadNameFor(undefined)).toBe("conversation");
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

function fakeThreadChannel(id: string) {
  return {
    id,
    isThread: () => true,
    isDMBased: () => false,
    isTextBased: () => true,
    send: vi.fn(async (_payload: unknown) => ({ id: `S${++sendCounter}` })),
  };
}

function fakeFlatChannel(starter?: {
  content?: string;
  hasThread?: boolean;
  thread?: ReturnType<typeof fakeThreadChannel>;
  startThreadError?: boolean;
}) {
  const thread = starter?.thread ?? fakeThreadChannel("M0");
  const starterMessage = {
    content: starter?.content ?? "元メッセージ",
    hasThread: starter?.hasThread ?? false,
    thread: starter?.hasThread ? thread : null,
    startThread: starter?.startThreadError
      ? vi.fn().mockRejectedValue(new Error("Missing Permissions"))
      : vi.fn(async () => thread),
  };
  return {
    id: "C1",
    isThread: () => false,
    isDMBased: () => false,
    isTextBased: () => true,
    send: vi.fn(async (_payload: unknown) => ({ id: `S${++sendCounter}` })),
    messages: {
      fetch: starter === undefined
        ? vi.fn().mockRejectedValue(new Error("Unknown Message"))
        : vi.fn(async () => starterMessage),
    },
    _starter: starterMessage,
    _thread: thread,
  };
}

function connectorWith(
  config: ConstructorParameters<typeof DiscordConnector>[0],
  channel: unknown,
): DiscordConnector {
  const connector = new DiscordConnector({ botToken: "test-token", ...config });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (connector as any).client = {
    user: { id: BOT },
    channels: { fetch: vi.fn(async () => channel) },
  };
  return connector;
}

describe("replyMessage replyStyle", () => {
  it("channel style (default) sends plain messages", async () => {
    const channel = fakeFlatChannel({});
    const connector = connectorWith({}, channel);
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "hi");
    expect(channel.send).toHaveBeenCalledWith("hi");
  });

  it("reply style attaches the first chunk to the triggering message", async () => {
    const channel = fakeFlatChannel({});
    const connector = connectorWith({ replyStyle: "reply" }, channel);
    const long = "a".repeat(1900) + "\n" + "b".repeat(500);
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, long);
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send.mock.calls[0][0]).toMatchObject({
      reply: { messageReference: "M0", failIfNotExists: false },
    });
    expect(typeof channel.send.mock.calls[1][0]).toBe("string");
  });

  it("reply style falls back to a plain send without a triggering message", async () => {
    const channel = fakeFlatChannel({});
    const connector = connectorWith({ replyStyle: "reply" }, channel);
    await connector.replyMessage({ channel: "C1" }, "hi");
    expect(channel.send).toHaveBeenCalledWith("hi");
  });

  it("thread style creates a thread on the starter and responds there", async () => {
    const channel = fakeFlatChannel({ content: "質問です\n詳細" });
    const connector = connectorWith(
      { replyStyle: "thread", respondTo: { channel: "mention" } },
      channel,
    );
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "answer");
    expect(channel._starter.startThread).toHaveBeenCalledWith({ name: "質問です" });
    expect(channel._thread.send).toHaveBeenCalledWith("answer");
    expect(channel.send).not.toHaveBeenCalled();
    // The created thread counts as engaged for respondTo.engagedThreads.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((connector as any).engagedThreads.has("M0")).toBe(true);
  });

  it("thread style reuses an existing thread on the starter", async () => {
    const channel = fakeFlatChannel({ hasThread: true });
    const connector = connectorWith({ replyStyle: "thread" }, channel);
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "answer");
    expect(channel._starter.startThread).not.toHaveBeenCalled();
    expect(channel._thread.send).toHaveBeenCalledWith("answer");
  });

  it("thread style falls back to a reply when the thread can't be created", async () => {
    const channel = fakeFlatChannel({ startThreadError: true });
    const connector = connectorWith({ replyStyle: "thread" }, channel);
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "answer");
    expect(channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ reply: { messageReference: "M0", failIfNotExists: false } }),
    );
  });

  it("ignores replyStyle inside threads — they are already precise destinations", async () => {
    const thread = fakeThreadChannel("T1");
    const connector = connectorWith({ replyStyle: "reply" }, thread);
    await connector.replyMessage({ channel: "C1", thread: "T1", messageTs: "M5" }, "hi");
    expect(thread.send).toHaveBeenCalledWith("hi");
  });

  it("degrades an invalid replyStyle value to channel", async () => {
    const channel = fakeFlatChannel({});
    const connector = connectorWith(
      { replyStyle: "sometimes" as unknown as "reply" },
      channel,
    );
    await connector.replyMessage({ channel: "C1", messageTs: "M0" }, "hi");
    expect(channel.send).toHaveBeenCalledWith("hi");
  });
});
