import { App } from "@slack/bolt";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  ReplyContext,
  SlackConnectorConfig,
  SlackRespondToConfig,
  Target,
  SlackGoalExtractionConfig,
} from "../../shared/types.js";
import { buildReplyContext, deriveSessionKey, isOldSlackMessage } from "./threads.js";
import {
  downloadAttachment,
  formatAttachmentFailureNotice,
  formatResponse,
  resolveSlackFileAttachment,
} from "./format.js";
import { normalizeSpeakerInfo, type SpeakerInfo } from "./speaker.js";
import { runTriage } from "./triage.js";
import {
  shouldForceTaskContinuationReply,
  shouldRunReactOnlyTriage,
} from "./triage-prompt.js";
import {
  evaluateRespondPolicy,
  hasMentionScope,
  resolveRespondMode,
  respondPolicyNeedsTracking,
  shouldHandleReaction,
} from "./respond-policy.js";
import { isOperatorSpeaker } from "../../shared/operator-match.js";
import { explicitThread } from "../../shared/threading.js";
import { ConversationTracker } from "./conversation-tracker.js";
import { AgentsCanvasUpdater } from "./agents-canvas.js";
import { extractGoalCondition, shouldExtractGoal } from "./goal-extractor.js";
import { startsWithSlashCommand } from "../../sessions/manager.js";
import type { SlackTriageConfig } from "../../shared/types.js";
import { TMP_DIR } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";

export interface SlackConnectorContext {
  /** Display name of the Jinn instance (used as botName in triage) */
  portalName?: string;
  /** Configured operator name — used to identify operator vs third party */
  operatorName?: string;
  /** Additional operator names/handles (portal.operatorAliases) — see operator-match.ts. */
  operatorAliases?: string[];
  /** Whether this connector's routed sessions can consume Claude-only /goal prompts. */
  goalInjectionEnabled?: boolean;
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
  private channelNameCache = new Map<string, { name?: string; isExtShared: boolean; cachedAt: number }>();
  private userInfoCache = new Map<string, { info: SpeakerInfo; cachedAt: number }>();
  private botUserId: string | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private readonly triageConfig: SlackTriageConfig | undefined;
  private readonly respondTo: SlackRespondToConfig | undefined;
  private readonly goalExtractionConfig: SlackGoalExtractionConfig | undefined;
  private readonly portalName: string | undefined;
  private readonly operatorName: string | undefined;
  private readonly operatorAliases: string[] | undefined;
  private readonly goalInjectionEnabled: boolean;
  private readonly conversations: ConversationTracker;
  private readonly agentsCanvas: AgentsCanvasUpdater | null;
  private static CHANNEL_CACHE_TTL_MS = 3600_000; // 1 hour
  private static USER_CACHE_TTL_MS = 3600_000; // 1 hour

  private readonly capabilities: ConnectorCapabilities = {
    threading: true,
    messageEdits: true,
    reactions: true,
    attachments: true,
  };

  private formatSlackError(err: unknown): string {
    if (err instanceof Error) {
      const data = (err as any).data;
      const slackError = data?.error ? ` (${data.error})` : "";
      const detail = data?.detail ? `: ${data.detail}` : "";
      return `${err.message}${slackError}${detail}`;
    }
    return String(err);
  }

