/**
 * Completion batching — one parent turn for the child completions that pile up
 * while the parent is busy. (Ported in spirit from upstream jinn 5c0292d7 +
 * 65c01e72; upstream batches its durable callback outbox, this fork batches
 * the queue_items row itself.)
 *
 * Every child completion used to become its own queue row and its own engine
 * turn, so a parent that delegated to N children ran N turns when they
 * finished, and a Slack-origin parent posted into its thread N times. A
 * completion that arrives while a completion row is still waiting now joins
 * that row instead of opening another.
 *
 * What is shared is only the engine dispatch. Each notification is still
 * persisted in the transcript as its own message; the row's prompt is rebuilt
 * from all of them, and the dispatcher reads the prompt from the row when the
 * turn starts.
 *
 * Only the pending TAIL row is ever joined, and only if it is a completion
 * batch: reaching past an operator message, a detached-job wake-up, a restart
 * nudge or a failed child's notification would reorder work. A failure is
 * never batched — callbacks.ts does not mark it — so it keeps a turn of its own.
 */
import type { Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import type { SessionQueue } from "./queue.js";
import { enqueueQueueItem, getSession, initDb } from "./registry.js";

/** Upstream's limits: a batch is one prompt, and a prompt has to stay readable. */
export const COMPLETION_BATCH_MAX_ITEMS = 32;
export const COMPLETION_BATCH_MAX_CHARS = 128_000;

const BATCH_KIND = "child-completion";

export interface AcceptedCompletion {
  /** The queue row this completion will run under. */
  queueItemId: string;
  /** That row's prompt as of now. */
  prompt: string;
  /** True when it joined a row that was already waiting. */
  joined: boolean;
  /** Completions in the row, this one included. */
  size: number;
}

/** One engine-facing prompt for the completions sharing a row. */
export function completionBatchPrompt(messages: readonly string[]): string {
  if (messages.length === 1) return messages[0];
  return [
    `📬 ${messages.length} child-session updates arrived while this session was busy. ` +
      "Read all of them before you act, then answer once.",
    ...messages.map((message, index) => `--- Update ${index + 1} of ${messages.length} ---\n${message}`),
  ].join("\n\n");
}

function batchMessages(raw: unknown): string[] | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; items?: unknown };
    if (parsed?.kind !== BATCH_KIND || !Array.isArray(parsed.items)) return null;
    return parsed.items.every((item): item is string => typeof item === "string") ? parsed.items : null;
  } catch {
    return null;
  }
}

const storedBatch = (messages: readonly string[]) => JSON.stringify({ kind: BATCH_KIND, items: messages });

/**
 * Queue a child's completion notification for its parent: join the pending
 * tail row when that is a completion batch with room, otherwise open a row.
 * The lookup and the write share one transaction, and a row that has started
 * is no longer pending, so a turn never runs a half-written prompt.
 *
 * `canJoin` lets the caller veto a row the database still shows as pending but
 * that will never run (see {@link queueChildCompletion}).
 */
export function acceptChildCompletion(
  sessionId: string,
  sessionKey: string,
  message: string,
  canJoin: (queueItemId: string) => boolean = () => true,
): AcceptedCompletion {
  const database = initDb();
  return database.transaction((): AcceptedCompletion => {
    const tail = database.prepare(`
      SELECT id, batch FROM queue_items
      WHERE session_id = ? AND session_key = ? AND status = 'pending'
      ORDER BY position DESC, created_at DESC, rowid DESC
      LIMIT 1
    `).get(sessionId, sessionKey) as { id: string; batch: string | null } | undefined;
    const waiting = tail ? batchMessages(tail.batch) : null;
    if (tail && waiting && waiting.length < COMPLETION_BATCH_MAX_ITEMS && canJoin(tail.id)) {
      const messages = [...waiting, message];
      const prompt = completionBatchPrompt(messages);
      if (prompt.length <= COMPLETION_BATCH_MAX_CHARS) {
        database.prepare("UPDATE queue_items SET prompt = ?, batch = ? WHERE id = ? AND status = 'pending'")
          .run(prompt, storedBatch(messages), tail.id);
        return { queueItemId: tail.id, prompt, joined: true, size: messages.length };
      }
    }
    const queueItemId = enqueueQueueItem(sessionId, sessionKey, message);
    database.prepare("UPDATE queue_items SET batch = ? WHERE id = ?").run(storedBatch([message]), queueItemId);
    return { queueItemId, prompt: message, joined: false, size: 1 };
  }).immediate();
}

/** The prompt a queue row holds now. A dispatcher captures the prompt when it
 *  is scheduled, but a completion batch grows while its row waits, so the turn
 *  runs what the row says. Falls back to the captured prompt for a run with no
 *  row (or a row that is gone). */
export function queuedPrompt(queueItemId: string | undefined, captured: string): string {
  if (!queueItemId) return captured;
  try {
    const row = initDb().prepare("SELECT prompt FROM queue_items WHERE id = ?").get(queueItemId) as { prompt: string } | undefined;
    return row?.prompt ?? captured;
  } catch {
    return captured; // the turn still runs — with what its dispatcher was given
  }
}

/** True for a row opened by {@link acceptChildCompletion} — a notification
 *  wake-up whatever its prompt has grown into. */
export function isCompletionBatchItem(queueItemId: string): boolean {
  try {
    const row = initDb().prepare("SELECT batch FROM queue_items WHERE id = ?").get(queueItemId) as { batch: string | null } | undefined;
    return batchMessages(row?.batch) !== null;
  } catch {
    return false; // asked during the boot replay, which must not stop on it
  }
}

/**
 * The child whose successful completion a notification reports — when the
 * caller says so (callbacks.ts marks them) and that session really is this
 * session's child. Anything else is an ordinary notification.
 */
export function completionChildOf(parent: Session, body: unknown): string | null {
  const childId = (body as { completionOf?: unknown } | null)?.completionOf;
  if (typeof childId !== "string" || !childId) return null;
  return getSession(childId)?.parentSessionId === parent.id ? childId : null;
}

export interface QueuedCompletion extends AcceptedCompletion {
  /** False when the row it joined already has a dispatcher that will run it. */
  needsDispatch: boolean;
}

/**
 * What the notification route calls: queue `message` as a child completion if
 * `body` marks it as one, and return null for anything else — so the caller
 * queues it the ordinary way. Batching only saves turns; it must never cost a
 * notification, so a failure here (logged) also falls back to the ordinary
 * path instead of failing the request the child's callback is waiting on.
 *
 * The live queue decides two things the database cannot. A row whose only
 * dispatcher a stop has cancelled is still "pending" until that dispatcher
 * drains, but it will be closed without running — joining it would lose the
 * completion, so a new row is opened instead. And a row with no dispatcher at
 * all (a restart left it behind) needs one even though it was joined.
 */
export function queueChildCompletion(
  parent: Session,
  sessionKey: string,
  body: unknown,
  message: string,
  queue: Pick<SessionQueue, "dispatchState">,
): QueuedCompletion | null {
  try {
    if (!completionChildOf(parent, body)) return null;
    const accepted = acceptChildCompletion(parent.id, sessionKey, message, (id) => queue.dispatchState(id) !== "cancelled");
    return { ...accepted, needsDispatch: !accepted.joined || queue.dispatchState(accepted.queueItemId) === "none" };
  } catch (err) {
    logger.warn(`[completion-batching] Could not batch a completion for session ${parent.id}; queueing it on its own: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
