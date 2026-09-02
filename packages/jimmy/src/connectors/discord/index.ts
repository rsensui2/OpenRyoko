import {
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageType,
  Partials,
  PermissionFlagsBits,
  type Message,
  type TextChannel,
  type DMChannel,
  type ThreadChannel,
} from "discord.js";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  DiscordReplyStyle,
  DiscordRespondToConfig,
  IncomingMessage,
  Target,
} from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { TMP_DIR } from "../../shared/paths.js";
import { formatResponse, downloadAttachment } from "./format.js";
import {
  deriveSessionKey,
  buildReplyContext,
  isOldMessage,
  threadNameFor,
  supportsMessageThreads,
} from "./threads.js";
import {
  evaluateRespondPolicy,
  resolveRespondMode,
  wasBotAddressed,
  addressesOnlyOthers,
  type ForwardedAddressing,
} from "./respond-policy.js";
import { EngagedThreadTracker } from "./engaged-threads.js";

/**
 * Speaker identity forwarded to the session layer, mirroring the Slack
 * connector's transportMeta fields. `speakerDiscordId` is the immutable
 * snowflake that operator identification (portal.operatorDiscordId) and the
 * MEMORY.md privacy gate (portal.trustedSpeakers) key on — names are display
 * only and freely editable.
 */
