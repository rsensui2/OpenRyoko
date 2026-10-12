import { getSession } from "./registry.js";
import { loadConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { readGatewayAuthToken } from "../gateway/auth.js";
import { JINN_HOME } from "../shared/paths.js";
import type { Session } from "../shared/types.js";

/**
 * Notify the parent session that a child session has replied.
 * Sends an internal message to the parent via the local HTTP API.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyParentSession(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
  options?: { alwaysNotify?: boolean },
): void {
  if (!childSession.parentSessionId) return;
  if (options?.alwaysNotify === false) {
    // The parent may be waiting on this notification. Suppression is a valid choice, but it
    // must not be invisible — a parent that ends its turn expecting a wake-up stops silently.
    logger.info(`[callbacks] Suppressed parent notification for child ${childSession.id} (alwaysNotify=false). Parent ${childSession.parentSessionId} will NOT be woken.`);
    return;
  }

  // Run asynchronously — do not await in the caller
  _sendNotification(childSession, result, { completion: true }).catch((err) => {
    logger.warn(`[callbacks] Failed to notify parent session ${childSession.parentSessionId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Notify the parent session that a child session has been rate-limited and will auto-resume.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimited(
  childSession: Session,
  estimatedResumeTime?: string, // ISO timestamp or human-readable
): void {
  if (!childSession.parentSessionId) return;

  _sendNotification(childSession, {
    error: null,
    result: `⏳ Session is rate-limited and will auto-resume${estimatedResumeTime ? ` around ${estimatedResumeTime}` : ' when the limit resets'}. No action needed.`,
  }).catch((err) => {
    logger.warn(`[callbacks] Failed to send rate-limit notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Notify the parent session that a rate-limited child session has successfully resumed.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimitResumed(
  childSession: Session,
): void {
  if (!childSession.parentSessionId) return;

  const employeeName = childSession.employee || "Unknown";
  _sendRaw(childSession.parentSessionId, `🔄 Employee "${employeeName}" (session ${childSession.id}) has resumed after rate limit cleared.`).catch((err) => {
    logger.warn(`[callbacks] Failed to send resume notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendNotification(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
  /** `completion`: this reports the child's turn ending (not a status notice). */
  opts: { completion?: boolean } = {},
): Promise<void> {
  const parent = getSession(childSession.parentSessionId!);
  if (!parent) {
    logger.info(`[callbacks] Parent ${childSession.parentSessionId} not found for child ${childSession.id} — no notification sent.`);
    return; // Parent gone or expired
  }
  if (parent.status === "error") {
    logger.info(`[callbacks] Parent ${parent.id} is in error — skipping notification for child ${childSession.id}. The child's result will not reach it.`);
    return; // Parent already in error — skip
  }

  const employeeName = childSession.employee || "Unknown";
  const childId = childSession.id;

  let message: string;
  if (result.error) {
    message = `⚠️ Employee "${employeeName}" (session ${childId}) encountered an error: ${result.error}`;
  } else {
    const raw = result.result || "(no output)";
    const preview = raw.length > 200 ? raw.substring(0, 200) + "..." : raw;
    message = `📩 Employee "${employeeName}" replied in session ${childId}.\nRead the latest messages: GET /api/sessions/${childId}?last=N\n\nPreview: ${preview}`;
  }

  // A successful completion names its child so the gateway can fold the ones
  // that pile up behind a busy parent into one turn (completion-batching.ts).
  // A failure is left unmarked: it keeps a turn of its own.
  await _sendRaw(childSession.parentSessionId!, message, opts.completion && !result.error ? childId : undefined);
}

/**
 * Send a hardcoded notification to the configured Discord channel.
 * Used for rate-limit alerts that must not depend on the LLM.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyDiscordChannel(message: string): void {
  _sendDiscordNotification(message).catch((err) => {
    logger.warn(`[callbacks] Failed to send Discord notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendDiscordNotification(message: string): Promise<void> {
  let port = 7777;
  let connector = "discord";
  let channel: string | undefined;

  try {
    const config = loadConfig();
    port = config.gateway?.port || 7777;
    connector = config.notifications?.connector || "discord";
    channel = config.notifications?.channel;
  } catch {
    // Use defaults if config is unavailable
  }

  if (!channel) {
    logger.debug("[callbacks] No notifications.channel configured — skipping Discord notification");
    return;
  }

  await _postToGateway(port, `/api/connectors/${connector}/send`, { channel, text: message }, `sending a ${connector} notification`);
}

async function _sendRaw(parentSessionId: string, message: string, completionOf?: string): Promise<void> {
  let port = 7777;
  try {
    const config = loadConfig();
    port = config.gateway?.port || 7777;
  } catch {
    // Use default port if config is unavailable
  }

  await _postToGateway(
    port,
    `/api/sessions/${parentSessionId}/message`,
    { message, role: "notification", ...(completionOf ? { completionOf } : {}) },
    `notifying parent ${parentSessionId}`,
  );
}

/**
 * Wake a session on this instance's own gateway with a notification turn: the
 * message is persisted, queued and run, and a connector-origin session answers
 * in the conversation it came from. Rejects when the gateway does not accept it.
 */
export function postSessionNotification(
  port: number,
  sessionId: string,
  body: { message: string; dedupeKey?: string },
): Promise<void> {
  return _postToGateway(port, `/api/sessions/${sessionId}/message`, { ...body, role: "notification" }, `waking session ${sessionId}`);
}

/**
 * POST to this instance's own gateway API.
 *
 * The gateway requires a bearer token on every /api/ route except /api/health, so an
 * unauthenticated call is rejected with 401. fetch() resolves on a 4xx rather than
 * rejecting, so a call that ignores the response discards that rejection with no trace —
 * the notification is simply lost and nothing records it. Both notification paths here
 * did exactly that. `jobs/notify.ts` is the model: send the token, check the status.
 */
async function _postToGateway(port: number, path: string, body: unknown, what: string): Promise<void> {
  const token = readGatewayAuthToken(JINN_HOME);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

  // The body is irrelevant, but undici keeps the socket (and the buffered body) tied up until it
  // is consumed or cancelled — release it before acting on the status.
  await res.body?.cancel().catch(() => undefined);

  if (!res.ok) {
    throw new Error(`gateway responded ${res.status} when ${what}`);
  }
}
