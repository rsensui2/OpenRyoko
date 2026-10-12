import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
import { DiscordConnector } from "../index.js";
import { logger } from "../../../shared/logger.js";
import { isPartialDelivery } from "../../../shared/partial-delivery.js";

// The send promise is the delivery outcome. The connector used to catch its
// own failures and resolve, so /api/connectors/:name/send answered "sent" for
// a message that never left, and origin-delivery's retry and "undelivered"
// record never ran for Discord.

let sendCounter = 0;

function flatChannel(id = "C1") {
  return {
    id,
    type: ChannelType.GuildText,
    isThread: () => false,
    isDMBased: () => false,
    isTextBased: () => true,
    send: vi.fn(async (_payload: unknown) => ({ id: `S${++sendCounter}` })),
  };
}

function threadChannel(id: string, parentId: string) {
  return { ...flatChannel(id), type: ChannelType.PublicThread, parentId, isThread: () => true };
}

function connectorWith(channels: Record<string, unknown>): DiscordConnector {
  const connector = new DiscordConnector({ botToken: "test-token" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (connector as any).client = {
    user: { id: "BOT" },
    channels: {
      fetch: vi.fn(async (id: string) => {
        if (id in channels) return channels[id];
        throw new Error("Unknown Channel");
      }),
    },
  };
  return connector;
}

const TWO_CHUNKS = "a".repeat(1900) + "\n" + "b".repeat(500);

describe("DiscordConnector delivery outcome", () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendCounter = 0;
    logged = vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("sendMessage", () => {
    it("resolves with the last message id when the message is delivered", async () => {
      const channel = flatChannel();
      const connector = connectorWith({ C1: channel });

      await expect(connector.sendMessage({ channel: "C1" }, TWO_CHUNKS)).resolves.toBe("S2");

      expect(channel.send).toHaveBeenCalledTimes(2);
    });

    it("rejects when Discord refuses the message", async () => {
      const channel = flatChannel();
      channel.send.mockRejectedValue(new Error("Missing Permissions"));
      const connector = connectorWith({ C1: channel });

      await expect(connector.sendMessage({ channel: "C1" }, "hi")).rejects.toThrow("Missing Permissions");

      expect(logged).toHaveBeenCalledWith(expect.stringContaining("Missing Permissions"));
    });

    it("rejects when the channel cannot be fetched", async () => {
      const connector = connectorWith({});

      await expect(connector.sendMessage({ channel: "C404" }, "hi")).rejects.toThrow("Unknown Channel");
    });

    it.each([
      ["is missing", null],
      ["cannot take messages", { id: "V1", isTextBased: () => false }],
    ])("rejects when the channel %s", async (_label, channel) => {
      const connector = connectorWith({ C1: channel });

      await expect(connector.sendMessage({ channel: "C1" }, "hi")).rejects.toThrow(/C1.*cannot receive messages/);
    });

    it("rejects a partly delivered message as a partial delivery, never as sent", async () => {
      const channel = flatChannel();
      channel.send.mockResolvedValueOnce({ id: "S1" }).mockRejectedValue(new Error("rate limited"));
      const connector = connectorWith({ C1: channel });

      const outcome = await connector.sendMessage({ channel: "C1" }, TWO_CHUNKS).catch((err: unknown) => err);

      // Typed, so a caller that retries knows not to start over from the top.
      expect(isPartialDelivery(outcome)).toBe(true);
      expect(outcome).toMatchObject({ delivered: 1, total: 2, lastId: "S1" });
      expect((outcome as Error).message).toBe("Discord sendMessage: only 1 of 2 chunks were delivered (rate limited)");
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("only 1 of 2 chunks were delivered"));
    });
  });

  describe("replyMessage", () => {
    it("rejects when Discord refuses the reply", async () => {
      const channel = flatChannel();
      channel.send.mockRejectedValue(new Error("Missing Access"));
      const connector = connectorWith({ C1: channel });

      await expect(connector.replyMessage({ channel: "C1", messageTs: "M0" }, "hi")).rejects.toThrow("Missing Access");
    });

    it("rejects when the reply target cannot be fetched", async () => {
      const connector = connectorWith({});

      await expect(connector.replyMessage({ channel: "C404", thread: "T404" }, "hi")).rejects.toThrow("Unknown Channel");
    });

    it("rejects when the reply target is missing", async () => {
      const connector = connectorWith({ T1: null });

      await expect(connector.replyMessage({ channel: "C1", thread: "T1" }, "hi")).rejects.toThrow(/T1.*cannot receive messages/);
    });

    it("rejects when neither the thread nor its parent channel accepts the reply", async () => {
      const parent = flatChannel("C1");
      parent.send.mockRejectedValue(new Error("Missing Permissions"));
      const thread = threadChannel("T1", "C1");
      thread.send.mockRejectedValue(new Error("Thread is locked"));
      const connector = connectorWith({ T1: thread, C1: parent });

      await expect(connector.replyMessage({ channel: "C1", thread: "T1" }, "hi")).rejects.toThrow("Missing Permissions");

      expect(parent.send).toHaveBeenCalledTimes(1);
    });

    it("rejects when the thread refuses and its parent channel is gone", async () => {
      const thread = threadChannel("T1", "C1");
      thread.send.mockRejectedValue(new Error("Thread is locked"));
      const connector = connectorWith({ T1: thread });

      await expect(connector.replyMessage({ channel: "C1", thread: "T1" }, "hi")).rejects.toThrow("Thread is locked");
    });

    it("rejects a reply that stopped part-way as a partial delivery", async () => {
      const channel = flatChannel();
      channel.send.mockResolvedValueOnce({ id: "S1" }).mockRejectedValue(new Error("rate limited"));
      const connector = connectorWith({ C1: channel });

      const outcome = await connector.replyMessage({ channel: "C1", messageTs: "M0" }, TWO_CHUNKS).catch((err: unknown) => err);

      expect(isPartialDelivery(outcome)).toBe(true);
      expect(outcome).toMatchObject({ delivered: 1, total: 2, lastId: "S1" });
      expect(channel.send).toHaveBeenCalledTimes(2);
    });

    it("rejects a parent-channel fallback that was only partly delivered", async () => {
      const parent = flatChannel("C1");
      parent.send.mockResolvedValueOnce({ id: "P1" }).mockRejectedValue(new Error("rate limited"));
      const thread = threadChannel("T1", "C1");
      thread.send.mockRejectedValue(new Error("Thread is locked"));
      const connector = connectorWith({ T1: thread, C1: parent });

      const outcome = await connector.replyMessage({ channel: "C1", thread: "T1" }, TWO_CHUNKS).catch((err: unknown) => err);

      expect(isPartialDelivery(outcome)).toBe(true);
      expect(outcome).toMatchObject({ delivered: 1, total: 2, lastId: "P1" });
    });
  });

  it("leaves reactions, edits and typing best-effort", async () => {
    const connector = connectorWith({});

    await expect(connector.addReaction({ channel: "C404", messageTs: "M1" }, "eyes")).resolves.toBeUndefined();
    await expect(connector.removeReaction({ channel: "C404", messageTs: "M1" }, "eyes")).resolves.toBeUndefined();
    await expect(connector.editMessage({ channel: "C404", messageTs: "M1" }, "edited")).resolves.toBeUndefined();
    await expect(connector.setTypingStatus("C404", undefined, "typing")).resolves.toBeUndefined();
  });
});
