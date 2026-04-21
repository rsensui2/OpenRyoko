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
import { normalizeSpeakerInfo, type SpeakerInfo } from "./speaker.js";
import { runTriage } from "./triage.js";
import { ActiveThreadTracker } from "./active-threads.js";
import type { SlackTriageConfig } from "../../shared/types.js";
import { TMP_DIR } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";

export interface SlackConnectorContext {
  /** Display name of the Jinn instance (used as botName in triage) */
  portalName?: string;
  /** Configured operator name — used to identify operator vs third party */
  operatorName?: string;
}

export class SlackConnector implements Connector {
  name = "slack";
  private app: App;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private readonly allowedUsers: Set<string> | null;
  private readonly ignoreOldMessagesOnBoot: boolean;
  private readonly bootTimeMs = Date.now();
  private started = false;
  private lastError: string | null = null;
  private channelNameCache = new Map<string, { name: string; cachedAt: number }>();
  private userInfoCache = new Map<string, { info: SpeakerInfo; cachedAt: number }>();
  private botUserId: string | null = null;
  private readonly triageConfig: SlackTriageConfig | undefined;
  private readonly portalName: string | undefined;
  private readonly operatorName: string | undefined;
  private readonly activeThreads: ActiveThreadTracker;
  private static CHANNEL_CACHE_TTL_MS = 3600_000; // 1 hour
  private static USER_CACHE_TTL_MS = 3600_000; // 1 hour
  private static ACTIVE_THREAD_TTL_MS_DEFAULT = 600_000; // 10 minutes

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

