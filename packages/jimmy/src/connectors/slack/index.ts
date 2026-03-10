import { App } from "@slack/bolt";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  ReplyContext,
  SlackConnectorConfig,
  Target,
} from "../../shared/types.js";
import { buildReplyContext, deriveSessionKey, isOldSlackMessage } from "./threads.js";
import { formatResponse, downloadAttachment } from "./format.js";
import { TMP_DIR } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";

export class SlackConnector implements Connector {
  name = "slack";
  private app: App;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private readonly shareSessionInChannel: boolean;
  private readonly allowedUsers: Set<string> | null;
  private readonly ignoreOldMessagesOnBoot: boolean;
  private readonly bootTimeMs = Date.now();
  private started = false;
  private lastError: string | null = null;

  private readonly capabilities: ConnectorCapabilities = {
    threading: true,
    messageEdits: true,
    reactions: true,
    attachments: true,
  };

  /**
   * Set the AI assistant typing status in a thread.
   * Uses Slack's assistant.threads.setStatus API for native animated indicator.
   */
  async setTypingStatus(channelId: string, threadTs: string | undefined, status: string): Promise<void> {
    if (!threadTs) return;
    const payload = {
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    };
    try {
      const client = this.app.client as any;
      if (client.assistant?.threads?.setStatus) {
        await client.assistant.threads.setStatus(payload);
      } else if (typeof client.apiCall === "function") {
        await client.apiCall("assistant.threads.setStatus", payload);
      }
    } catch (err) {
      logger.debug(`Slack typing status failed: ${err}`);
    }
  }

  constructor(config: SlackConnectorConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
    this.shareSessionInChannel = !!config.shareSessionInChannel;
    this.ignoreOldMessagesOnBoot = config.ignoreOldMessagesOnBoot !== false;
    const allowFrom = Array.isArray(config.allowFrom)
      ? config.allowFrom
      : typeof config.allowFrom === "string"
        ? config.allowFrom.split(",").map((value) => value.trim()).filter(Boolean)
        : [];
    this.allowedUsers = allowFrom.length > 0 ? new Set(allowFrom) : null;
  }

  async start() {
    this.app.message(async ({ event }) => {
      logger.info(`[slack] Received message event: user=${(event as any).user} channel=${(event as any).channel} text="${((event as any).text || "").slice(0, 50)}"`);
      // Skip bot's own messages
      if ((event as any).bot_id) {
        logger.info(`[slack] Skipping bot message`);
        return;
      }
      if (!this.handler) {
        logger.info(`[slack] No handler registered, dropping message`);
        return;
      }
      if (this.ignoreOldMessagesOnBoot && isOldSlackMessage((event as any).ts, this.bootTimeMs)) {
        logger.debug(`Ignoring old Slack message ${(event as any).ts}`);
        return;
      }
      if (this.allowedUsers && !this.allowedUsers.has((event as any).user)) {
        logger.debug(`Ignoring Slack message from unauthorized user ${(event as any).user}`);
        return;
      }

      const sessionKey = deriveSessionKey(event as any, {
        shareSessionInChannel: this.shareSessionInChannel,
      });
      const replyContext = buildReplyContext(event as any);

      // Fetch parent message for thread replies so the session has full context
      let parentContext = "";
      const threadTs = (event as any).thread_ts;
      if (threadTs && threadTs !== (event as any).ts) {
        try {
          const parentResult = await this.app.client.conversations.replies({
            channel: (event as any).channel,
            ts: threadTs,
            limit: 1,
            inclusive: true,
          });
          const parentMsg = parentResult.messages?.[0];
          if (parentMsg?.text) {
            parentContext = `[Thread context — parent message: "${parentMsg.text}"]\n\n`;
          }
        } catch (err) {
          logger.debug(`Failed to fetch parent message: ${err}`);
        }
      }

      // Download attachments if present
      const attachments = [];
      if ((event as any).files) {
        for (const file of (event as any).files) {
          try {
            const localPath = await downloadAttachment(
              file.url_private,
              this.app.client.token!,
              TMP_DIR,
            );
            attachments.push({
              name: file.name,
              url: file.url_private,
              mimeType: file.mimetype,
              localPath,
            });
          } catch (err) {
            logger.warn(`Failed to download attachment: ${err}`);
          }
        }
      }

      const msg: IncomingMessage = {
        connector: this.name,
        source: "slack",
        sessionKey,
        replyContext,
        messageId: (event as any).ts,
        channel: (event as any).channel,
        thread: (event as any).thread_ts,
        user: (event as any).user,
        userId: (event as any).user,
        text: parentContext + ((event as any).text || ""),
        attachments,
        raw: event,
        transportMeta: {
          channelType: ((event as any).channel_type as string) || "channel",
          team: ((event as any).team as string) || null,
        },
      };

      this.handler(msg);
    });

    await this.app.start();
    this.started = true;
    this.lastError = null;
    logger.info("Slack connector started (socket mode)");
  }

  async stop() {
    await this.app.stop();
    this.started = false;
    logger.info("Slack connector stopped");
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
      channel: typeof replyContext.channel === "string" ? replyContext.channel : "",
      thread: typeof replyContext.thread === "string" ? replyContext.thread : undefined,
      messageTs: typeof replyContext.messageTs === "string" ? replyContext.messageTs : undefined,
      replyContext,
    };
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const chunks = formatResponse(text);
    let lastTs: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const res = await this.app.client.chat.postMessage({
        channel: target.channel,
        text: chunk,
      });
      lastTs = res.ts;
    }
    return lastTs;
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    const threadTs = target.thread || target.messageTs;
    const chunks = formatResponse(text);
    let lastTs: string | undefined;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const res = await this.app.client.chat.postMessage({
        channel: target.channel,
        thread_ts: threadTs,
        text: chunk,
      });
      lastTs = res.ts;
    }
    return lastTs;
  }

  async addReaction(target: Target, emoji: string) {
    if (!target.messageTs) return;
    try {
      await this.app.client.reactions.add({
        channel: target.channel,
        timestamp: target.messageTs,
        name: emoji,
      });
    } catch (err) {
      logger.warn(`Failed to add reaction: ${err}`);
    }
  }

  async removeReaction(target: Target, emoji: string) {
    if (!target.messageTs) return;
    try {
      await this.app.client.reactions.remove({
        channel: target.channel,
        timestamp: target.messageTs,
        name: emoji,
      });
    } catch (err) {
      logger.warn(`Failed to remove reaction: ${err}`);
    }
  }

  async editMessage(target: Target, text: string) {
    if (!target.messageTs) return;
    if (!text || !text.trim()) return;
    await this.app.client.chat.update({
      channel: target.channel,
      ts: target.messageTs,
      text,
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void) {
    this.handler = handler;
  }
}
