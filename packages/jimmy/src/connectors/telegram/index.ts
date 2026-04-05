import TelegramBot from "node-telegram-bot-api";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  ReplyContext,
  Target,
  TelegramConnectorConfig,
} from "../../shared/types.js";
import { deriveSessionKey, buildReplyContext, isOldTelegramMessage } from "./threads.js";
import { formatResponse } from "./format.js";
import { logger } from "../../shared/logger.js";

export class TelegramConnector implements Connector {
  name = "telegram";
  private bot: TelegramBot;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private readonly allowedUsers: Set<number> | null;
  private readonly ignoreOldMessagesOnBoot: boolean;
  private readonly bootTimeMs = Date.now();
  private started = false;
  private lastError: string | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  private readonly capabilities: ConnectorCapabilities = {
    threading: false,
    messageEdits: true,
    reactions: false,
    attachments: true,
  };

  constructor(config: TelegramConnectorConfig) {
    this.bot = new TelegramBot(config.botToken, { polling: false });
    this.ignoreOldMessagesOnBoot = config.ignoreOldMessagesOnBoot !== false;
    this.allowedUsers =
      config.allowFrom && config.allowFrom.length > 0
        ? new Set(config.allowFrom)
        : null;
  }

  async start(): Promise<void> {
    try {
      const me = await this.bot.getMe();
      logger.info(`[telegram] Bot started: @${me.username} (id: ${me.id})`);
      this.bot.startPolling();
      this.started = true;
      this.lastError = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      logger.error(`[telegram] Failed to start: ${msg}`);
      return;
    }

    this.bot.on("message", async (telegramMsg) => {
      // Skip bot messages
      if (telegramMsg.from?.is_bot) {
        logger.debug("[telegram] Skipping bot message");
        return;
      }

      if (!this.handler) {
        logger.debug("[telegram] No handler registered, dropping message");
        return;
      }

      if (
        this.ignoreOldMessagesOnBoot &&
        isOldTelegramMessage(telegramMsg.date, this.bootTimeMs)
      ) {
        logger.debug(`[telegram] Ignoring old message ${telegramMsg.message_id}`);
        return;
      }

      const userId = telegramMsg.from?.id;
      if (this.allowedUsers) {
        if (userId === undefined || !this.allowedUsers.has(userId)) {
          logger.debug(
            `[telegram] Ignoring message from unauthorized user ${userId}`,
          );
          return;
        }
      }

      const sessionKey = deriveSessionKey(telegramMsg);
      const replyContext = buildReplyContext(telegramMsg);

      const username =
        telegramMsg.from?.username || telegramMsg.from?.first_name || "unknown";

      const msg: IncomingMessage = {
        connector: this.name,
        source: "telegram",
        sessionKey,
        replyContext,
        messageId: String(telegramMsg.message_id),
        channel: String(telegramMsg.chat.id),
        user: username,
        userId: String(userId ?? "unknown"),
        text: telegramMsg.text || "",
        attachments: [],
        raw: telegramMsg,
        transportMeta: {
          chatType: telegramMsg.chat.type,
        },
      };

      this.handler(msg);
    });
  }

  async stop(): Promise<void> {
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    await this.bot.stopPolling();
    this.started = false;
    logger.info("[telegram] Connector stopped");
  }

  getCapabilities(): ConnectorCapabilities {
    return this.capabilities;
  }

  getHealth(): ConnectorHealth {
    return {
      status: this.lastError ? "error" : this.started ? "running" : "stopped",
      detail: this.lastError ?? undefined,
      capabilities: this.capabilities,
    };
  }

  reconstructTarget(replyContext: ReplyContext): Target {
    return {
      channel: String(replyContext.chatId ?? ""),
      messageTs: replyContext.messageId != null ? String(replyContext.messageId) : undefined,
      replyContext,
    };
  }

  private async safeSend(
    chatId: string,
    text: string,
    opts: TelegramBot.SendMessageOptions = {},
  ): Promise<string | undefined> {
    try {
      const result = await this.bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        ...opts,
      });
      return String(result.message_id);
    } catch (err) {
      // On parse error, retry without Markdown formatting
      logger.warn(`[telegram] Send failed with Markdown, retrying as plain text: ${err}`);
      try {
        const result = await this.bot.sendMessage(chatId, text, opts);
        return String(result.message_id);
      } catch (retryErr) {
        logger.error(`[telegram] Send failed: ${retryErr}`);
        return undefined;
      }
    }
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const chunks = formatResponse(text);
    let lastMessageId: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const id = await this.safeSend(target.channel, chunk);
      if (id) lastMessageId = id;
    }
    return lastMessageId;
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const replyToId =
      target.replyContext?.messageId != null
        ? Number(target.replyContext.messageId)
        : undefined;
    const opts: TelegramBot.SendMessageOptions = {};
    if (replyToId) {
      opts.reply_to_message_id = replyToId;
    }
    const chunks = formatResponse(text);
    let lastMessageId: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const id = await this.safeSend(target.channel, chunk, opts);
      if (id) lastMessageId = id;
    }
    return lastMessageId;
  }

  async setTypingStatus(channelId: string, _threadTs: string | undefined, status: string): Promise<void> {
    const existing = this.typingIntervals.get(channelId);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(channelId);
    }
    if (!status) return;
    try {
      await this.bot.sendChatAction(channelId, "typing");
      // Telegram typing expires after ~5s — refresh every 4s
      const interval = setInterval(async () => {
        try {
          await this.bot.sendChatAction(channelId, "typing");
        } catch { /* non-fatal */ }
      }, 4_000);
      this.typingIntervals.set(channelId, interval);
    } catch {
      // non-fatal
    }
  }

  async addReaction(_target: Target, _emoji: string): Promise<void> {
    // Telegram Bot API reaction support is limited; no-op for now
  }

  async removeReaction(_target: Target, _emoji: string): Promise<void> {
    // No-op
  }

  async editMessage(target: Target, text: string): Promise<void> {
    if (!target.messageTs) return;
    if (!text || !text.trim()) return;
    await this.bot.editMessageText(text, {
      chat_id: target.channel,
      message_id: Number(target.messageTs),
      parse_mode: "Markdown",
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }
}