  constructor(config: SlackConnectorConfig, context: SlackConnectorContext = {}) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
    this.ignoreOldMessagesOnBoot = config.ignoreOldMessagesOnBoot !== false;
    const allowFrom = Array.isArray(config.allowFrom)
      ? config.allowFrom
      : typeof config.allowFrom === "string"
        ? config.allowFrom.split(",").map((value) => value.trim()).filter(Boolean)
        : [];
    this.allowedUsers = allowFrom.length > 0 ? new Set(allowFrom) : null;
    this.triageConfig = config.triage;
    this.portalName = context.portalName;
    this.operatorName = context.operatorName;
    this.activeThreads = new ActiveThreadTracker(
      config.triage?.activeThreadTtlMs ?? SlackConnector.ACTIVE_THREAD_TTL_MS_DEFAULT,
    );
  }

  private async resolveSpeakerInfo(userId: string | undefined): Promise<SpeakerInfo | null> {
    if (!userId) return null;
    const cached = this.userInfoCache.get(userId);
    if (cached && Date.now() - cached.cachedAt < SlackConnector.USER_CACHE_TTL_MS) {
      return cached.info;
    }
    try {
      const result = await this.app.client.users.info({ user: userId });
      const info = normalizeSpeakerInfo(result.user as any, userId);
      this.userInfoCache.set(userId, { info, cachedAt: Date.now() });
      return info;
    } catch (err) {
      logger.debug(`Failed to resolve speaker info for ${userId}: ${err}`);
      return null;
    }
  }

  private speakerTransportFields(speaker: SpeakerInfo | null, userId: string) {
    return {
      speakerName: speaker?.name ?? null,
      speakerRealName: speaker?.realName ?? null,
      speakerDisplayName: speaker?.displayName ?? null,
      speakerHandle: speaker?.handle ?? null,
      speakerSlackId: userId,
      speakerIsBot: speaker?.isBot ?? null,
      speakerTz: speaker?.tz ?? null,
    };
  }

  private async runSlackTriage(
    event: { channel: string; ts?: string; thread_ts?: string },
    ctx: {
      speaker: SpeakerInfo | null;
      channelType: string;
      channelName?: string;
      wasMentioned: boolean;
      messageText: string;
    },
  ): Promise<{ action: "silent" | "react" | "reply"; emoji?: string; reason?: string }> {
    const threadLimit = this.triageConfig?.threadContextLimit ?? 10;
    const recentThread = await this.fetchRecentThreadForTriage(
      event.channel,
      event.thread_ts,
      event.ts,
      threadLimit,
    );

    const speakerName = ctx.speaker?.name ?? "unknown";
    const speakerIsOperator = !!this.operatorName && !!ctx.speaker && [
      ctx.speaker.name,
      ctx.speaker.realName,
      ctx.speaker.displayName,
      ctx.speaker.handle,
    ].filter((v): v is string => !!v).includes(this.operatorName);

    const channelDescription = ctx.channelName ? `#${ctx.channelName}` : event.channel;

    return runTriage(
      {
        botName: this.portalName || "Ryoko",
        persona: this.triageConfig?.persona,
        operatorName: this.operatorName,
        channelType: ctx.channelType,
        channelDescription,
        speakerName,
        speakerIsOperator,
        wasMentioned: ctx.wasMentioned,
        recentThread,
        messageText: ctx.messageText,
      },
      {
        bin: this.triageConfig?.bin,
        model: this.triageConfig?.model,
        timeoutMs: this.triageConfig?.timeoutMs,
      },
    );
  }

  private async fetchRecentThreadForTriage(
    channelId: string,
    threadTs: string | undefined,
    messageTs: string | undefined,
    limit: number,
  ): Promise<Array<{ speaker: string; text: string }>> {
    try {
      const messages = threadTs
        ? (await this.app.client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            limit: Math.max(1, limit),
          })).messages
        : (await this.app.client.conversations.history({
            channel: channelId,
            limit: Math.max(1, limit),
            latest: messageTs,
            inclusive: false,
          })).messages;

      if (!messages) return [];
      const chronological = threadTs ? messages : [...messages].reverse();
      const result: Array<{ speaker: string; text: string }> = [];
      for (const m of chronological) {
        const text = (m as any).text as string | undefined;
        if (!text) continue;
        const userId = (m as any).user as string | undefined;
        const botId = (m as any).bot_id as string | undefined;
        const speakerLabel = userId
          ? (await this.resolveSpeakerInfo(userId))?.name ?? userId
          : botId
            ? `bot:${botId}`
            : "unknown";
        result.push({ speaker: speakerLabel, text });
      }
      return result;
    } catch (err) {
      logger.debug(`[triage] failed to fetch recent thread: ${err}`);
      return [];
    }
  }

  private async resolveChannelName(channelId: string): Promise<string | undefined> {
    const cached = this.channelNameCache.get(channelId);
    if (cached && Date.now() - cached.cachedAt < SlackConnector.CHANNEL_CACHE_TTL_MS) {
      return cached.name;
    }
    try {
      const result = await this.app.client.conversations.info({ channel: channelId });
      const name = result.channel?.name;
      if (name) {
        this.channelNameCache.set(channelId, { name, cachedAt: Date.now() });
        return name;
      }
    } catch (err) {
      logger.debug(`Failed to resolve channel name for ${channelId}: ${err}`);
    }
    return undefined;
  }

  async start() {
    this.app.message(async ({ event }) => {
      logger.info(`[slack] Received message event: user=${(event as any).user} channel=${(event as any).channel} text="${((event as any).text || "").slice(0, 50)}"`);
      // Skip bot's own messages
      if ((event as any).bot_id) {
        logger.info(`[slack] Skipping bot message`);
        return;
      }
      // Skip ghost events from URL unfurls (user=undefined, text="")
      if (!(event as any).user) {
        logger.debug(`[slack] Skipping event with no user (likely URL unfurl)`);
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

      const sessionKey = deriveSessionKey(event as any);
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

      const slackUserId = (event as any).user as string;
      const [channelName, speaker] = await Promise.all([
        this.resolveChannelName((event as any).channel),
        this.resolveSpeakerInfo(slackUserId),
      ]);

      const channelType = ((event as any).channel_type as string) || "channel";
      const rawText = ((event as any).text || "") as string;
      const wasMentioned = !!this.botUserId && rawText.includes(`<@${this.botUserId}>`);

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
        text: parentContext + rawText,
        attachments,
        raw: event,
        transportMeta: {
          channelType,
          team: ((event as any).team as string) || null,
          channelName: channelName || null,
          wasMentioned,
          ...this.speakerTransportFields(speaker, slackUserId),
        },
      };

      // Air-reading triage gate.
      // Fast paths that bypass the LLM triage entirely:
      //   - DMs: always reply (1:1 context is implicitly addressed to the bot)
      //   - Explicit @-mention: always reply
      //   - Active thread: bot recently participated → follow-up is implicitly addressed.
      //     This prevents triage from silently dropping mid-skill / mid-conversation messages.
      const triageEnabled = this.triageConfig?.enabled === true;
      const threadKey = ((event as any).thread_ts || (event as any).ts) as string | undefined;
      const isActiveThread = this.activeThreads.isActive((event as any).channel, threadKey);
      const skipTriage = !triageEnabled || channelType === "im" || wasMentioned || isActiveThread;

      if (triageEnabled && isActiveThread && !wasMentioned && channelType !== "im") {
        logger.info(`[slack] skipping triage — thread ${(event as any).channel}:${threadKey} is active`);
      }

      if (!skipTriage) {
        const decision = await this.runSlackTriage(event as any, {
          speaker,
          channelType,
          channelName: channelName ?? undefined,
          wasMentioned,
          messageText: rawText,
        });

        if (decision.action === "silent") {
          logger.info(`[slack] triage → silent (${decision.reason ?? "no reason"}) for ts=${(event as any).ts}`);
          return;
        }
        if (decision.action === "react") {
          const emoji = decision.emoji || "eyes";
          logger.info(`[slack] triage → react :${emoji}: (${decision.reason ?? "no reason"}) for ts=${(event as any).ts}`);
          try {
            await this.app.client.reactions.add({
              channel: (event as any).channel,
              timestamp: (event as any).ts,
              name: emoji,
            });
          } catch (err) {
            logger.debug(`[slack] failed to add triage reaction: ${err}`);
          }
          return;
        }
        logger.info(`[slack] triage → reply (${decision.reason ?? "no reason"}) for ts=${(event as any).ts}`);
      }

      this.handler(msg);
    });

    // Fetch bot's own user ID for filtering self-reactions
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id ?? null;
      logger.info(`[slack] Bot user ID: ${this.botUserId}`);
    } catch (err) {
      logger.warn(`[slack] Failed to get bot user ID: ${err}`);
    }

    this.app.event("reaction_added", async ({ event }) => {
      // Only handle reactions on messages (not files, etc.)
      if (event.item.type !== "message") return;

      // Skip bot's own reactions
      if (this.botUserId && event.user === this.botUserId) return;

      if (!this.handler) return;

      // Check allowed users
      if (this.allowedUsers && !this.allowedUsers.has(event.user)) {
        logger.debug(`Ignoring reaction from unauthorized user ${event.user}`);
        return;
      }

      const channelId = event.item.channel;
      const messageTs = event.item.ts;
      const emoji = event.reaction;

      // Skip old reactions replayed on boot
      if (this.ignoreOldMessagesOnBoot && isOldSlackMessage(messageTs, this.bootTimeMs)) {
        logger.debug(`Ignoring old Slack reaction on ${messageTs}`);
        return;
      }

      logger.info(`[slack] Reaction :${emoji}: by ${event.user} on ${channelId}:${messageTs}`);

      // Fetch the reacted-to message text
      // Try conversations.history first (works for root messages),
      // fall back to conversations.replies (for threaded messages)
      let messageText = "";
      try {
        const histResult = await this.app.client.conversations.history({
          channel: channelId,
          latest: messageTs,
          oldest: messageTs,
          inclusive: true,
          limit: 1,
        });
        messageText = histResult.messages?.[0]?.text || "";

        // If not found in history, try as a threaded reply
        if (!messageText) {
          const replyResult = await this.app.client.conversations.replies({
            channel: channelId,
            ts: messageTs,
            limit: 1,
            inclusive: true,
          });
          messageText = replyResult.messages?.[0]?.text || "";
        }
      } catch (err) {
        logger.warn(`[slack] Failed to fetch reacted-to message: ${err}`);
        return;
      }

      if (!messageText) {
        logger.debug(`[slack] Reacted-to message has no text, skipping`);
        return;
      }

      // Resolve channel name and reactor (speaker) in parallel
      const [channelName, speaker] = await Promise.all([
        this.resolveChannelName(channelId),
        this.resolveSpeakerInfo(event.user),
      ]);
      const channelDisplay = channelName ? `#${channelName}` : channelId;

      // Build the prompt with reaction context
      const prompt = `[Reaction :${emoji}: on message in ${channelDisplay}]\n\nOriginal message:\n"${messageText}"\n\nThe user reacted with :${emoji}: to this message. Interpret and act on the reaction.`;

      const sessionKey = `slack:reaction:${channelId}:${messageTs}`;

      const msg: IncomingMessage = {
        connector: this.name,
        source: "slack",
        sessionKey,
        replyContext: {
          channel: channelId,
          thread: messageTs,
          messageTs,
        },
        messageId: messageTs,
        channel: channelId,
        thread: messageTs,
        user: event.user,
        userId: event.user,
        text: prompt,
        attachments: [],
        raw: event,
        transportMeta: {
          channelType: "channel",
          team: null,
          channelName: channelName || null,
          ...this.speakerTransportFields(speaker, event.user),
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
    // A newly-posted root message will be the thread_ts for any follow-up replies,
    // so record it as active under its own ts.
    if (lastTs) this.activeThreads.touch(target.channel, lastTs);
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
    // Record the thread the bot just replied in. Subsequent user replies in
    // this same thread will carry thread_ts === threadTs and bypass triage.
    if (threadTs) this.activeThreads.touch(target.channel, threadTs);
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
    // A reaction on a message also counts as participation; touch the target's
    // thread anchor so follow-ups in that thread are treated as active.
    this.activeThreads.touch(target.channel, target.thread || target.messageTs);
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
