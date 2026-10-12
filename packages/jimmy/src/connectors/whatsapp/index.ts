import makeWASocketImport, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
// Handle ESM/CJS interop — Baileys may export as .default in some environments
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeWASocket = ((makeWASocketImport as any).default ?? makeWASocketImport) as typeof makeWASocketImport;
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  Target,
} from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { JINN_HOME } from "../../shared/paths.js";
import { newAttachmentDir } from "../../shared/attachments.js";
import { AttachmentTooLargeError, attachmentLimitBytes, saveWithin } from "../../shared/attachment-download.js";
import { failedAttachment, withAttachmentNotice } from "../../shared/attachment-notice.js";
import { formatResponse } from "./format.js";
import path from "node:path";
import fs from "node:fs";

export interface WhatsAppConnectorConfig {
  /** Where to store session credentials (default: JINN_HOME/.whatsapp-auth) */
  authDir?: string;
  /** Allowed phone numbers in JID format (e.g. "447700900000@s.whatsapp.net") — empty = allow all */
  allowFrom?: string[];
  ignoreOldMessagesOnBoot?: boolean;
  /** Largest attachment downloaded, in MB (default 200). A larger one is not
   *  fetched; the session is told so. */
  maxAttachmentMb?: number;
}

// Minimal ILogger implementation that routes Baileys noise to silence
const silentLogger = {
  level: "silent",
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class WhatsAppConnector implements Connector {
  name = "whatsapp";
  private sock: WASocket | null = null;
  private config: WhatsAppConnectorConfig;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private bootTimeMs = Date.now();
  private allowedJids: Set<string>;
  private connectionStatus: "starting" | "running" | "stopped" | "error" | "qr_pending" = "starting";
  private lastError: string | null = null;
  private authDir: string;
  private latestQr: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  private readonly capabilities: ConnectorCapabilities = {
    threading: false,
    messageEdits: false,
    reactions: false,
    attachments: true,
  };

  constructor(config: WhatsAppConnectorConfig) {
    this.config = config;
    this.authDir = config.authDir ?? path.join(JINN_HOME, ".whatsapp-auth");
    this.allowedJids = new Set(config.allowFrom ?? []);
    fs.mkdirSync(this.authDir, { recursive: true });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    await this.connect();
  }

  private scheduleReconnect(): void {
    if (this.connectionStatus === "stopped") return;
    // Exponential backoff: 5s, 10s, 20s, 40s, 60s max
    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;
    logger.info(`WhatsApp reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    // Fetch latest WA Web version to avoid 405 rejections from outdated version
    const { version } = await fetchLatestWaWebVersion().catch(() => ({ version: undefined }));

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: silentLogger as never,
      browser: Browsers.macOS("Chrome"),
      ...(version ? { version } : {}),
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        this.latestQr = qr;
        this.connectionStatus = "qr_pending";
        logger.info("WhatsApp QR code generated — scan with your WhatsApp app to connect");
      }
      if (connection === "open") {
        this.latestQr = null;
        this.connectionStatus = "running";
        this.lastError = null;
        this.reconnectAttempts = 0;
        logger.info("WhatsApp connector connected");
      }
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        logger.info(`WhatsApp connection closed (${statusCode}), reconnecting: ${!isLoggedOut}`);
        if (!isLoggedOut && this.connectionStatus !== "stopped") {
          this.scheduleReconnect();
        } else {
          this.connectionStatus = "stopped";
        }
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages) {
        try {
          await this.handleMessage(message);
        } catch (err) {
          logger.error(`WhatsApp message handler error: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.connectionStatus = "stopped";
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.sock?.end(undefined);
    logger.info("WhatsApp connector stopped");
  }

  getCapabilities(): ConnectorCapabilities {
    return this.capabilities;
  }

  getQrCode(): string | null {
    return this.latestQr;
  }

  getHealth(): ConnectorHealth {
    let status: ConnectorHealth["status"] = "stopped";
    if (this.connectionStatus === "running") status = "running";
    else if (this.connectionStatus === "qr_pending") status = "qr_pending";
    return {
      status,
      detail: this.connectionStatus === "qr_pending"
        ? "Scan QR code in settings to connect"
        : (this.lastError ?? undefined),
      capabilities: this.capabilities,
    };
  }

  reconstructTarget(replyContext: Record<string, unknown> | null | undefined): Target {
    const ctx = (replyContext ?? {}) as Record<string, string | null>;
    return {
      channel: (typeof ctx.channel === "string" ? ctx.channel : "") ?? "",
      thread: undefined,
      messageTs: typeof ctx.messageTs === "string" ? ctx.messageTs : undefined,
    };
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    return this.replyMessage(target, text);
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    if (!this.sock || this.connectionStatus !== "running") return;
    try {
      const chunks = formatResponse(text);
      for (const chunk of chunks) {
        await this.sock.sendMessage(target.channel, { text: chunk });
      }
    } catch (err) {
      logger.error(`WhatsApp replyMessage error: ${err instanceof Error ? err.message : err}`);
    }
    return undefined;
  }

  async editMessage(_target: Target, _text: string): Promise<void> {
    // WhatsApp doesn't support editing via Baileys reliably — no-op
  }

  async addReaction(_target: Target, _emoji: string): Promise<void> {
    // No-op: reactions are supported in WA but complex to map from Slack emoji names
  }

  async removeReaction(_target: Target, _emoji: string): Promise<void> {
    // No-op
  }

  async setTypingStatus(channelId: string, _threadTs: string | undefined, status: string): Promise<void> {
    if (!this.sock || this.connectionStatus !== "running") return;
    const existing = this.typingIntervals.get(channelId);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(channelId);
    }
    if (status) {
      // Show "typing..." and refresh every 20s (WhatsApp composing expires ~25s)
      await this.sock.sendPresenceUpdate("composing", channelId).catch(() => {});
      const interval = setInterval(() => {
        this.sock?.sendPresenceUpdate("composing", channelId).catch(() => {});
      }, 20_000);
      this.typingIntervals.set(channelId, interval);
    } else {
      await this.sock.sendPresenceUpdate("paused", channelId).catch(() => {});
    }
  }

  private async handleMessage(message: WAMessage): Promise<void> {
    const jid = message.key.remoteJid;
    const ownJid = this.sock?.user?.id ?? "";
    const ownJidBare = ownJid.split(":")[0] + "@s.whatsapp.net";
    // WhatsApp now uses LID (Linked ID) format — extract from sock.user.lid
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ownLid = (this.sock?.user as any)?.lid ?? "";
    const ownLidBare = ownLid ? ownLid.split(":")[0] + "@lid" : "";

    if (!jid) return;
    if (jid.endsWith("@g.us")) return;
    if (jid.endsWith("@newsletter")) return;
    if (jid.endsWith("@broadcast")) return;

    // Allow "note to self" — matches own phone JID or own LID
    const isSelfChat = message.key.fromMe && (
      jid === ownJidBare || jid === ownJid ||
      jid === ownLidBare || jid === ownLid
    );

    if (message.key.fromMe && !isSelfChat) return;

    const msgTimestampMs = Number(message.messageTimestamp ?? 0) * 1000;
    if (
      this.config.ignoreOldMessagesOnBoot !== false &&
      msgTimestampMs < this.bootTimeMs
    ) return;

    // If no allowFrom configured, only self-chat is allowed.
    // If allowFrom is set, also allow those specific JIDs.
    if (!isSelfChat && (this.allowedJids.size === 0 || !this.allowedJids.has(jid))) return;
    if (!this.handler) return;

    const text =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.imageMessage?.caption ||
      message.message?.documentMessage?.caption ||
      "";

    if (!text.trim()) return;
    logger.info(`WhatsApp message received from ${jid}`);

    // Download media attachment if present
    const attachments: Array<{ name: string; localPath: string; mimeType: string; url: string }> = [];
    const failedAttachments: string[] = [];
    const hasMedia = message.message?.imageMessage || message.message?.documentMessage || message.message?.audioMessage;
    if (hasMedia && this.sock) {
      const maxBytes = attachmentLimitBytes(this.config.maxAttachmentMb);
      try {
        // The size is the sender's choice. Media announced as larger than the
        // connector's limit is not fetched; the rest is read as a stream that
        // stops there.
        if (Number(String(hasMedia.fileLength ?? "")) > maxBytes) throw new AttachmentTooLargeError(maxBytes);
        const stream = await downloadMediaMessage(message, "stream", {}, {
          logger: silentLogger as never,
          reuploadRequest: this.sock.updateMediaMessage,
        });
        const ext = message.message?.imageMessage ? "jpg"
          : message.message?.audioMessage ? "ogg"
          : "bin";
        const filename = `wa-attachment-${message.key.id}.${ext}`;
        // A directory of this message's own (see shared/attachments.ts). The
        // message id is the sender's: it names the attachment, not the file.
        const tmpDir = newAttachmentDir();
        const localPath = path.join(tmpDir, `attachment.${ext}`);
        await saveWithin(stream, localPath, maxBytes);
        const mimeType = ext === "jpg" ? "image/jpeg"
          : ext === "ogg" ? "audio/ogg"
          : "application/octet-stream";
        attachments.push({ name: filename, localPath, mimeType, url: localPath });
      } catch (err) {
        // Non-fatal: continue without the attachment — and say that it is
        // missing, and why when it was too large, rather than drop it unseen.
        failedAttachments.push(failedAttachment("the media attachment", err));
      }
    }

    const sessionKey = `whatsapp:${jid}`;
    const replyContext = { channel: jid, thread: null, messageTs: message.key.id ?? null };

    const incomingMessage: IncomingMessage = {
      connector: "whatsapp",
      source: "whatsapp",
      sessionKey,
      channel: jid,
      thread: undefined,
      user: jid.replace("@s.whatsapp.net", ""),
      userId: jid,
      text: withAttachmentNotice(text, "WhatsApp", failedAttachments),
      attachments,
      replyContext,
      messageId: message.key.id ?? undefined,
      transportMeta: { jid },
      raw: message,
    };

    this.handler(incomingMessage);
  }
}
