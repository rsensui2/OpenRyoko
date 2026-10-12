import type { Session, Target } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { deliverPublic, type PublicAction, type PublicDeliverer } from "./reply-disposition.js";
import { recordFailedOriginDelivery } from "./origin-delivery.js";

export interface TurnDelivery {
  /** True when the turn's last public action was a text reply and it landed. */
  deliveredReply: boolean;
  /** Why a public action did not land. Absent when everything was delivered. */
  failure?: string;
}

/**
 * Post a finished turn's public actions in order, and report how that went
 * instead of throwing. By the time this runs the engine has produced its
 * result: a connector that cannot take the reply must not turn a completed
 * turn into a failed one, or keep its state from being saved.
 *
 * Delivery stops at the first action that fails — the ones after it would
 * arrive without the message that leads into them.
 */
export async function deliverTurn(
  connector: PublicDeliverer,
  target: Target,
  actions: readonly PublicAction[],
): Promise<TurnDelivery> {
  for (const action of actions) {
    try {
      await deliverPublic(connector, target, action);
    } catch (err) {
      return { deliveredReply: false, failure: err instanceof Error ? err.message : String(err) };
    }
  }
  return { deliveredReply: actions.at(-1)?.kind === "reply" };
}

/**
 * The turn is saved, but its reply never reached the conversation. Persist
 * that on the session — the same record an undelivered background reply
 * leaves, with the transport's reason added — and log why. Call it after the
 * turn's own state update: it sets lastError.
 */
export function recordUndeliveredTurn(session: Session, failure: string): void {
  logger.error(
    `Session ${session.id}: reply was not delivered to ${session.connector ?? session.source} — ${failure}`,
  );
  recordFailedOriginDelivery(session, undefined, failure);
}
