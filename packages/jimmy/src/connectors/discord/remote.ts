import type {
  Attachment,
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  DiscordRespondToConfig,
  IncomingMessage,
  Target,
} from "../../shared/types.js";
import { failedAttachment, withAttachmentNotice } from "../../shared/attachment-notice.js";
import { attachmentSlot } from "../../shared/attachments.js";
import { logger } from "../../shared/logger.js";
import { partialDeliveryFromText, type PartialDeliveryError } from "../../shared/partial-delivery.js";
import { mapLimited } from "../../shared/map-limited.js";
import { downloadAttachment } from "./format.js";
import {
  evaluateRespondPolicy,
  parseForwardedAddressing,
  resolveRespondMode,
  scopeForChannel,
} from "./respond-policy.js";

export interface RemoteDiscordConfig {
  /** URL of the primary Jinn instance that holds the Discord WebSocket connection */
  proxyVia: string;
  /** Bearer token for the primary's gateway — required when its /api/* auth is enabled. */
  proxyViaToken?: string;
  channelId?: string;
  /** Deterministic per-scope response gate, applied to proxied messages. */
  respondTo?: DiscordRespondToConfig;
}

/** The transportMeta fields a Discord primary legitimately sends — everything
 *  else (cross-platform identity like speakerSlackId, Slack-only fields,
 *  internal session metadata) is dropped at the boundary. */
const INCOMING_DISCORD_META_ALLOWLIST = [
  "channelName",
  "guildId",
  "isDM",
  "isGroupDM",
  "speakerName",
  "speakerDisplayName",
  "speakerHandle",
  "speakerDiscordId",
  "speakerIsBot",
  "wasBotAddressed",
  "addressesOnlyOthers",
  "isEngagedThread",
] as const;

/**
 * Allowlist a routed Discord payload's transportMeta at the receiving
 * boundary. This endpoint carries Discord traffic, so only the fields the
 * Discord primary actually produces pass through — a forged Slack identity
 * (or any future field we haven't reasoned about) must never reach the
 * platform-bound operator check or the MEMORY.md gate.
 */
export function sanitizeIncomingDiscordMeta(meta: unknown): Record<string, unknown> {
  const raw = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
  return Object.fromEntries(
    INCOMING_DISCORD_META_ALLOWLIST.flatMap((key) => (key in raw ? [[key, raw[key]] as const] : [])),
  );
}

/** Discord serves attachment files from these hosts and no others. */
const DISCORD_CDN_HOSTS = ["cdn.discordapp.com", "media.discordapp.net"];
/** Largest routed attachment kept — the gateway's own upload limit. */
const MAX_INCOMING_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** A Discord message carries at most ten attachments; a request listing more
 *  did not come from one. */
const MAX_INCOMING_ATTACHMENTS = 10;
/** How many of a routed message's attachments are fetched at the same time. */
const INCOMING_DOWNLOADS_AT_ONCE = 3;

/**
 * What a routed attachment may say about itself: the three fields a Discord
 * primary sends, each only as text. Everything else in the request is dropped
 * — above all `localPath`. The session gives every attachment's localPath to
 * the engine as a file to read and deletes it when the turn ends, so a routed
 * message must never be able to name one; it is set here, by the download.
 */
function incomingAttachmentMeta(att: Record<string, unknown>): Attachment {
  const meta: Partial<Attachment> = {};
  for (const key of ["name", "url", "mimeType"] as const) {
    const value = att[key];
    if (typeof value === "string") meta[key] = value;
  }
  return meta as Attachment;
}

/**
 * Fetch a routed message's attachments to `destDir` (the message's own
 * directory; each attachment gets a slot in it). Their names and URLs come
 * straight from the request body, so only what a Discord primary really sends
 * is fetched: an https URL on Discord's CDN, up to a size limit. Anything else
 * stays as metadata without a local file — what a failed download has always
 * looked like — and is never requested.
 *
 * The list is the request's too: only its first ten entries are looked at
 * (Discord's own limit per message), and they are fetched a few at a time.
 *
 * `failed` names each attachment that has a URL and was not fetched, by its
 * position, with the reason when the reason is its size: see
 * {@link routedMessageText}.
 */
export async function downloadIncomingAttachments(attachments: unknown, destDir: string): Promise<IncomingAttachments> {
  if (!Array.isArray(attachments)) return { attachments: [], failed: [] };
  const listed = attachments
    .filter((att): att is Record<string, unknown> => Boolean(att) && typeof att === "object")
    .slice(0, MAX_INCOMING_ATTACHMENTS);
  const results = await mapLimited(listed, INCOMING_DOWNLOADS_AT_ONCE, async (att, slot) => {
    const meta = incomingAttachmentMeta(att);
    if (!meta.url) return { meta, failed: null };
    try {
      const localPath = await downloadAttachment(meta.url, attachmentSlot(destDir, slot), meta.name, {
        allowedHosts: DISCORD_CDN_HOSTS,
        maxBytes: MAX_INCOMING_ATTACHMENT_BYTES,
      });
      return { meta: { ...meta, localPath }, failed: null };
    } catch (err) {
      return { meta, failed: failedAttachment(`attachment ${slot + 1} of ${listed.length}`, err) };
    }
  });
  return {
    attachments: results.map((result) => result.meta),
    failed: results.flatMap((result) => (result.failed === null ? [] : [result.failed])),
  };
}

