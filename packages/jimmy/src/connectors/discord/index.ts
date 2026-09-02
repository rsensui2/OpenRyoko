import {
  Client,
  GatewayIntentBits,
  MessageType,
  Partials,
  type Message,
  type TextChannel,
  type DMChannel,
  type ThreadChannel,
} from "discord.js";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  DiscordRespondToConfig,
  IncomingMessage,
  Target,
} from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { TMP_DIR } from "../../shared/paths.js";
import { formatResponse, downloadAttachment } from "./format.js";
import { deriveSessionKey, buildReplyContext, isOldMessage } from "./threads.js";
import {
  evaluateRespondPolicy,
  resolveRespondMode,
  wasBotAddressed,
  addressesOnlyOthers,
} from "./respond-policy.js";
import { EngagedThreadTracker } from "./engaged-threads.js";

export interface DiscordConnectorConfig {
  /** Unique instance identifier (e.g. "discord-vox") */
  id?: string;
  /** Employee to handle messages from this connector instance */
  employee?: string;
  botToken?: string;
  allowFrom?: string | string[];
  ignoreOldMessagesOnBoot?: boolean;
  guildId?: string;
  /** Only respond to messages in this channel (right-click channel → Copy Channel ID) */
  channelId?: string;
  /** Route messages from specific channels to remote Jinn instances */
  channelRouting?: Record<string, string>;
  /** If set, this instance proxies all Discord operations through the primary instance at this URL */
  proxyVia?: string;
  /** Deterministic per-scope response gate (DM / channel). See DiscordRespondToConfig. */
  respondTo?: DiscordRespondToConfig;
}

export class DiscordConnector implements Connector {
  name: string;
  instanceId: string;
  private client: Client;
  private config: DiscordConnectorConfig;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private bootTimeMs = Date.now();
  private allowedUserIds: Set<string>;
  private status: "starting" | "running" | "stopped" | "error" = "starting";
  private lastError: string | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private engagedThreads = new EngagedThreadTracker();

  constructor(config: DiscordConnectorConfig) {
    this.name = config.id || "discord";
    this.instanceId = config.id || "discord";
    this.config = config;
    // Normalize Discord IDs to strings (YAML may parse large snowflake IDs as numbers)
    if (this.config.guildId) this.config.guildId = String(this.config.guildId);
    if (this.config.channelId) this.config.channelId = String(this.config.channelId);
    if (this.config.channelRouting) {
      this.config.channelRouting = Object.fromEntries(
        Object.entries(this.config.channelRouting).map(([k, v]) => [String(k), v])
      );
    }
    this.allowedUserIds = new Set(
      Array.isArray(config.allowFrom)
        ? config.allowFrom
        : config.allowFrom
        ? [config.allowFrom]
        : [],
    );
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  getEmployee(): string | undefined {
    return this.config.employee;
  }

  async start(): Promise<void> {
    this.client.on("ready", () => {
      logger.info(`Discord connector ready as ${this.client.user?.tag}`);
      this.status = "running";
    });

    this.client.on("messageCreate", async (message) => {
      try {
        await this.handleMessage(message);
      } catch (err) {
        logger.error(`Discord message handler error: ${err instanceof Error ? err.message : err}`);
      }
    });

    this.client.on("error", (err) => {
      this.lastError = err.message;
      this.status = "error";
      logger.error(`Discord client error: ${err.message}`);
    });

    await this.client.login(this.config.botToken);
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    await this.client.destroy();
    logger.info("Discord connector stopped");
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
      status: this.status === "running" ? "running" : this.status === "error" ? "error" : "stopped",
      detail: this.lastError ?? undefined,
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
    try {
      const channel = await this.client.channels.fetch(target.channel);
      if (!channel || !channel.isTextBased()) return;
      const chunks = formatResponse(text);
      let lastId: string | undefined;
      for (const chunk of chunks) {
        const sent = await (channel as TextChannel | DMChannel | ThreadChannel).send(chunk);
        lastId = sent.id;
        // Record per chunk, so a partial send still counts as engagement.
        // The sent message ID is an anchor too: a future public thread
        // created from it reuses that ID.
        if (channel.isThread()) this.engagedThreads.record(channel.id);
        this.engagedThreads.record(sent.id);
      }
      return lastId;
    } catch (err) {
      logger.error(`Discord sendMessage error: ${err instanceof Error ? err.message : err}`);
    }
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(target.thread ?? target.channel);
      if (!channel || !channel.isTextBased()) return;
      const chunks = formatResponse(text);
      let lastId: string | undefined;
      for (const chunk of chunks) {
        const sent = await (channel as TextChannel | DMChannel | ThreadChannel).send(chunk);
        lastId = sent.id;
        // Record per chunk, so a partial send still counts as engagement.
        // The sent message ID is an anchor too: a future public thread
        // created from it reuses that ID.
        if (channel.isThread()) this.engagedThreads.record(channel.id);
        this.engagedThreads.record(sent.id);
      }
      return lastId;
    } catch (err) {
      logger.error(`Discord replyMessage error: ${err instanceof Error ? err.message : err}`);
    }
  }

