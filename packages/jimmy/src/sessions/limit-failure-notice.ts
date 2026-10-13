/**
 * How often a usage-limit failure that names its reset is posted.
 *
 * A turn that meets a limit it will not wait for fails at once, with the reset
 * time for its answer. A conversation gets that answer every time: somebody
 * asked. A cron job's delivery channel got it on every fire as well — the same
 * text every fifteen minutes, for the days a weekly limit lasts. It is told
 * once per limit period now. Every fire is still recorded as failed for that
 * reason; only the repeat of a message already in the channel is held back.
 */

import { logger } from "../shared/logger.js";
import type { EngineResult, Session } from "../shared/types.js";
import { claimUsageLimitAnnouncement, usageLimitAnnounced } from "./engine-health-gate.js";
import type { TurnDelivery } from "./turn-delivery.js";

/** A limit period: the engine, and the reset it stated (ISO). */
export interface LimitPeriod {
  engine: string;
  resetsAt: string;
}

/** The failures made for a limit that is not waited for, with the period each is about. */
const limitFailures = new WeakMap<EngineResult, LimitPeriod>();

/** The same, by the session whose turn it was, for whoever reports that turn's
 *  failure onward (see limitFailureOf). The most recent sessions only: a cron
 *  job makes a new session on every fire, for as long as a limit lasts. */
const MAX_REMEMBERED_SESSIONS = 256;
const failedSessions = new Map<string, { period: LimitPeriod; error: string }>();

/** Mark `failed` as the answer of a turn — `sessionId`'s, when it is known —
 *  that met `period` and will not wait for it. */
export function noteLimitFailure(failed: EngineResult, period: LimitPeriod, sessionId?: string): EngineResult {
  limitFailures.set(failed, period);
  if (sessionId && failed.error) {
    failedSessions.delete(sessionId); // re-inserted below, as the most recent
    failedSessions.set(sessionId, { period, error: failed.error });
    for (const oldest of failedSessions.keys()) {
      if (failedSessions.size <= MAX_REMEMBERED_SESSIONS) break;
      failedSessions.delete(oldest);
    }
  }
  return failed;
}

/**
 * The limit period a session's turn failed on, if that failure is still what
 * the session records. For whoever reports the failure onward — the cron
 * runner, for its alert — so that "was it a usage limit, and which" is not
 * read back out of the wording of an error.
 *
 * A later turn, or a reply that could not be delivered, records something else
 * on the session; then that is what failed, and this names nothing.
 */
export function limitFailureOf(session: Pick<Session, "id" | "lastError"> | undefined): LimitPeriod | undefined {
  const noted = session ? failedSessions.get(session.id) : undefined;
  return noted && session?.lastError === noted.error ? noted.period : undefined;
}

/**
 * Whom a cron fire's replies reach: the channel its job delivers to, or the job
 * when it delivers nowhere. Undefined for anything that is not a job's fire — a
 * conversation, or a cron-started session that reports through another route.
 * Counting by channel means every channel waiting for a job's output learns why
 * none is coming, and learns it once however many jobs deliver there.
 */
function cronAudience(session: Session): string | undefined {
  if (session.source !== "cron") return undefined;
  const meta = (session.transportMeta ?? {}) as Record<string, unknown>;
  const { deliveryConnector, deliveryChannel, cronJobId } = meta;
  if (typeof deliveryConnector === "string" && typeof deliveryChannel === "string") return `cron-delivery:${deliveryConnector}:${deliveryChannel}`;
  return typeof cronJobId === "string" ? `cron-job:${cronJobId}` : undefined;
}

/**
 * Deliver a turn's answer — unless it is a limit failure that its cron job's
 * delivery channel has already been told for the same limit period, which is
 * not posted again. "Told" means the post went out: one the channel refused is
 * left for the next fire to try.
 *
 * Nothing is recorded as undelivered for a post that was held back: the turn
 * failed on the limit, and that stays the reason on its session.
 */
export async function deliverUnlessAlreadyTold(
  session: Session,
  result: EngineResult,
  deliver: () => Promise<TurnDelivery>,
): Promise<TurnDelivery> {
  const period = limitFailures.get(result);
  const audience = period ? cronAudience(session) : undefined;
  if (!period || !audience) return deliver();
  if (usageLimitAnnounced(period.engine, period.resetsAt, audience)) {
    logger.info(`Session ${session.id}: not posting the ${period.engine} usage-limit failure again — its delivery channel was told for this limit period (resets ${period.resetsAt})`);
    return { deliveredReply: false };
  }
  const delivery = await deliver();
  if (delivery.failure === undefined) claimUsageLimitAnnouncement(period.engine, period.resetsAt, audience);
  return delivery;
}
