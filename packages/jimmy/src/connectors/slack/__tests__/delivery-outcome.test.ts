import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackConnector } from "../index.js";
import { deliverToOriginConnector } from "../../../sessions/origin-delivery.js";
import { logger } from "../../../shared/logger.js";
import type { Connector, Session } from "../../../shared/types.js";

// A reply longer than one Slack message is posted as several chunks. When a
// later chunk failed, the connector rejected although the first ones were
// already in the channel — and every caller that retries a rejected send
// (origin delivery waits 2s and 5s and starts over) posted them again.

function makeConnector(options: { tracking?: boolean } = {}) {
  let ts = 0;
  const postMessage = vi.fn(async (_args: { channel: string; thread_ts?: string; text: string }) => ({ ts: `${++ts}.000` }));
  const conversations = {
    recordBotInitiatedThread: vi.fn(),
    recordBotReply: vi.fn(),
    recordBotThreadReply: vi.fn(),
    linkRootConversation: vi.fn(),
  };
  const connector = Object.create(SlackConnector.prototype) as SlackConnector;
  Object.assign(connector as unknown as Record<string, unknown>, {
    app: { client: { chat: { postMessage } } },
    conversations,
    respondTo: undefined,
    triageConfig: options.tracking ? { enabled: true } : undefined,
    capabilities: { threading: true, messageEdits: true, reactions: true, attachments: true },
  });
  return { connector, postMessage, conversations };
}

const TWO_CHUNKS = "a".repeat(2900) + "\n" + "b".repeat(500);

describe("SlackConnector delivery outcome", () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves with the last ts when every chunk is posted", async () => {
    const { connector, postMessage } = makeConnector();

    await expect(connector.sendMessage({ channel: "C1" }, TWO_CHUNKS)).resolves.toBe("2.000");
    await expect(connector.replyMessage({ channel: "C1", thread: "9.000" }, TWO_CHUNKS)).resolves.toBe("4.000");

    expect(postMessage).toHaveBeenCalledTimes(4);
    expect(logged).not.toHaveBeenCalled();
  });

  it("still rejects when not even the first chunk was posted", async () => {
    const { connector, postMessage } = makeConnector();
    postMessage.mockRejectedValue(new Error("channel_not_found"));

    await expect(connector.sendMessage({ channel: "C1" }, TWO_CHUNKS)).rejects.toThrow("channel_not_found");
    await expect(connector.replyMessage({ channel: "C1", thread: "9.000" }, TWO_CHUNKS)).rejects.toThrow("channel_not_found");

    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps a partly posted message instead of rejecting (sendMessage)", async () => {
    const { connector, postMessage } = makeConnector();
    postMessage.mockResolvedValueOnce({ ts: "1.000" }).mockRejectedValueOnce(new Error("request timed out"));

    await expect(connector.sendMessage({ channel: "C1" }, TWO_CHUNKS)).resolves.toBe("1.000");

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("1 of 2"));
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("request timed out"));
  });

  it("keeps a partly posted reply, and still records the thread as engaged", async () => {
    const { connector, postMessage, conversations } = makeConnector({ tracking: true });
    postMessage.mockResolvedValueOnce({ ts: "1.000" }).mockRejectedValueOnce(new Error("request timed out"));

    await expect(connector.replyMessage({ channel: "C1", thread: "9.000" }, TWO_CHUNKS)).resolves.toBe("1.000");

    // The first chunk is in the thread: follow-ups there must reach the bot.
    expect(conversations.recordBotThreadReply).toHaveBeenCalledWith("C1", "9.000", { messageTs: "1.000" });
  });

  it("is not posted again by origin delivery's retry", async () => {
    const { connector, postMessage } = makeConnector();
    postMessage.mockImplementation(async ({ text }) => {
      if (text.startsWith("b")) throw new Error("request timed out");
      return { ts: "1.000" };
    });
    const session = {
      id: "s-slack-partial",
      connector: "slack",
      replyContext: { channel: "C777", thread: "111.222", messageTs: "111.333" },
      transportMeta: { channelExternal: true },
    } as unknown as Session;

    const outcome = await deliverToOriginConnector(
      session, TWO_CHUNKS, new Map([["slack", connector as unknown as Connector]]), [1, 1],
    );

    expect(outcome).toBe("delivered");
    // One attempt per chunk. Three rounds would have put the first chunk in
    // the customer's thread three times.
    expect(postMessage.mock.calls.filter(([args]) => args.text.startsWith("a"))).toHaveLength(1);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});