  private async sendTypingStatus(channelId: string, threadTs: string, status: string): Promise<void> {
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
      logger.warn(`Slack typing status failed: ${this.formatSlackError(err)}`);
    }
  }

  /**
   * Set the AI assistant typing status in a thread.
   * Uses Slack's assistant.threads.setStatus API for native animated indicator.
   */
  async setTypingStatus(channelId: string, threadTs: string | undefined, status: string): Promise<void> {
    if (!threadTs) return;
    const key = `${channelId}:${threadTs}`;
    const existing = this.typingIntervals.get(key);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(key);
    }

    await this.sendTypingStatus(channelId, threadTs, status);
    if (!status) return;

    // Slack clears assistant status after roughly two minutes if no message is
    // sent, so refresh while long-running engine calls are still active.
    const interval = setInterval(() => {
      this.sendTypingStatus(channelId, threadTs, status).catch(() => {});
    }, 90_000);
    this.typingIntervals.set(key, interval);
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
    this.respondTo = config.respondTo;
    this.goalExtractionConfig = config.goalExtraction;
    this.portalName = context.portalName;
    this.operatorName = context.operatorName;
    this.operatorAliases = context.operatorAliases;
    this.goalInjectionEnabled = context.goalInjectionEnabled === true;
    this.conversations = new ConversationTracker();
    this.agentsCanvas = config.agentsCanvas?.enabled
      ? new AgentsCanvasUpdater(this.app, config.agentsCanvas)
      : null;
  }

  /**
   * Conversation tracking feeds two consumers: triage DM-equivalence and the
   * respondTo engaged-thread exception. When neither is active, tracking is
   * skipped entirely — engaged entries can't be evicted, so tracking in the
   * default configuration would just leak memory.
   */
  private conversationTrackingEnabled(): boolean {
    return this.triageConfig?.enabled === true || respondPolicyNeedsTracking(this.respondTo);
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
      /** Short-ack in an established 1:1 conversation — triage runs in react-vs-reply mode. */
      dmEquivalent?: boolean;
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
    // Shared normalized matcher — the old exact `includes(operatorName)` never
    // matched a nickname operatorName against profile names, so triage saw the
    // operator as a third party (see operator-match.ts).
    const speakerIsOperator = !!ctx.speaker && isOperatorSpeaker(
      [ctx.speaker.name, ctx.speaker.realName, ctx.speaker.displayName, ctx.speaker.handle],
      this.operatorName,
      this.operatorAliases,
    );

    const channelDescription = ctx.channelName ? `#${ctx.channelName}` : event.channel;

    const decision = await runTriage(
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
        dmEquivalent: ctx.dmEquivalent,
      },
      {
        bin: this.triageConfig?.bin,
        engine: this.triageConfig?.engine,
        model: this.triageConfig?.model,
        timeoutMs: this.triageConfig?.timeoutMs,
        // Ambient messages (not DM, not @-mention, not active thread): when we
        // know our own ID, a fail-open *reply* is a guaranteed barge-in, so stay
        // silent; the legacy reply fallback only covers the startup race where
        // auth.test never resolved our botUserId. DM-equivalent short-acks are
        // the opposite — the message IS addressed to us, so a triage failure
        // must fall back to the full reply, never to ghosting.
        failOpenAction: ctx.dmEquivalent || !this.botUserId ? "reply" : "silent",
      },
    );

    if (
      decision.action === "react" &&
      shouldForceTaskContinuationReply({
        text: ctx.messageText,
        dmEquivalent: ctx.dmEquivalent === true,
        previousWasBot: recentThread.at(-1)?.isBot,
      })
    ) {
      logger.info(
        `[slack] triage react overridden — task continuation must reach session for ts=${event.ts}`,
      );
      return { action: "reply", reason: "task_continuation" };
    }

    return decision;
  }

  private async fetchRecentThreadForTriage(
    channelId: string,
    threadTs: string | undefined,
    messageTs: string | undefined,
    limit: number,
  ): Promise<Array<{ speaker: string; text: string; isBot: boolean }>> {
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
      const result: Array<{ speaker: string; text: string; isBot: boolean }> = [];
      for (const m of chronological) {
        // conversations.replies may include the event currently being triaged.
        // Exclude it so the last item really is the preceding speaker/message.
        if (messageTs && (m as any).ts === messageTs) continue;
        const text = (m as any).text as string | undefined;
        if (!text) continue;
        const userId = (m as any).user as string | undefined;
        const botId = (m as any).bot_id as string | undefined;
        const isBot = !!botId || (!!userId && userId === this.botUserId);
        const speakerLabel = isBot
          ? `bot:${botId ?? userId}`
          : userId
            ? (await this.resolveSpeakerInfo(userId))?.name ?? userId
            : "unknown";
        result.push({ speaker: speakerLabel, text, isBot });
      }
      return result;
    } catch (err) {
      logger.debug(`[triage] failed to fetch recent thread: ${err}`);
      return [];
    }
  }

  /**
   * Resolve channel name and external-shared status in one cached call.
   * `isExtShared` is true for Slack Connect (externally/org shared) channels —
   * the delivery layer treats these (and unknowns) as "external" so the model's
   * operator-facing notes are never posted there. See reply-disposition.ts.
   */
  private async resolveChannelInfo(channelId: string): Promise<{ name?: string; isExtShared: boolean }> {
    const cached = this.channelNameCache.get(channelId);
    if (cached && Date.now() - cached.cachedAt < SlackConnector.CHANNEL_CACHE_TTL_MS) {
      return { name: cached.name, isExtShared: cached.isExtShared };
    }
    try {
      const result = await this.app.client.conversations.info({ channel: channelId });
      const channel = result.channel as { name?: string; is_ext_shared?: boolean; is_org_shared?: boolean; is_shared?: boolean } | undefined;
      const name = channel?.name;
      const isExtShared = !!(channel?.is_ext_shared || channel?.is_org_shared || channel?.is_shared);
      this.channelNameCache.set(channelId, { name, isExtShared, cachedAt: Date.now() });
      return { name, isExtShared };
    } catch (err) {
      logger.debug(`Failed to resolve channel info for ${channelId}: ${err}`);
    }
    // Unknown → treat as external (safe): never assume a channel is private.
    return { name: undefined, isExtShared: true };
  }

  private async resolveChannelName(channelId: string): Promise<string | undefined> {
    return (await this.resolveChannelInfo(channelId)).name;
  }

  async start() {
    this.app.message(async ({ event }) => {
      logger.info(`[slack] Received message event: user=${(event as any).user} channel=${(event as any).channel} channel_type=${(event as any).channel_type ?? "-"} thread_ts=${(event as any).thread_ts ?? "-"} subtype=${(event as any).subtype ?? "-"} text="${((event as any).text || "").slice(0, 50)}"`);
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

      const slackUserId = (event as any).user as string;
      const rawText = ((event as any).text || "") as string;
      const channelType = ((event as any).channel_type as string) || "channel";
      const threadTs = (event as any).thread_ts as string | undefined;
      const wasMentioned = !!this.botUserId && rawText.includes(`<@${this.botUserId}>`);

      const triageEnabled = this.triageConfig?.enabled === true;
      const conversationKey = {
        channel: (event as any).channel as string,
        threadTs,
        ts: (event as any).ts as string | undefined,
        userId: slackUserId,
      };
      // Record the human speaker even for messages the gates below drop:
      // a third human joining a thread must invalidate DM-equivalence
      // whether or not we end up responding to their message.
      if (this.conversationTrackingEnabled()) {
        this.conversations.recordHumanMessage(conversationKey);
      }

      // Deterministic respondTo gate — evaluated before any network fetches
      // and before LLM triage, so gated scopes cost nothing for dropped
      // messages. "mention" scopes drop un-mentioned messages outright,
      // except inside threads the bot has already engaged.
      const respondDecision = evaluateRespondPolicy({
        config: this.respondTo,
        channelType,
        wasMentioned,
        isEngagedThread:
          !!threadTs &&
          this.conversations.isBotEngagedThread((event as any).channel, threadTs),
      });
      if (!respondDecision.allow) {
        logger.info(
          `[slack] respondTo gate → silent (${respondDecision.reason}) for ts=${(event as any).ts}`,
        );
        return;
      }

      // Early silent for cross-bot / cross-user traffic in shared channels.
      // If the message @-mentions specific user(s), none of whom are us, and
      // it isn't a DM, stay silent — regardless of whether the thread was
      // previously marked "active" by an earlier reply. The activeThread
      // TTL exists for mid-conversation follow-ups, not for sibling mentions
      // directed at another bot or human in the same channel.
      if (!wasMentioned && this.botUserId && channelType !== "im") {
        const mentionedUsers = Array.from(
          rawText.matchAll(/<@([UW][A-Z0-9]+)>/g),
          (m) => m[1],
        );
        if (mentionedUsers.length > 0 && !mentionedUsers.includes(this.botUserId)) {
          logger.info(
            `[slack] message @-mentions ${mentionedUsers.join(",")} (not us) — staying silent for ts=${(event as any).ts}`,
          );
          return;
        }
      }

      const sessionKey = deriveSessionKey(event as any);
      const replyContext = buildReplyContext(event as any);

      // Fetch parent message for thread replies so the session has full context
      let parentContext = "";
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
      const failedAttachments: string[] = [];
      if ((event as any).files) {
        for (const file of (event as any).files) {
          try {
            const resolved = await resolveSlackFileAttachment(
              file,
              (args) => this.app.client.files.info(args),
            );
            const localPath = await downloadAttachment(
              resolved.url,
              this.app.client.token!,
              TMP_DIR,
            );
            attachments.push({
              name: resolved.name,
              url: resolved.url,
              mimeType: resolved.mimeType,
              localPath,
            });
          } catch (err) {
            // File names are user-controlled. Keep the injected failure notice
            // limited to Slack's opaque ID so it cannot become prompt content.
            const label = file.id ? `Slack file ${file.id}` : "Slack attachment";
            failedAttachments.push(label);
            logger.warn(`[slack] Failed to retrieve attachment ${label}: ${err}`);
          }
        }
      }

      const [channelInfo, speaker] = await Promise.all([
        this.resolveChannelInfo((event as any).channel),
        this.resolveSpeakerInfo(slackUserId),
      ]);
      const channelName = channelInfo.name;

      // DM is never "external"; otherwise trust the Slack Connect flag.
      const channelExternal = channelType !== "im" && channelInfo.isExtShared;

      // Slash commands (/new, /status, …) are control directives the session
      // manager parses by exact string match. Wrapping them in the
      // "[Thread context — …]" preamble below silently breaks that parsing,
      // so a command typed inside a Slack thread would never be intercepted.
      // Commands don't need conversation context anyway — pass them verbatim.
      const attachmentFailureNotice = formatAttachmentFailureNotice(failedAttachments);
      const text = startsWithSlashCommand(rawText)
        ? rawText + attachmentFailureNotice
        : parentContext + rawText + attachmentFailureNotice;

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
        text,
        attachments,
        raw: event,
        transportMeta: {
          channelType,
          channelExternal,
          team: ((event as any).team as string) || null,
          channelName: channelName || null,
          wasMentioned,
          ...this.speakerTransportFields(speaker, slackUserId),
        },
      };

      // Air-reading triage gate.
      // Fast paths that bypass the LLM triage entirely:
      //   - DMs: 1:1 context is implicitly addressed to the bot
      //   - Explicit @-mention: always reply
      //   - DM-equivalent conversation: bot has engaged AND only this user has
      //     spoken in the conversation (thread or channel-user scope). Permanent
      //     until a third human joins.
      const isDmEquivalent =
        triageEnabled && channelType !== "im" && !wasMentioned
          ? this.conversations.isDmEquivalent(conversationKey)
          : false;
      // Short-ack exception: the always-reply fast paths (real DMs and
      // DM-equivalent conversations) otherwise swallow the one situation
      // react-triage is FOR — pure appreciation right after the bot replied
      // (the bot having replied is what makes a conversation DM-equivalent).
      // Send lexical short-ack candidates through triage in a 1:1-aware mode
      // (react vs reply, never silent) so a bare thanks can get an emoji
      // instead of a full engine turn. Everything else keeps the fast-path
      // full reply. @-mentions always get a real reply, even short ones.
      const shortAckTriage = shouldRunReactOnlyTriage({
        channelType,
        isDmEquivalent,
        wasMentioned,
        attachmentCount: attachments.length,
        text: rawText,
      });
      const skipTriage =
        !triageEnabled ||
        wasMentioned ||
        ((channelType === "im" || isDmEquivalent) && !shortAckTriage);

      if (triageEnabled && isDmEquivalent && !shortAckTriage) {
        logger.info(`[slack] skipping triage — DM-equivalent conversation in ${(event as any).channel}`);
      }

      if (!skipTriage) {
        const decision = await this.runSlackTriage(event as any, {
          speaker,
          channelType,
          channelName: channelName ?? undefined,
          wasMentioned,
          messageText: rawText,
          dmEquivalent: shortAckTriage,
        });

        if (decision.action === "silent") {
          if (shortAckTriage) {
            // 1:1 conversation — the message IS addressed to the bot; ghosting is
            // not acceptable. Treat a stray "silent" as the pre-exception behavior.
            logger.info(`[slack] triage → silent in DM-equivalent short-ack path — upgrading to reply for ts=${(event as any).ts}`);
          } else {
            logger.info(`[slack] triage → silent (${decision.reason ?? "no reason"}) for ts=${(event as any).ts}`);
            return;
          }
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
            this.conversations.recordBotEngaged(conversationKey);
          } catch (err) {
            logger.debug(`[slack] failed to add triage reaction: ${err}`);
          }
          return;
        }
        logger.info(`[slack] triage → reply (${decision.reason ?? "no reason"}) for ts=${(event as any).ts}`);
      }

      if (this.conversationTrackingEnabled()) {
        this.conversations.recordBotEngaged(conversationKey);
      }

      // Natural-language `/goal` injection.
      //
      // This is intentionally OUTSIDE the triage path. Triage decides
      // "should we even respond"; goal extraction decides "if we respond,
      // should the session run autonomously until a condition holds".
      // The two questions are independent — DM / @-mention / DM-equivalent
      // messages skip triage but still benefit from /goal — so we apply
      // the extractor here, at the single point every reply-bound message
      // passes through.
      //
      // The earlier keyword-regex approach missed natural Japanese phrasings
      // ("完了と書いたら止まる" without "最後までやって" etc.) so we now
      // always defer to a Haiku call gated only by a cheap length check.
      // Haiku returns null fast for non-goal messages; sanitisation in the
      // parser blocks slash-prefix injection and sentinel placeholders.
      if (this.goalInjectionEnabled && this.goalExtractionConfig?.enabled === true && shouldExtractGoal(msg.text)) {
        try {
          const condition = await extractGoalCondition(msg.text, this.goalExtractionConfig);
          if (condition) {
            logger.info(`[slack] /goal injected: ${condition.slice(0, 100)}`);
            msg.text = `/goal ${condition}\n\n${msg.text}`;
          }
        } catch (err) {
          // extractGoalCondition already catches its own errors; defensive.
          logger.debug(`[slack] goal-extractor unexpected error: ${err}`);
        }
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
    // Fail closed: without our own user ID, mention detection is impossible,
    // so mention-gated scopes will drop everything (except engaged threads).
    // That honors "never barge in un-mentioned" at the cost of missed
    // mentions until the next successful start — surface it loudly.
    if (!this.botUserId && hasMentionScope(this.respondTo)) {
      logger.warn(
        "[slack] respondTo mention gate is configured but the bot user ID could not be resolved — un-mentioned messages in mention scopes will be dropped",
      );
    }

    this.app.event("reaction_added", async ({ event }) => {
      // Only handle reactions on messages (not files, etc.)
      if (event.item.type !== "message") return;

      // Skip bot's own reactions
      if (this.botUserId && event.user === this.botUserId) return;

      // A mention-gated channel scope cannot be satisfied by a reaction, which
      // carries no @-mention; see shouldHandleReaction.
      if (!shouldHandleReaction(this.respondTo, event.item.channel)) {
        logger.debug(
          `[slack] respondTo.channel=${resolveRespondMode(this.respondTo, "channel")} — ignoring channel reaction on ${event.item.channel}:${event.item.ts}`,
        );
        return;
      }

      if (!this.handler) return;

      // Check allowed users
      if (this.allowedUsers && !this.allowedUsers.has(event.user)) {
        logger.debug(`Ignoring reaction from unauthorized user ${event.user}`);
        return;
      }

      const channelId = event.item.channel;
      const messageTs = event.item.ts;
      const emoji = event.reaction;

      // Skip reactions that were replayed on boot. Gate on the REACTION's own event time
      // (event_ts), NOT the reacted-to message's age — a fresh reaction on an old message
      // (e.g. approving an approval card that has been waiting for hours) must still be honored.
      const reactionTs = (event as any).event_ts || messageTs;
      if (this.ignoreOldMessagesOnBoot && isOldSlackMessage(reactionTs, this.bootTimeMs)) {
        logger.debug(`Ignoring old (replayed-on-boot) Slack reaction event ${reactionTs}`);
        return;
      }

      logger.info(`[slack] Reaction :${emoji}: by ${event.user} on ${channelId}:${messageTs}`);

      // Instant ack so the user can see the gateway heard the reaction.
      try {
        await this.app.client.reactions.add({ channel: channelId, timestamp: messageTs, name: "eyes" });
      } catch (err) {
        logger.debug(`[slack] eyes ack skipped (likely already reacted): ${err}`);
      }

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

      // Resolve channel name/external status and reactor (speaker) in parallel
      const [channelInfo, speaker] = await Promise.all([
        this.resolveChannelInfo(channelId),
        this.resolveSpeakerInfo(event.user),
      ]);
      const channelName = channelInfo.name;
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
          channelExternal: channelInfo.isExtShared,
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
    this.agentsCanvas?.start();
  }

  async stop() {
    this.agentsCanvas?.stop();
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
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

  /**
   * Enumerate channels the bot is a member of. Used by the settings UI to
   * populate the Agents View canvas channel picker.
   *
   * Public channels and private groups the bot has been invited to are both
   * included; DMs/MPIMs are filtered out (canvases live in channels, not
   * direct messages).
   */
  async listChannels(): Promise<Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean }>> {
    const out: Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean }> = [];
    let cursor: string | undefined;
    // Bound the loop so a misbehaving workspace can't make us iterate forever.
    for (let page = 0; page < 20; page++) {
      const res = await this.app.client.conversations.list({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      const channels = (res.channels ?? []) as unknown as Array<Record<string, unknown>>;
      for (const c of channels) {
        const id = typeof c.id === "string" ? c.id : undefined;
        const name = typeof c.name === "string" ? c.name : undefined;
        if (!id || !name) continue;
        // bot must be a member to post a canvas in the channel
        if (c.is_member !== true) continue;
        out.push({
          id,
          name,
          isPrivate: c.is_private === true,
          isMember: true,
        });
      }
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
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
    // An explicit thread target must never be dropped: posting a "thread
    // reply" without thread_ts lands it bare in the channel. Callers that
    // reach sendMessage with a thread (proxy endpoint, MCP tool) get the
    // same behavior as replyMessage.
    const thread = explicitThread(target.thread);
    if (thread) {
      return this.replyMessage({ ...target, thread }, text);
    }
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
    // so mark its future thread as bot-engaged. Only relevant when tracking is on.
    if (lastTs && this.conversationTrackingEnabled()) {
      this.conversations.recordBotInitiatedThread(target.channel, lastTs);
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
    // Record the thread the bot just replied in. Subsequent user replies in
    // this same thread will carry thread_ts === threadTs and bypass triage
    // and the respondTo mention gate. Only relevant when tracking is on.
    if (threadTs && this.conversationTrackingEnabled()) {
      this.conversations.recordBotInitiatedThread(target.channel, threadTs);
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
    // A reaction on a message also counts as engagement; mark the target's
    // thread anchor so follow-ups in that thread are treated as bot-engaged.
    // Only relevant when tracking is on.
    const anchor = target.thread || target.messageTs;
    if (anchor && this.conversationTrackingEnabled()) {
      this.conversations.recordBotInitiatedThread(target.channel, anchor);
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
