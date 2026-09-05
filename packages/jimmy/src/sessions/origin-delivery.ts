import type { Connector, Session } from "../shared/types.js";
import { normalizeDelivery, deliverPublic, type DeliveryContext } from "./reply-disposition.js";
import { insertMessage, updateSession } from "./registry.js";
import { logger } from "../shared/logger.js";

/**
 * Deliver an engine result back to the conversation a session originated from
 * (its connector + stored reply_context), independent of what triggered the
 * turn. Used when a turn completes outside the normal connector route:
 *
 *  - orphan Stop hooks (background continuation after the turn resolver died)
 *  - notification-triggered wake-ups (detached job finished, child session
 *    callback) that run through the gateway's web-session path, which has no
 *    connector of its own
 *
 * Without this, a woken Slack session computes its answer and posts it
 * nowhere — the customer thread stays silent (issue #38 follow-up).
 */
export type OriginDeliveryResult =
  /** A public action reached the connector. */
  | "delivered"
  /** Intentionally nothing to post: empty text or disposition "none". */
  | "suppressed"
  /** No addressable origin: web session, unknown connector, or a reply
   *  context without a target. Callers that EXPECT a connector-origin
   *  session must surface this — the conversation cannot be reached. */
  | "no_target"
  /** The connector call failed after retries — the caller MUST surface this. */
  | "failed";

const RETRY_DELAYS_MS = [2_000, 5_000];

export async function deliverToOriginConnector(
  session: Session,
  text: string,
  connectors: Map<string, Connector>,
  retryDelaysMs: number[] = RETRY_DELAYS_MS,
): Promise<OriginDeliveryResult> {
  if (!text.trim()) return "suppressed";
  const connector = session.connector ? connectors.get(session.connector) : undefined;
  if (!connector || !session.replyContext) return "no_target";

  const target = connector.reconstructTarget(session.replyContext);
  // Web sessions store a synthetic replyContext that reconstructs to an empty
  // target — nothing addressable to post to.
  if (!target.channel) return "no_target";

  const meta = (session.transportMeta ?? {}) as Record<string, unknown>;
  const isDM = meta.channelType === "im";
  const ctx: DeliveryContext = {
    // Unsolicited follow-up: never force a SAFE_ACK, just sanitize.
    addressed: false,
    channelExternal: isDM ? false : meta.channelExternal === undefined ? true : meta.channelExternal === true,
    isDM,
    canReact: connector.getCapabilities().reactions,
  };
  const { publicAction } = normalizeDelivery(text, ctx);
  if (publicAction.kind === "none") return "suppressed";

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      await deliverPublic(connector, target, publicAction);
      return "delivered";
    } catch (err) {
      lastErr = err;
      if (attempt < retryDelaysMs.length) {
        await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]));
      }
    }
  }
  logger.warn(`Origin-connector delivery failed for session ${session.id}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  return "failed";
}

/** A reply_context that actually points at a conversation. Web/API sessions
 *  store a synthetic context ({source: "web"}) AND a pseudo connector name
 *  ("web" — createSession defaults connector to the source), so the connector
 *  field alone cannot distinguish "unreachable customer thread" from "there
 *  was never a thread to reach". */
function hasAddressableTarget(session: Session): boolean {
  const rc = session.replyContext as Record<string, unknown> | null;
  if (!rc) return false;
  return [rc.channel, rc.chatId, rc.to].some((v) => typeof v === "string" && v.length > 0);
}

/** True when this delivery outcome means a connector-origin conversation was
 *  left without its answer and the caller must persist that fact. */
export function isUndeliveredToOrigin(result: OriginDeliveryResult, session: Session): boolean {
  return result === "failed" || (result === "no_target" && hasAddressableTarget(session));
}

/**
 * A turn computed its reply but it never reached the origin conversation.
 * Persist that fact into the session (message + lastError) so the next turn
 * (or the operator) sees it instead of the failure vanishing into a log line.
 */
export function recordFailedOriginDelivery(
  session: Session,
  emit?: (event: string, payload: unknown) => void,
): void {
  const note =
    `⚠️ Your reply above was NOT delivered to the original conversation (connector "${session.connector}" failed or the reply target is unreachable). ` +
    `The customer has not seen it — repost it (send_message / reply) as soon as the connector recovers.`;
  try {
    insertMessage(session.id, "notification", note);
    updateSession(session.id, { lastError: "origin delivery failed — reply not posted to the original conversation" });
    emit?.("session:notification", { sessionId: session.id, message: note });
  } catch (err) {
    logger.error(`Failed to record origin-delivery failure for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
