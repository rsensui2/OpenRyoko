import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, Target } from "../../../shared/types.js";

// Mock node-telegram-bot-api v2 before importing connector
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockEditMessageText = vi.fn().mockResolvedValue(true);
const mockGetMe = vi.fn().mockResolvedValue({ id: 999, username: "test_bot" });
const mockStartPolling = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();
const mockOn = vi.fn();

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any) {
    this.api = {
      sendMessage: mockSendMessage,
      editMessageText: mockEditMessageText,
      getMe: mockGetMe,
      sendChatAction: vi.fn().mockResolvedValue(true),
    };
    this.startPolling = mockStartPolling;
    this.stop = mockStop;
    this.on = mockOn;
  });
  return { Bot: MockBot };
});

vi.mock("../../../shared/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks are set up
const { TelegramConnector } = await import("../index.js");

describe("TelegramConnector", () => {
  let connector: InstanceType<typeof TelegramConnector>;

  beforeEach(() => {
    vi.clearAllMocks();
    connector = new TelegramConnector({
      botToken: "123456:ABC-DEF",
    });
  });

  describe("constructor", () => {
    it("sets the connector name to telegram", () => {
      expect(connector.name).toBe("telegram");
    });
  });

  describe("getCapabilities", () => {
    it("returns correct capabilities", () => {
      expect(connector.getCapabilities()).toEqual({
        threading: false,
        messageEdits: true,
        reactions: false,
        attachments: true,
      });
    });
  });

  describe("getHealth", () => {
    it("returns stopped before start", () => {
      const health = connector.getHealth();
      expect(health.status).toBe("stopped");
    });
  });

  describe("start", () => {
    it("registers message handler and starts polling after validation", async () => {
      await connector.start();
      const health = connector.getHealth();
      expect(health.status).toBe("running");
      expect(mockGetMe).toHaveBeenCalledOnce();
      expect(mockStartPolling).toHaveBeenCalledOnce();
      expect(mockOn).toHaveBeenCalledWith("message", expect.any(Function));
    });

    it("does not start polling if getMe fails (invalid token)", async () => {
      mockGetMe.mockRejectedValueOnce(new Error("Invalid token"));
      await connector.start();
      const health = connector.getHealth();
      expect(health.status).toBe("error");
      expect(health.detail).toContain("Invalid token");
      expect(mockStartPolling).not.toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("stops polling and sets stopped state", async () => {
      await connector.start();
      await connector.stop();
      expect(mockStop).toHaveBeenCalledOnce();
      expect(connector.getHealth().status).toBe("stopped");
    });
  });

  describe("onMessage", () => {
    it("routes incoming messages to the handler", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      // Get the registered message callback
      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];
      expect(messageCallback).toBeDefined();

      // Simulate incoming Telegram message
      const telegramMsg = {
        message_id: 42,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "testuser", first_name: "Test", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Hello bot!",
      };
      await messageCallback({ message: telegramMsg });

      expect(handler).toHaveBeenCalledOnce();
      const msg: IncomingMessage = handler.mock.calls[0][0];
      expect(msg.connector).toBe("telegram");
      expect(msg.source).toBe("telegram");
      expect(msg.sessionKey).toBe("telegram:12345");
      expect(msg.text).toBe("Hello bot!");
      expect(msg.user).toBe("testuser");
      expect(msg.userId).toBe("67890");
      expect(msg.channel).toBe("12345");
    });

    it("ignores messages from bots", async () => {
      const handler = vi.fn();
      connector.onMessage(handler);
      await connector.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      const botMsg = {
        message_id: 1,
        chat: { id: 12345, type: "private" as const },
        from: { id: 999, username: "test_bot", first_name: "Bot", is_bot: true },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Bot message",
      };
      await messageCallback({ message: botMsg });

      expect(handler).not.toHaveBeenCalled();
    });

    it("ignores messages from unauthorized users when allowFrom is set", async () => {
      const restricted = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
      });
      const handler = vi.fn();
      restricted.onMessage(handler);
      await restricted.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      // Unauthorized user
      const msg = {
        message_id: 1,
        chat: { id: 11111, type: "private" as const },
        from: { id: 99999, username: "stranger", first_name: "Stranger", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Hello",
      };
      await messageCallback({ message: msg });
      expect(handler).not.toHaveBeenCalled();
    });

    it("rejects messages with from: undefined when allowFrom is set", async () => {
      const restricted = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
      });
      const handler = vi.fn();
      restricted.onMessage(handler);
      await restricted.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      // Channel post or forwarded message with no `from`
      const msg = {
        message_id: 1,
        chat: { id: 11111, type: "channel" as const },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Channel post",
      };
      await messageCallback({ message: msg });
      expect(handler).not.toHaveBeenCalled();
    });

    it("allows messages from authorized users through allowFrom", async () => {
      const restricted = new TelegramConnector({
        botToken: "123456:ABC-DEF",
        allowFrom: [67890],
      });
      const handler = vi.fn();
      restricted.onMessage(handler);
      await restricted.start();

      const messageCallback = mockOn.mock.calls.find(
        (call) => call[0] === "message",
      )?.[1];

      const msg = {
        message_id: 1,
        chat: { id: 12345, type: "private" as const },
        from: { id: 67890, username: "allowed_user", first_name: "Allowed", is_bot: false },
        date: Math.floor(Date.now() / 1000) + 10,
        text: "Hello",
      };
      await messageCallback({ message: msg });
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe("sendMessage", () => {
    it("sends a message to the target chat", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "Hello!");
      expect(mockSendMessage).toHaveBeenCalledWith({
        chat_id: "12345",
        text: "Hello!",
        parse_mode: "Markdown",
      });
    });

    it("does not send empty messages", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "");
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("chunks long messages", async () => {
      const target: Target = { channel: "12345" };
      const longText = "A".repeat(5000);
      await connector.sendMessage(target, longText);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it("retries without parse_mode on Markdown parse error", async () => {
      mockSendMessage
        .mockRejectedValueOnce({ errorCode: 400, description: "Bad Request: can't parse entities" })
        .mockResolvedValueOnce({ message_id: 2 });
      const target: Target = { channel: "12345" };
      const result = await connector.sendMessage(target, "**bad markdown");
      // First call with Markdown, second without
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage.mock.calls[0][0]).toEqual({
        chat_id: "12345",
        text: "**bad markdown",
        parse_mode: "Markdown",
      });
      expect(mockSendMessage.mock.calls[1][0]).toEqual({
        chat_id: "12345",
        text: "**bad markdown",
      });
      expect(result).toBe("2");
    });

    it("does not duplicate a send after a transient or ambiguous failure", async () => {
      mockSendMessage.mockRejectedValueOnce({ errorCode: 429, description: "Too Many Requests" });
      const result = await connector.sendMessage({ channel: "12345" }, "Hello");
      expect(mockSendMessage).toHaveBeenCalledOnce();
      expect(result).toBeUndefined();
    });
  });

  describe("replyMessage", () => {
    it("sends a reply to a specific message", async () => {
      const target: Target = {
        channel: "12345",
        replyContext: { chatId: 12345, messageId: 42 },
      };
      await connector.replyMessage(target, "Reply!");
      expect(mockSendMessage).toHaveBeenCalledWith({
        chat_id: "12345",
        text: "Reply!",
        parse_mode: "Markdown",
        reply_parameters: { message_id: 42 },
      });
    });
  });

  describe("editMessage", () => {
    it("edits an existing message", async () => {
      const target: Target = {
        channel: "12345",
        messageTs: "42",
      };
      await connector.editMessage(target, "Edited!");
      expect(mockEditMessageText).toHaveBeenCalledWith({
        chat_id: "12345",
        message_id: 42,
        text: "Edited!",
        parse_mode: "Markdown",
      });
    });
  });

  describe("reconstructTarget", () => {
    it("reconstructs target from reply context", () => {
      const target = connector.reconstructTarget({
        chatId: 12345,
        messageId: 42,
      });
      expect(target.channel).toBe("12345");
      expect(target.messageTs).toBe("42");
      expect(target.replyContext).toEqual({ chatId: 12345, messageId: 42 });
    });
  });
});
