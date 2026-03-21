import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, Target } from "../../../shared/types.js";

// Mock node-telegram-bot-api before importing connector
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockEditMessageText = vi.fn().mockResolvedValue(true);
const mockGetMe = vi.fn().mockResolvedValue({ id: 999, username: "test_bot" });
const mockStopPolling = vi.fn().mockResolvedValue(undefined);
const mockOn = vi.fn();

vi.mock("node-telegram-bot-api", () => {
  const MockBot = vi.fn(function (this: any) {
    this.sendMessage = mockSendMessage;
    this.editMessageText = mockEditMessageText;
    this.getMe = mockGetMe;
    this.stopPolling = mockStopPolling;
    this.on = mockOn;
  });
  return { default: MockBot };
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
    it("registers message handler and sets running state", async () => {
      await connector.start();
      const health = connector.getHealth();
      expect(health.status).toBe("running");
      expect(mockGetMe).toHaveBeenCalledOnce();
      expect(mockOn).toHaveBeenCalledWith("message", expect.any(Function));
    });

    it("logs error and sets error state if getMe fails", async () => {
      mockGetMe.mockRejectedValueOnce(new Error("Invalid token"));
      await connector.start();
      const health = connector.getHealth();
      expect(health.status).toBe("error");
      expect(health.detail).toContain("Invalid token");
    });
  });

  describe("stop", () => {
    it("stops polling and sets stopped state", async () => {
      await connector.start();
      await connector.stop();
      expect(mockStopPolling).toHaveBeenCalledOnce();
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
      await messageCallback(telegramMsg);

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
      await messageCallback(botMsg);

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
      await messageCallback(msg);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("sendMessage", () => {
    it("sends a message to the target chat", async () => {
      const target: Target = { channel: "12345" };
      await connector.sendMessage(target, "Hello!");
      expect(mockSendMessage).toHaveBeenCalledWith("12345", "Hello!", {
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
  });

  describe("replyMessage", () => {
    it("sends a reply to a specific message", async () => {
      const target: Target = {
        channel: "12345",
        replyContext: { chatId: 12345, messageId: 42 },
      };
      await connector.replyMessage(target, "Reply!");
      expect(mockSendMessage).toHaveBeenCalledWith("12345", "Reply!", {
        parse_mode: "Markdown",
        reply_to_message_id: 42,
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
      expect(mockEditMessageText).toHaveBeenCalledWith("Edited!", {
        chat_id: "12345",
        message_id: 42,
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