  async editMessage(target: Target, text: string): Promise<void> {
    try {
      if (!target.messageTs) return;
      const channel = await this.client.channels.fetch(target.channel);
      if (!channel || !channel.isTextBased()) return;
      const msg = await (channel as TextChannel).messages.fetch(target.messageTs);
      await msg.edit(text.slice(0, 2000));
    } catch (err) {
      logger.error(`Discord editMessage error: ${err instanceof Error ? err.message : err}`);
    }
  }

  async addReaction(target: Target, emoji: string): Promise<void> {
    try {
      if (!target.messageTs) return;
      const channel = await this.client.channels.fetch(target.thread ?? target.channel);
      if (!channel || !channel.isTextBased()) return;
      const msg = await (channel as TextChannel).messages.fetch(target.messageTs);
      await msg.react(emoji);
      // A reaction engages the surrounding thread, and marks the reacted
      // message as an anchor — a future thread created from it shares its ID.
      if (channel.isThread()) this.engagedThreads.record(channel.id);
      this.engagedThreads.record(target.messageTs);
    } catch {
      // non-fatal
    }
  }

  async removeReaction(target: Target, emoji: string): Promise<void> {
    try {
      if (!target.messageTs) return;
      const channel = await this.client.channels.fetch(target.thread ?? target.channel);
      if (!channel || !channel.isTextBased()) return;
      const msg = await (channel as TextChannel).messages.fetch(target.messageTs);
      await msg.reactions.cache.get(emoji)?.users.remove(this.client.user?.id);
    } catch {
      // non-fatal
    }
  }

