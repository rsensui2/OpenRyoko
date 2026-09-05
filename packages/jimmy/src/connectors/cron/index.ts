import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  CronDelivery,
  IncomingMessage,
  ReplyContext,
  Target,
} from "../../shared/types.js";
import { logger } from "../../shared/logger.js";

const capabilities: ConnectorCapabilities = {
  threading: false,
  messageEdits: false,
  reactions: false,
  attachments: false,
};

export class CronConnector implements Connector {
  name = "cron";
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private deliveredMessages = 0;
  private deliveredTexts: string[] = [];

  constructor(
    private readonly connectors: Map<string, Connector>,
    private readonly delivery?: CronDelivery,
  ) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  getCapabilities(): ConnectorCapabilities {
    return capabilities;
  }

  getHealth(): ConnectorHealth {
    return {
      status: "running",
      capabilities,
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

  async sendMessage(target: Target, text: string): Promise<string | void> {
    return this.forward(target, text, false);
  }

  async replyMessage(target: Target, text: string): Promise<string | void> {
    return this.forward(target, text, true);
  }

  async addReaction(): Promise<void> {}

  async removeReaction(): Promise<void> {}

  async editMessage(target: Target, text: string): Promise<void> {
    if (!this.delivery) return;
    const connector = this.connectors.get(this.delivery.connector);
    if (!connector || !connector.getCapabilities().messageEdits) return;
    await connector.editMessage(target, text);
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  /** Number of messages the underlying connector accepted during this run. */
  getDeliveredMessageCount(): number {
    return this.deliveredMessages;
  }

  hasDeliveredTextContaining(fragment: string): boolean {
    return this.deliveredTexts.some((text) => text.includes(fragment));
  }

  private async forward(target: Target, text: string, asReply: boolean): Promise<string | void> {
    if (!this.delivery) return undefined;

    // No connector configured. An empty defaultDelivery ({}) is the intentional
    // "jobs self-deliver via curl" case — stay silent. But a delivery that names a
    // channel yet omits the connector is a real misconfig worth surfacing.
    if (!this.delivery.connector) {
      if (this.delivery.channel) {
        logger.warn(`Cron delivery has channel "${this.delivery.channel}" but no connector — skipping delivery`);
      }
      return undefined;
    }

    const connector = this.connectors.get(this.delivery.connector);
    if (!connector) {
      logger.warn(`Cron delivery connector "${this.delivery.connector}" not found`);
      return undefined;
    }

    const resolvedTarget: Target = {
      channel: target.channel || this.delivery.channel,
      thread: target.thread,
      messageTs: target.messageTs,
      replyContext: target.replyContext,
    };

    if (asReply) {
      const result = await connector.replyMessage(resolvedTarget, text);
      this.deliveredMessages++;
      this.deliveredTexts.push(text);
      return result;
    }
    const result = await connector.sendMessage(resolvedTarget, text);
    this.deliveredMessages++;
    this.deliveredTexts.push(text);
    return result;
  }
}
