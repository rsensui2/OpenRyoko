import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  Target,
} from "../../shared/types.js";
import { logger } from "../../shared/logger.js";

export interface RemoteDiscordConfig {
  /** URL of the primary Jinn instance that holds the Discord WebSocket connection */
  proxyVia: string;
  channelId?: string;
}

/**
 * A Discord connector that doesn't hold its own WebSocket connection.
 * Instead, it receives messages from the primary Jinn instance via HTTP
 * and proxies all send/react operations back through the primary.
 */
export class RemoteDiscordConnector implements Connector {
  name = "discord";
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private baseUrl: string;

  constructor(config: RemoteDiscordConfig) {
    this.baseUrl = config.proxyVia.replace(/\/+$/, "");
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  /** Called by the /api/connectors/discord/incoming endpoint to deliver proxied messages */
  deliverMessage(msg: IncomingMessage): void {
    if (this.handler) {
      this.handler(msg);
    }
  }

  async start(): Promise<void> {
    logger.info(`Remote Discord connector started (proxying via ${this.baseUrl})`);
  }

  async stop(): Promise<void> {
    logger.info("Remote Discord connector stopped");
  }

  getCapabilities(): ConnectorCapabilities {
    return {
      threading: true,
      messageEdits: true,
      reactions: true,
      attachments: true,
    };
  }

  getHealth(): ConnectorHealth {
    return {
      status: "running",
      capabilities: this.getCapabilities(),
    };
  }

  reconstructTarget(replyContext: Record<string, unknown> | null | undefined): Target {
    const ctx = (replyContext ?? {}) as Record<string, string | null>;
    return {
      channel: ctx.channel ?? "",
      thread: ctx.thread ?? undefined,
      messageTs: ctx.messageTs ?? undefined,
    };
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    return this.proxyAction("sendMessage", { target, text });
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    return this.proxyAction("replyMessage", { target, text });
  }

  async editMessage(target: Target, text: string): Promise<void> {
    await this.proxyAction("editMessage", { target, text });
  }

  async addReaction(target: Target, emoji: string): Promise<void> {
    await this.proxyAction("addReaction", { target, emoji });
  }

  async removeReaction(target: Target, emoji: string): Promise<void> {
    await this.proxyAction("removeReaction", { target, emoji });
  }

  async setTypingStatus(channelId: string, threadTs: string | undefined, status: string): Promise<void> {
    await this.proxyAction("setTypingStatus", { channelId, threadTs, status });
  }

  private async proxyAction(action: string, params: Record<string, unknown>): Promise<string | undefined> {
    try {
      const res = await fetch(`${this.baseUrl}/api/connectors/discord/proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...params }),
      });
      if (!res.ok) {
        logger.error(`Remote Discord proxy ${action} failed: ${res.status}`);
        return undefined;
      }
      const data = (await res.json()) as { messageId?: string };
      return data.messageId;
    } catch (err) {
      logger.error(`Remote Discord proxy ${action} error: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }
}