  async setTypingStatus(channelId: string, _threadTs: string | undefined, status: string): Promise<void> {
    const existing = this.typingIntervals.get(channelId);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(channelId);
    }
    if (!status) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await (channel as TextChannel).sendTyping();
        // Discord typing expires after 10s — refresh every 8s
        const interval = setInterval(async () => {
          try {
            await (channel as TextChannel).sendTyping();
          } catch { /* non-fatal */ }
        }, 8_000);
        this.typingIntervals.set(channelId, interval);
      }
    } catch {
      // non-fatal
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bots (including self), webhooks, and Discord-generated system
    // messages (joins, pins, thread-created…) — none of these are user turns.
    if (message.author.bot || message.system || message.webhookId) return;
    logger.debug(`Discord message from ${message.author.username} in channel ${message.channel.id}`);

    // Ignore old messages on boot
    if (
      this.config.ignoreOldMessagesOnBoot !== false &&
      isOldMessage(message.createdTimestamp, this.bootTimeMs)
    ) return;

    // Guild restriction
    if (this.config.guildId && message.guild?.id !== this.config.guildId) return;

    // Channel routing — proxy messages to remote instances. Addressing and
    // thread engagement are resolved here and forwarded: only this instance
    // sees the Discord gateway, and proxied sends run through this
    // connector, so its tracker is the source of truth for engagement.
    const routeTarget = this.config.channelRouting?.[message.channel.id];
    if (routeTarget) {
      logger.debug(`Routing Discord message from channel ${message.channel.id} to ${routeTarget}`);
      const addressing = await this.resolveAddressing(message, { allowFetch: true });
      await this.proxyToRemote(routeTarget, message, addressing);
      return;
    }

    // Channel restriction — only respond in a specific channel (+ DMs always allowed)
    if (this.config.channelId && message.channel.id !== this.config.channelId && !message.channel.isDMBased()) return;

    // User allowlist
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(message.author.id)) return;

    // Deterministic respondTo gate — the Discord port of the Slack gate.
    // Addressing resolves after the cheap filters above, so filtered
    // messages never cost a reference fetch; in DMs the fetch only matters
    // under dm=mention (the sibling rule below never applies to DMs).
    // botUserId is set once the client is ready (messageCreate never fires
    // earlier); if it were somehow missing, mention scopes fail closed.
    const isDM = message.channel.isDMBased();
    const addressing = await this.resolveAddressing(message, {
      allowFetch: !isDM || resolveRespondMode(this.config.respondTo, "dm") === "mention",
    });
    const respondDecision = evaluateRespondPolicy({
      config: this.config.respondTo,
      isDM,
      wasMentioned: wasBotAddressed(addressing),
      isEngagedThread:
        message.channel.isThread() && this.engagedThreads.has(message.channel.id),
    });
    if (!respondDecision.allow) {
      logger.info(
        `[discord] respondTo gate → silent (${respondDecision.reason}) for message ${message.id}`,
      );
      return;
    }

    // Cross-user traffic in shared channels: a message that @-mentions or
    // replies to somebody else (and not us) is addressed to them, not the
    // bot — stay silent regardless of respondTo mode or thread engagement,
    // mirroring the Slack connector's sibling-mention rule.
    if (!isDM && addressesOnlyOthers(addressing)) {
      logger.info(
        `[discord] message addresses other user(s) — staying silent for message ${message.id}`,
      );
      return;
    }

    if (!this.handler) return;

    const sessionKey = deriveSessionKey(message, this.instanceId);
    const replyContext = buildReplyContext(message);

    // Download attachments
    const attachments = await Promise.all(
      Array.from(message.attachments.values()).map(async (att) => {
        try {
          const localPath = await downloadAttachment(att.url, TMP_DIR, att.name);
          return { name: att.name, localPath, mimeType: att.contentType ?? "application/octet-stream" };
        } catch {
          return null;
        }
      }),
    ).then((results) => results.filter(Boolean) as Array<{ name: string; localPath: string; mimeType: string }>);

    const incomingMessage: IncomingMessage = {
      connector: this.instanceId,
      source: "discord",
      sessionKey,
      channel: message.channel.id,
      thread: message.channel.isThread() ? message.channel.id : undefined,
      user: message.author.username,
      userId: message.author.id,
      text: message.content,
      attachments: attachments.map((a) => ({
        name: a.name,
        url: "",
        mimeType: a.mimeType,
        localPath: a.localPath,
      })),
      replyContext,
      messageId: message.id,
      raw: message,
      transportMeta: {
        channelName: message.channel.isTextBased() && "name" in message.channel
          ? (message.channel as TextChannel).name
          : "dm",
        guildId: message.guild?.id ?? null,
        isDM: message.channel.isDMBased(),
      },
    };

    this.handler(incomingMessage);
  }

  /**
   * Resolve who the message addresses. Reply attribution applies only to
   * actual replies (`MessageType.Reply`) — a crosspost or forward also
   * carries a `reference` but addresses nobody. `mentions.repliedUser` comes
   * from the gateway's resolved reference and works whether or not the reply
   * pinged; when Discord omitted the resolution and `allowFetch` is set,
   * fall back to one fetch of the referenced message. A deleted reference
   * stays undefined — no addressee.
   */
  private async resolveAddressing(
    message: Message,
    opts: { allowFetch: boolean },
  ): Promise<{
    botUserId: string | undefined;
    mentionedUserIds: Set<string>;
    repliedToUserId: string | undefined;
  }> {
    const isReply = message.type === MessageType.Reply;
    let repliedToUserId = isReply ? message.mentions.repliedUser?.id : undefined;
    if (isReply && repliedToUserId === undefined && opts.allowFetch && message.reference?.messageId) {
      try {
        const referenced = await message.fetchReference();
        repliedToUserId = referenced.author?.id;
      } catch {
        // Referenced message deleted or inaccessible.
      }
    }
    return {
      botUserId: this.client.user?.id,
      mentionedUserIds: new Set(message.mentions.users.keys()),
      repliedToUserId,
    };
  }

  /** Forward a message to a remote Jinn instance via HTTP */
  private async proxyToRemote(
    remoteUrl: string,
    message: Message,
    addressing: Parameters<typeof wasBotAddressed>[0],
  ): Promise<void> {
    try {
      const attachments = Array.from(message.attachments.values()).map((att) => ({
        name: att.name,
        url: att.url,
        mimeType: att.contentType ?? "application/octet-stream",
      }));

      const payload = {
        sessionKey: deriveSessionKey(message),
        channel: message.channel.id,
        thread: message.channel.isThread() ? message.channel.id : undefined,
        user: message.author.username,
        userId: message.author.id,
        text: message.content,
        messageId: message.id,
        attachments,
        replyContext: buildReplyContext(message),
        transportMeta: {
          channelName: message.channel.isTextBased() && "name" in message.channel
            ? (message.channel as TextChannel).name
            : "dm",
          guildId: message.guild?.id ?? null,
          isDM: message.channel.isDMBased(),
          // ForwardedAddressing — precomputed here (only this instance knows
          // the bot user, resolves references, and tracks engagement) so the
          // receiving instance can apply its own respondTo gate without
          // another Discord round-trip.
          wasBotAddressed: wasBotAddressed(addressing),
          addressesOnlyOthers: addressesOnlyOthers(addressing),
          isEngagedThread:
            message.channel.isThread() && this.engagedThreads.has(message.channel.id),
        },
      };

      const res = await fetch(`${remoteUrl.replace(/\/+$/, "")}/api/connectors/discord/incoming`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        logger.error(`Failed to proxy Discord message to ${remoteUrl}: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      logger.error(`Discord proxy error to ${remoteUrl}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
