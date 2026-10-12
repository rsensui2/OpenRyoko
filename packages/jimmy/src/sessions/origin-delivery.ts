import type { Connector, Session } from "../shared/types.js";
import { normalizeDelivery, deliverPublic, SUPPRESS_PUBLIC_TRAILER, type DeliveryContext } from "./reply-disposition.js";
import { insertMessage, updateSession } from "./registry.js";
import { logger } from "../shared/logger.js";
import { isPartialDelivery } from "../shared/partial-delivery.js";
import { redactText } from "../shared/redact.js";

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
  const isDM = isOriginDM(session);
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
      // Part of the reply is already in the conversation: starting over would
      // post that part again. It is still a failure for the caller to record.
      if (isPartialDelivery(err)) break;
      if (attempt < retryDelaysMs.length) {
        await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]));
      }
    }
  }
  logger.warn(`Origin-connector delivery failed for session ${session.id}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  return "failed";
}

/** The origin conversation is a 1:1 DM with the operator. */
function isOriginDM(session: Session): boolean {
  return ((session.transportMeta ?? {}) as Record<string, unknown>).channelType === "im";
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

/**
 * The answer with which a turn that deliverToOriginConnector() delivers posts
 * nothing ("suppressed"). Such a turn was woken, not asked: when it finds it
 * has nothing to say, a line saying so would still land in the conversation.
 *
 * Null where no such answer exists. A DM shows a turn's output as it stands,
 * this line included; and a session with no conversation to deliver to has
 * nothing to keep quiet in.
 */
export function silentOriginAnswer(session: Session): string | null {
  return hasAddressableTarget(session) && !isOriginDM(session) ? SUPPRESS_PUBLIC_TRAILER : null;
}

/** True when this delivery outcome means a connector-origin conversation was
 *  left without its answer and the caller must persist that fact. */
export function isUndeliveredToOrigin(result: OriginDeliveryResult, session: Session): boolean {
  return result === "failed" || (result === "no_target" && hasAddressableTarget(session));
}

const DELIVERY_FAILED = "origin delivery failed — reply not posted to the original conversation";
const MAX_REASON_LENGTH = 300;

/**
 * A failure reason fit to store on a session and to be quoted from there (the
 * cron run log and the operator's alert quote lastError): secrets masked, one
 * line, bounded. Masking comes first — cutting first could leave the head of
 * a token behind.
 */
function storableReason(reason: string | undefined): string {
  const characters = Array.from(redactText(reason ?? "").replace(/\s+/g, " ").trim());
  return characters.length > MAX_REASON_LENGTH
    ? `${characters.slice(0, MAX_REASON_LENGTH).join("")}…`
    : characters.join("");
}

/**
 * A turn computed its reply but it never reached the origin conversation, or
 * reached it only in part. Persist that fact into the session (message +
 * lastError) so the next turn (or the operator) sees it instead of the
 * failure vanishing into a log line.
 *
 * The note covers both cases on purpose: after a partial delivery, "repost it"
 * would put the part that landed into the conversation a second time.
 *
 * `reason` is the transport's explanation, when the caller has one. It is
 * appended to both, so an operator reading an alert learns why the reply did
 * not arrive (channel_not_found, or how many chunks landed) without opening
 * the gateway log.
 */
export function recordFailedOriginDelivery(
  session: Session,
  emit?: (event: string, payload: unknown) => void,
  reason?: string,
): void {
  const why = storableReason(reason);
  const note =
    `⚠️ Your reply above was NOT delivered to the original conversation (connector "${session.connector}" failed or the reply target is unreachable). ` +
    `The customer has seen none of it, or only the beginning — check the conversation, then send what is missing (send_message / reply) as soon as the connector recovers. ` +
    `Do not repost a part that is already there.` +
    (why ? ` Reason: ${why}` : "");
  try {
    insertMessage(session.id, "notification", note);
    updateSession(session.id, { lastError: why ? `${DELIVERY_FAILED}: ${why}` : DELIVERY_FAILED });
    emit?.("session:notification", { sessionId: session.id, message: note });
  } catch (err) {
    logger.error(`Failed to record origin-delivery failure for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * True while a session carries the record recordFailedOriginDelivery() leaves:
 * its last reply did not reach the conversation, or reached it only in part,
 * and no turn has settled since (a turn's completion resets lastError).
 *
 * This is the one place that knows how that record is written. Ask here rather
 * than match lastError's wording somewhere else.
 */
export function hasUndeliveredReply(session: Pick<Session, "lastError">): boolean {
  return session.lastError?.startsWith(DELIVERY_FAILED) === true;
}