export interface IncomingAttachments {
  attachments: Attachment[];
  failed: string[];
}

/**
 * The text of a routed message as the session gets it: what the primary sent,
 * plus a notice for the attachments this instance did not fetch. Without it a
 * file over the limit simply went missing, and the session answered as if
 * nothing had been attached.
 */
export function routedMessageText<T>(text: T, failed: readonly string[]): T | string {
  return withAttachmentNotice(text, "Discord", failed);
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
  private readonly proxyToken: string | undefined;
  private readonly respondTo: DiscordRespondToConfig | undefined;
  private warnedMissingAddressing = false;

  constructor(config: RemoteDiscordConfig) {
    this.baseUrl = config.proxyVia.replace(/\/+$/, "");
    this.proxyToken = config.proxyViaToken;
    this.respondTo = config.respondTo;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  /** Called by the /api/connectors/discord/incoming endpoint to deliver proxied messages */
  deliverMessage(msg: IncomingMessage): void {
    const meta = (msg.transportMeta ?? {}) as Record<string, unknown>;
    const isDM = meta.isDM === true;
    // Addressing (ForwardedAddressing) is resolved by the primary instance:
    // only it sees the Discord gateway, and it also tracks thread engagement
    // — proxied sends run through its connector. When the flags are absent —
    // a primary too old to send them — mention scopes fail closed (Slack
    // precedent for unresolvable identity) and the sibling rule stays off
    // (never drop an "always" message on missing metadata). Warn once, and
    // only when a message actually lands in a mention-gated scope, so the
    // required upgrade order is visible instead of a silent blackhole.
    const { present } = parseForwardedAddressing(meta);
    if (
      !present &&
      resolveRespondMode(this.respondTo, scopeForChannel(isDM)) === "mention" &&
      !this.warnedMissingAddressing
    ) {
      this.warnedMissingAddressing = true;
      logger.warn(
        "[discord-remote] primary instance does not forward addressing metadata (its version predates respondTo) — routed messages in mention scopes are dropped until the primary is upgraded",
      );
    }
    const silence = this.silenceReason(meta);
    if (silence) {
      logger.info(`[discord-remote] ${silence} for message ${msg.messageId}`);
      return;
    }
    if (this.handler) {
      this.handler(msg);
    }
  }

  /**
   * Why a routed message with this transportMeta is dropped instead of handed
   * on, or null when it is handed on. Decided from what the primary says about
   * the message and from this connector's respondTo alone.
   */
  private silenceReason(meta: Record<string, unknown>): string | null {
    const isDM = meta.isDM === true;
    const { flags } = parseForwardedAddressing(meta);
    const respondDecision = evaluateRespondPolicy({
      config: this.respondTo,
      isDM,
      wasMentioned: flags.wasBotAddressed,
      isEngagedThread: flags.isEngagedThread,
    });
    if (!respondDecision.allow) return `respondTo gate → silent (${respondDecision.reason})`;
    if (!isDM && flags.addressesOnlyOthers) return "message addresses other user(s) — staying silent";
    return null;
  }

  /**
   * Whether {@link deliverMessage} will hand on a message with this
   * transportMeta. The /incoming route asks before it fetches the message's
   * attachments: what is going to be dropped is not downloaded first.
   */
  willDeliver(transportMeta: unknown): boolean {
    const meta = (transportMeta && typeof transportMeta === "object" ? transportMeta : {}) as Record<string, unknown>;
    return this.handler !== null && this.silenceReason(meta) === null;
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
    return this.proxyAction("sendMessage", { target, text }, true);
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    return this.proxyAction("replyMessage", { target, text }, true);
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

  /**
   * Sends pass `mustDeliver` and reject when the primary did not take the
   * message (Connector delivery contract). Decorations — edits, reactions,
   * typing — stay best-effort and only log.
   */
  private async proxyAction(
    action: string,
    params: Record<string, unknown>,
    mustDeliver = false,
  ): Promise<string | undefined> {
    let failure: string;
    let partial: PartialDeliveryError | undefined;
    try {
      const res = await fetch(`${this.baseUrl}/api/connectors/discord/proxy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // The primary's gateway authenticates /api/* like any client.
          ...(this.proxyToken ? { Authorization: `Bearer ${this.proxyToken}` } : {}),
        },
        body: JSON.stringify({ action, ...params }),
      });
      if (res.ok) {
        // The primary took the action; a body we cannot read only costs the id.
        const data = (await res.json().catch(() => ({}))) as { messageId?: string };
        return data.messageId;
      }
      failure = `Remote Discord proxy ${action} failed: ${res.status}`;
      // A send the primary delivered only in part must stay recognisable here:
      // otherwise this instance's retry makes the primary post the chunks that
      // already landed a second time.
      if (mustDeliver) partial = partialDeliveryFromText(await proxyErrorText(res));
    } catch (err) {
      failure = `Remote Discord proxy ${action} error: ${err instanceof Error ? err.message : err}`;
    }
    logger.error(partial ? `${failure} (${partial.message})` : failure);
    if (mustDeliver) throw partial ?? new Error(failure);
    return undefined;
  }
}

/** The `error` text the primary answers a failed proxy call with, or "". */
async function proxyErrorText(res: { json(): Promise<unknown> }): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error : "";
  } catch {
    return "";
  }
}
