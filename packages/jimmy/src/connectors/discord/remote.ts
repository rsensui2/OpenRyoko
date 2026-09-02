import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  DiscordRespondToConfig,
  IncomingMessage,
  Target,
} from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { evaluateRespondPolicy } from "./respond-policy.js";
import { EngagedThreadTracker } from "./engaged-threads.js";

export interface RemoteDiscordConfig {
  /** URL of the primary Jinn instance that holds the Discord WebSocket connection */
  proxyVia: string;
  channelId?: string;
  /** Deterministic per-scope response gate, applied to proxied messages. */
  respondTo?: DiscordRespondToConfig;
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
  private readonly respondTo: DiscordRespondToConfig | undefined;
  private engagedThreads = new EngagedThreadTracker();

  constructor(config: RemoteDiscordConfig) {
    this.baseUrl = config.proxyVia.replace(/\/+$/, "");
    this.respondTo = config.respondTo;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  /** Called by the /api/connectors/discord/incoming endpoint to deliver proxied messages */
  deliverMessage(msg: IncomingMessage): void {
    const meta = (msg.transportMeta ?? {}) as Record<string, unknown>;
    const isDM = meta.isDM === true;
    // Addressing flags are resolved by the primary instance — only it can see
    // the Discord gateway. When a flag is absent (older primary), fall to the
    // conservative side: no mention (mention scopes fail closed) and no other
    // addressee (never drop an "always" message on missing metadata).
    const respondDecision = evaluateRespondPolicy({
      config: this.respondTo,
      isDM,
      wasMentioned: meta.wasBotAddressed === true,
      isEngagedThread: !!msg.thread && this.engagedThreads.has(msg.thread),
    });
    if (!respondDecision.allow) {
      logger.info(
        `[discord-remote] respondTo gate → silent (${respondDecision.reason}) for message ${msg.messageId}`,
      );
      return;
    }
    if (!isDM && meta.addressesOnlyOthers === true) {
      logger.info(
        `[discord-remote] message addresses other user(s) — staying silent for message ${msg.messageId}`,
      );
      return;
    }
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
    const messageId = await this.proxyAction("sendMessage", { target, text });
    this.recordEngagement(target, messageId);
    return messageId;
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    const messageId = await this.proxyAction("replyMessage", { target, text });
    this.recordEngagement(target, messageId);
    return messageId;
  }

  async editMessage(target: Target, text: string): Promise<void> {
    await this.proxyAction("editMessage", { target, text });
  }

  async addReaction(target: Target, emoji: string): Promise<void> {
    await this.proxyAction("addReaction", { target, emoji });
    this.recordEngagement(target, target.messageTs);
  }

  async removeReaction(target: Target, emoji: string): Promise<void> {
    await this.proxyAction("removeReaction", { target, emoji });
  }

  async setTypingStatus(channelId: string, threadTs: string | undefined, status: string): Promise<void> {
    await this.proxyAction("setTypingStatus", { channelId, threadTs, status });
  }

  /**
   * Record engagement for the `respondTo.engagedThreads` continuation: the
   * thread the bot acted in, and the message ID that anchors it — a future
   * public thread created from that message reuses its ID.
   */
  private recordEngagement(target: Target, anchorMessageId: string | undefined): void {
    if (target.thread) this.engagedThreads.record(target.thread);
    if (anchorMessageId) this.engagedThreads.record(anchorMessageId);
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