function speakerMeta(message: Message): {
  speakerName: string;
  speakerDisplayName: string | null;
  speakerHandle: string;
  speakerDiscordId: string;
  speakerIsBot: boolean;
} {
  return {
    speakerName:
      message.member?.displayName ?? message.author.globalName ?? message.author.username,
    speakerDisplayName: message.author.globalName ?? null,
    speakerHandle: message.author.username,
    speakerDiscordId: message.author.id,
    speakerIsBot: message.author.bot,
  };
}

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
  /** Where responses land in flat guild channels. Default: "channel". */
  replyStyle?: DiscordReplyStyle;
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
  private readonly replyStyle: DiscordReplyStyle;
  /**
   * Channels where thread creation failed for a channel-level reason
   * (missing permission / access). Both the session keying and the reply
   * destination consult this, so after one failed turn the channel settles
   * into consistent reply-style behavior instead of splitting every turn
   * into a fresh thread-keyed session. In-memory; resets with the connector.
   */
  private readonly threadStyleFailed = new Set<string>();

  constructor(config: DiscordConnectorConfig) {
    this.name = config.id || "discord";
    this.instanceId = config.id || "discord";
    this.config = config;
    // Hand-edited YAML: an invalid value degrades to the legacy behavior.
    this.replyStyle =
      config.replyStyle === "reply" || config.replyStyle === "thread"
        ? config.replyStyle
        : "channel";
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
      // Permissions may have changed while disconnected — let thread style
      // re-attempt channels it had given up on.
      this.threadStyleFailed.clear();
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
      const result = await this.sendChunks(
        { channel: channel as TextChannel | DMChannel | ThreadChannel },
        text,
      );
      if (result.error !== undefined) throw result.error;
      return result.lastId;
    } catch (err) {
      logger.error(`Discord sendMessage error: ${err instanceof Error ? err.message : err}`);
    }
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(target.thread ?? target.channel);
      if (!channel || !channel.isTextBased()) return;
      const destination = await this.resolveReplyDestination(
        channel as TextChannel | DMChannel | ThreadChannel,
        target,
      );
      const result = await this.sendChunks(destination, text);
      // A thread that accepts nothing (locked archive, missing
      // SEND_MESSAGES_IN_THREADS, private-thread access) must not swallow
      // the response: if not a single chunk landed in any thread — the one
      // thread style just opened, or the thread the message arrived in —
      // retry as a reply in the parent channel. A partial send stays where
      // it is; resending would duplicate the delivered chunks.
      if (result.error !== undefined && result.sentCount === 0 && destination.channel.isThread()) {
        // In the thread-style path `channel` is the flat parent we fetched
        // to resolve the thread; for a direct thread target the parent
        // comes from the thread itself.
        const parent = destination.viaThreadStyle
          ? (channel as TextChannel)
          : await this.client.channels
              .fetch((destination.channel as ThreadChannel).parentId ?? "")
              .catch(() => null);
        // A permission-shaped refusal will keep failing — remember it so
        // thread style stops opening threads nobody can post in. The
        // pre-flight permission check catches most of these; this covers
        // API-level denials that slip through.
        const code = (result.error as { code?: number }).code;
        if (code === 50013 || code === 50001) {
          const parentId = destination.viaThreadStyle
            ? channel.id
            : (destination.channel as ThreadChannel).parentId;
          if (parentId) this.threadStyleFailed.add(parentId);
        }
        logger.warn(
          `[discord] sending into thread ${destination.channel.id} failed (${result.error instanceof Error ? result.error.message : result.error}) — falling back to a reply in the parent channel`,
        );
        if (parent && parent.isTextBased() && !parent.isThread()) {
          const retry = await this.sendChunks(
            // A reply reference must live in the parent channel — in-thread
            // message IDs are invisible there. A message-rooted thread
            // shares its starter message's ID, so referencing the thread ID
            // attaches the fallback to the conversation's root (and merely
            // degrades to a plain post for channel-rooted threads, thanks
            // to failIfNotExists: false).
            { channel: parent as TextChannel | DMChannel, replyTo: destination.channel.id },
            text,
          );
          if (retry.error !== undefined) throw retry.error;
          return retry.lastId;
        }
        throw result.error;
      }
      if (result.error !== undefined && result.sentCount === 0) throw result.error;
      if (result.error !== undefined) {
        logger.error(
          `Discord replyMessage partial send (${result.sentCount} chunk(s) delivered): ${result.error instanceof Error ? result.error.message : result.error}`,
        );
      }
      return result.lastId;
    } catch (err) {
      logger.error(`Discord replyMessage error: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Send a response in Discord-sized chunks. Only the first chunk carries
   * the reply reference — one visual attachment per response, the rest
   * reads as its continuation. Engagement is recorded per delivered chunk,
   * so a partial send still counts. Failures are returned, not thrown, so
   * the caller can see how far the send got.
   */
  private async sendChunks(
    destination: { channel: TextChannel | DMChannel | ThreadChannel; replyTo?: string },
    text: string,
  ): Promise<{ lastId?: string; sentCount: number; error?: unknown }> {
    const chunks = formatResponse(text);
    let lastId: string | undefined;
    let sentCount = 0;
    for (const [index, chunk] of chunks.entries()) {
      try {
        const sent =
          destination.replyTo !== undefined && index === 0
            ? await destination.channel.send({
                content: chunk,
                reply: { messageReference: destination.replyTo, failIfNotExists: false },
              })
            : await destination.channel.send(chunk);
        lastId = sent.id;
        sentCount += 1;
        this.recordEngagement(destination.channel, sent.id);
      } catch (error) {
        return { lastId, sentCount, error };
      }
    }
    return { lastId, sentCount };
  }

  /**
   * Where a response physically lands. Threads and DMs are already precise
   * destinations and ignore replyStyle. In flat guild channels: "reply"
   * attaches the response to the triggering message, "thread" opens (or
   * reuses) the thread rooted on it, and "channel" keeps the legacy plain
   * send. The thread path falls back to "reply" when the channel can't host
   * message threads (voice/stage text chat) or when Discord refuses — a
   * channel-level refusal (missing permission/access) is remembered so the
   * session keying in handleMessage stops splitting turns into thread keys.
   */
  private async resolveReplyDestination(
    channel: TextChannel | DMChannel | ThreadChannel,
    target: Target,
  ): Promise<{
    channel: TextChannel | DMChannel | ThreadChannel;
    replyTo?: string;
    viaThreadStyle?: boolean;
  }> {
    if (channel.isThread() || channel.isDMBased()) return { channel };
    if (!target.messageTs || this.replyStyle === "channel") return { channel };
    if (
      this.replyStyle === "reply" ||
      !supportsMessageThreads(channel) ||
      this.threadStyleFailed.has(channel.id) ||
      !this.canOpenThreads(channel)
    ) {
      return { channel, replyTo: target.messageTs };
    }
    try {
      // A message's thread shares its ID — fetch it directly instead of
      // trusting the starter's cache (`Message#thread` misses archived
      // threads, which aren't synced on startup).
      const existing = await this.client.channels.fetch(target.messageTs).catch(() => null);
      if (existing?.isThread()) {
        return { channel: existing as ThreadChannel, viaThreadStyle: true };
      }
      const starter = await channel.messages.fetch(target.messageTs);
      const thread = await starter.startThread({ name: threadNameFor(starter.content) });
      return { channel: thread as ThreadChannel, viaThreadStyle: true };
    } catch (err) {
      const code = (err as { code?: number }).code;
      // 50013 Missing Permissions / 50001 Missing Access — channel-level,
      // will keep failing; remember it. Anything else (deleted starter…)
      // is message-level and the next turn starts clean.
      if (code === 50013 || code === 50001) this.threadStyleFailed.add(channel.id);
      logger.warn(
        `[discord] could not open a thread on message ${target.messageTs} (${err instanceof Error ? err.message : err}) — falling back to a reply`,
      );
      return { channel, replyTo: target.messageTs };
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
      this.recordEngagement(channel, target.messageTs);
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
    // Threads inherit their parent channel's route: a thread routes by its
    // own id when explicitly configured, else by the channel it lives in —
    // without this, a thread opened in a routed channel (replyStyle=thread
    // creates one per conversation) would silently fall back to local
    // handling.
    const parentChannelId = message.channel.isThread()
      ? message.channel.parentId ?? undefined
      : undefined;
    const routeTarget =
      this.config.channelRouting?.[message.channel.id] ??
      (parentChannelId !== undefined ? this.config.channelRouting?.[parentChannelId] : undefined);
    if (routeTarget) {
      logger.debug(`Routing Discord message from channel ${message.channel.id} to ${routeTarget}`);
      // References resolve only outside DMs here: the remote's dm policy is
      // unknown, and a routed-DM reply matters only under its dm=mention —
      // too rare to spend a REST fetch on every routed DM reply.
      const addressing = await this.resolveAddressing(message, {
        allowFetch: !message.channel.isDMBased(),
      });
      await this.proxyToRemote(routeTarget, message, addressing);
      return;
    }

    // Channel restriction — only respond in a specific channel, including
    // the threads that live in it (+ DMs always allowed)
    if (
      this.config.channelId &&
      message.channel.id !== this.config.channelId &&
      parentChannelId !== this.config.channelId &&
      !message.channel.isDMBased()
    ) return;

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

    const sessionKey = deriveSessionKey(message, this.instanceId, {
      threadPerMessage: this.threadSessionEligible(message),
    });
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
        isGroupDM: message.channel.type === ChannelType.GroupDM,
        ...speakerMeta(message),
      },
    };

    this.handler(incomingMessage);
  }

  /**
   * True when this flat-channel message's session should be keyed to the
   * thread the reply will open (replyStyle=thread). Mirrors exactly the
   * conditions under which resolveReplyDestination will actually attempt a
   * thread, so the session key and the reply destination never diverge:
   * channels that can't host message threads, channels where the bot lacks
   * the thread permissions right now (checked per turn against the live
   * permission cache), and channels where creation already failed at the
   * channel level all stay channel-keyed from the first turn.
   */
  private threadSessionEligible(message: Message): boolean {
    return (
      this.replyStyle === "thread" &&
      !message.channel.isDMBased() &&
      !message.channel.isThread() &&
      supportsMessageThreads(message.channel) &&
      !this.threadStyleFailed.has(message.channel.id) &&
      this.canOpenThreads(message.channel)
    );
  }

  /**
   * Pre-flight permission check for thread style, evaluated against the
   * cached guild permissions so it costs no request. Optimistic when the
   * answer is unknowable (no permissionsFor on the channel shape, member
   * not cached) — the failure path in replyMessage self-heals those.
   */
  private canOpenThreads(channel: {
    permissionsFor?(user: unknown): { has(flag: bigint): boolean } | null;
  }): boolean {
    const me = this.client.user;
    if (!me || typeof channel.permissionsFor !== "function") return true;
    const perms = channel.permissionsFor(me);
    if (!perms) return true;
    return (
      perms.has(PermissionFlagsBits.CreatePublicThreads) &&
      perms.has(PermissionFlagsBits.SendMessagesInThreads)
    );
  }

  /**
   * Track engagement for the `respondTo.engagedThreads` continuation. Only
   * anchor-eligible IDs whose engagement can actually be consumed are kept:
   * the thread itself, or — in flat guild channels — the acted-on message,
   * since a public thread created from a message reuses its ID. DM and
   * in-thread message IDs can never root a thread and are never recorded,
   * which keeps the unbounded tracker's real footprint small.
   */
  private recordEngagement(
    channel: { id: string; isThread(): boolean; isDMBased(): boolean; parentId?: string | null },
    anchorMessageId?: string,
  ): void {
    if (channel.isThread()) {
      if (this.consumesEngagement(channel.id, channel.parentId ?? undefined)) {
        this.engagedThreads.record(channel.id);
      }
      return;
    }
    if (
      anchorMessageId &&
      !channel.isDMBased() &&
      this.consumesEngagement(anchorMessageId, channel.id)
    ) {
      this.engagedThreads.record(anchorMessageId);
    }
  }

  /**
   * True when engagement recorded under this id can ever be read back. The
   * local gate consults the tracker only when the channel scope is
   * mention-gated with engagedThreads on (DMs have no threads, so dm=mention
   * alone consumes nothing). The routed path consults it for messages whose
   * channel id — or, for threads, parent channel id — is a channelRouting
   * key; for a flat-channel anchor the future thread's parent is the channel
   * itself, so its route counts too.
   */
  private consumesEngagement(id: string, parentChannelId?: string): boolean {
    if (
      resolveRespondMode(this.config.respondTo, "channel") === "mention" &&
      this.config.respondTo?.engagedThreads !== false
    ) {
      return true;
    }
    if (this.config.channelRouting?.[id] !== undefined) return true;
    return parentChannelId !== undefined && this.config.channelRouting?.[parentChannelId] !== undefined;
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
        // The primary's replyStyle renders every proxied send, so its
        // thread-per-message session mapping applies to routed channels too.
        sessionKey: deriveSessionKey(message, undefined, {
          threadPerMessage: this.threadSessionEligible(message),
        }),
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
          isGroupDM: message.channel.type === ChannelType.GroupDM,
          ...speakerMeta(message),
          // Precomputed here (only this instance knows the bot user,
          // resolves references, and tracks engagement) so the receiving
          // instance can apply its own respondTo gate without another
          // Discord round-trip.
          ...({
            wasBotAddressed: wasBotAddressed(addressing),
            addressesOnlyOthers: addressesOnlyOthers(addressing),
            isEngagedThread:
              message.channel.isThread() && this.engagedThreads.has(message.channel.id),
          } satisfies ForwardedAddressing),
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
