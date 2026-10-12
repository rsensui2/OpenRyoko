/**
 * Restart resume — nudge the sessions a gateway restart cut off mid-turn.
 * (Ported from upstream jinn a4413f68 / PLA-204; adapted, because this fork
 * has no delivery outbox and no restart acknowledgement.)
 *
 * A turn that arrived through a connector (Slack, Discord, …) owns no queue
 * row, so nothing replays it after a restart: the conversation the user was
 * waiting in simply stopped — no reply, no notice. Both interruption sites now
 * leave a mark on the session, and the next boot turns each mark into ONE
 * notification wake-up telling the session what happened and to carry on.
 *
 * Where the mark lives matters. The shutdown status ("interrupted") does not
 * survive: the killed turn's own completion handler still runs in the dying
 * process and overwrites it (the connector runner writes "idle"). The mark is
 * a dedicated transportMeta key, which that handler merges instead of
 * replacing.
 *
 * Restart loops. A session that restarted the gateway itself (`ryoko update
 * --restart`) must not be woken into doing it again. Three things bound that:
 * the nudge says so; a session whose nudge turn was itself cut off is not
 * nudged again within the cooldown, and no session more than a few times a
 * day; and such a nudge turn is dropped from the queue rather than replayed.
 */
import type { JinnConfig, JsonObject, Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { postSessionNotification } from "./callbacks.js";
import type { SessionQueue } from "./queue.js";
import { getMessagePage, getSession, initDb, listSessions, updateSession, type SessionMessage } from "./registry.js";

/** transportMeta key holding a session's {@link RestartResumeState}. */
export const RESTART_RESUME_META_KEY = "restartResume";
/**
 * A restart can strand any number of conversations at once. Waking them all in
 * the same tick spawns that many engine processes together — exactly when a
 * rate-limited engine starts refusing — so one boot wakes a capped number,
 * spaced apart. (Both values are upstream's.)
 */
export const MAX_RESTART_RESUMES = 10;
export const RESTART_RESUME_STAGGER_MS = 15_000;
/** An interruption older than this at boot is left for the operator. */
export const DEFAULT_RESUME_MAX_AGE_MINUTES = 120;
/** A session nudged less than this long ago is not nudged again — unless new
 *  work reached it since (see underLoopGuard). */
export const RESTART_NUDGE_COOLDOWN_MS = 30 * 60_000;
/** …and never more than this many times within the window. */
export const RESTART_NUDGE_WINDOW_LIMIT = 3;
export const RESTART_NUDGE_WINDOW_MS = 24 * 60 * 60_000;
/** Opening words of every nudge. Also how a nudge is recognised in the queue. */
export const RESTART_NUDGE_PREFIX = "[Gateway] Restart complete.";

export interface RestartResumeState {
  /** When a restart cut this session's turn off. Present until that
   *  interruption has been handled (nudged, or deliberately left alone). */
  interruptedAt?: string;
  /** Goes with `interruptedAt`: the turn had already recorded its reply when
   *  it was interrupted. What is in doubt is the delivery, not the work. */
  replyRecorded?: true;
  /** When this session was nudged, oldest first — what the loop guard reads. */
  nudgedAt: string[];
}

export type RestartResumeSkip = "workflow" | "cron" | "active" | "moved-on" | "answered" | "too-old" | "recently-nudged";

export interface RestartResumeSelection {
  candidates: Session[];
  skipped: Array<{ sessionId: string; reason: RestartResumeSkip }>;
}

export interface RestartResumePlan {
  resumes: Array<{ sessionId: string; dueAt: number }>;
  /** Candidates over the cap, by id. Reported so a busy restart is visible in
   *  the log rather than silently losing the least recent conversations. */
  deferred: string[];
}

export interface RestartNudgeBody {
  message: string;
  dedupeKey: string;
}

/** What the nudge has to tell the session beyond "you were cut off". */
export interface RestartNudgeSituation {
  /** A user message was recorded after the interruption and never answered:
   *  it was waiting in the queue and never reached the engine. */
  unseenUserMessage?: boolean;
  /** The turn had finished and recorded its reply, but the process was gone
   *  before the delivery came back: the reply may not have reached anyone. */
  replyUndelivered?: boolean;
}

export interface RestartResumeDeps {
  config: JinnConfig;
  /** The port this gateway is listening on. */
  port: number;
  /** The live session queue: a session with work on it is already resuming. */
  queue?: Pick<SessionQueue, "isRunning" | "getPendingCount">;
  /** Test overrides. */
  now?: () => number;
  post?: (port: number, sessionId: string, body: RestartNudgeBody) => Promise<void>;
  /** May return a function that un-schedules the run. */
  schedule?: (run: () => Promise<void>, delayMs: number) => (() => void) | void;
}

export interface RestartResumeSummary {
  planned: number;
  deferred: number;
  skipped: number;
  disabled?: true;
}

export interface RestartResumeHandle extends RestartResumeSummary {
  /** Stop the nudges that have not been sent yet — call it first thing at
   *  shutdown. Their sessions keep the mark, so the next boot picks them up. */
  cancel: () => void;
}

function metaObject(meta: Session["transportMeta"]): JsonObject {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
}

const isInstant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function readRestartResumeState(meta: Session["transportMeta"]): RestartResumeState {
  const raw = metaObject(meta)[RESTART_RESUME_META_KEY];
  const state = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const marked = isInstant(state.interruptedAt);
  return {
    ...(marked ? { interruptedAt: state.interruptedAt as string } : {}),
    ...(marked && state.replyRecorded === true ? { replyRecorded: true as const } : {}),
    nudgedAt: Array.isArray(state.nudgedAt) ? state.nudgedAt.filter(isInstant) : [],
  };
}

function withRestartResumeState(meta: Session["transportMeta"], state: RestartResumeState): JsonObject | null {
  const next = metaObject(meta);
  const stored: JsonObject = {
    ...(state.interruptedAt ? { interruptedAt: state.interruptedAt } : {}),
    ...(state.interruptedAt && state.replyRecorded ? { replyRecorded: true } : {}),
    ...(state.nudgedAt.length > 0 ? { nudgedAt: state.nudgedAt } : {}),
  };
  if (Object.keys(stored).length > 0) next[RESTART_RESUME_META_KEY] = stored;
  else delete next[RESTART_RESUME_META_KEY];
  return Object.keys(next).length > 0 ? next : null;
}

/** The transport meta to persist for a session a restart is cutting off now.
 *  A new interruption starts clean: only the nudge history carries over. */
export function withRestartInterruptedMark(
  meta: Session["transportMeta"],
  at: string,
  mark: { replyRecorded?: boolean } = {},
): JsonObject {
  return withRestartResumeState(meta, {
    interruptedAt: at,
    ...(mark.replyRecorded ? { replyRecorded: true as const } : {}),
    nudgedAt: readRestartResumeState(meta).nudgedAt,
  }) ?? {};
}

/** Take the pending mark off a session, optionally putting a nudge on record. */
function clearRestartInterruptedMark(sessionId: string, nudgedAt?: string): void {
  const session = getSession(sessionId);
  if (!session) return;
  const state = readRestartResumeState(session.transportMeta);
  if (!state.interruptedAt && !nudgedAt) return;
  const history = nudgedAt
    ? [...state.nudgedAt, nudgedAt]
        .filter((at) => Date.parse(nudgedAt) - Date.parse(at) < RESTART_NUDGE_WINDOW_MS)
        .slice(-RESTART_NUDGE_WINDOW_LIMIT)
    : state.nudgedAt;
  updateSession(sessionId, { transportMeta: withRestartResumeState(session.transportMeta, { nudgedAt: history }) });
}

let shuttingDown = false;

/**
 * First thing at shutdown, before anything is awaited. From here until the
 * process is gone, an engine that stops was stopped by the shutdown — through
 * kill(), or because a process supervisor signalled the whole control group
 * and Claude's process got the SIGTERM before the gateway reached its own kill.
 */
export function beginGatewayShutdown(): void {
  shuttingDown = true;
}

export function isGatewayShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * A turn the shutdown cut off without going through kill() (see above). It may
 * be over before interruptRunningSessionsForShutdown() looks, and a session
 * that is no longer "running" then is not marked there — so the turn's own
 * runner marks it, and the next boot resumes it like any other.
 */
export function markTurnCutOffByShutdown(sessionId: string, now = Date.now()): void {
  const session = getSession(sessionId);
  if (!session || session.workflowProvenance || session.source === "cron") return;
  updateSession(sessionId, { transportMeta: withRestartInterruptedMark(session.transportMeta, new Date(now).toISOString()) });
}

const newestMessage = (sessionId: string): SessionMessage | undefined => getMessagePage(sessionId, { limit: 1 }).messages.at(-1);

/**
 * True when a "running" session has already recorded the reply of its current
 * turn. A connector turn records its reply, THEN delivers it, and only then
 * leaves "running", so a restart can land in between. The work is done; what
 * the mark cannot know yet is whether the delivery will come back before the
 * process is gone (see the "answered" rule in skipReason).
 *
 * The newest transcript entry being the assistant's reply is the evidence,
 * with one exception. A notification or web message is recorded when it is
 * accepted, so when it waited behind a running turn, that turn's reply is the
 * newer entry while the queued turn runs. A queue row that started running
 * after the reply says so: the reply belongs to the turn before it.
 *
 * Nor is the record of an interrupted turn a reply (see below): a shutdown
 * can land while the runner that wrote it is still winding down.
 */
function replyAlreadyRecorded(session: Session, newest = newestMessage(session.id)): boolean {
  if (newest?.role !== "assistant") return false;
  // Not a reply: the connector runner records the engine's "Interrupted: …"
  // text for a turn it settles as interrupted, and never delivers it.
  if (/^Interrupted/i.test(newest.content)) return false;
  const running = initDb().prepare(
    "SELECT started_at AS startedAt FROM queue_items WHERE session_key = ? AND status = 'running' AND session_id = ? ORDER BY started_at DESC LIMIT 1",
  ).get(session.sessionKey, session.id) as { startedAt: string | null } | undefined;
  return !(running?.startedAt && Date.parse(running.startedAt) >= newest.timestamp);
}

/**
 * Graceful shutdown, right before the engines are killed: every session that
 * is mid-turn becomes "interrupted" (its engine session id is kept, so it can
 * be resumed) and gets the mark the next boot reads — which also says whether
 * the turn had already recorded its reply. Returns how many were interrupted.
 *
 * Workflow attempts are skipped: recoverStaleWorkflowAttemptSessions(), which
 * the caller runs first, stamps their `gateway-restart` receipt — a plain
 * interrupt here would read as an operator stop on the next boot.
 */
export function interruptRunningSessionsForShutdown(now = Date.now()): number {
  shuttingDown = true;
  const interruptedAt = new Date(now).toISOString();
  let interrupted = 0;
  for (const session of listSessions({ status: "running" })) {
    if (session.workflowProvenance?.kind === "phase") continue;
    updateSession(session.id, {
      status: "interrupted",
      lastActivity: interruptedAt,
      lastError: "Interrupted: gateway shutting down gracefully",
      // The killed turn's completion overwrites the status; the mark is what the next boot reads.
      transportMeta: withRestartInterruptedMark(session.transportMeta, interruptedAt, { replyRecorded: replyAlreadyRecorded(session) }),
    });
    logger.info(`Marked session ${session.id} as interrupted for resume`);
    interrupted++;
  }
  return interrupted;
}

/**
 * Boot step, BEFORE recoverStaleSessions() and recoverStaleQueueItems() — both
 * erase what this reads.
 *
 * - A session still "running" was never shut down cleanly (crash, SIGKILL, a
 *   shutdown that ran out of time). Its last sign of life — the heartbeat or
 *   the newest transcript entry, whichever is later — is the best estimate of
 *   when it was cut off.
 * - A nudge turn that was itself in flight is cancelled instead of going back
 *   to pending: replaying it is how a turn that restarts the gateway would
 *   loop. The session is interrupted again and falls under the cooldown.
 */
export function prepareRestartResume(now = Date.now()): { marked: number; cancelledNudges: number } {
  shuttingDown = false; // a process that is booting is not the one that was shutting down
  const database = initDb();
  return database.transaction(() => {
    const cancelledNudges = database.prepare(
      "UPDATE queue_items SET status = 'cancelled' WHERE status = 'running' AND substr(prompt, 1, ?) = ?",
    ).run(RESTART_NUDGE_PREFIX.length, RESTART_NUDGE_PREFIX).changes;
    let marked = 0;
    for (const session of listSessions({ status: "running" })) {
      // Workflow attempts have their own restart recovery; a cron run has no conversation to answer in.
      if (session.workflowProvenance || session.source === "cron") continue;
      const newest = newestMessage(session.id);
      const heartbeat = Date.parse(session.lastActivity);
      const lastAlive = Math.max(Number.isFinite(heartbeat) ? heartbeat : 0, newest?.timestamp ?? 0);
      const at = new Date(lastAlive > 0 ? Math.min(lastAlive, now) : now).toISOString();
      const replyRecorded = replyAlreadyRecorded(session, newest);
      updateSession(session.id, { transportMeta: withRestartInterruptedMark(session.transportMeta, at, { replyRecorded }) });
      marked++;
    }
    return { marked, cancelledNudges };
  }).immediate();
}

function listMarkedSessions(): Session[] {
  const rows = initDb().prepare("SELECT id FROM sessions WHERE transport_meta LIKE ?")
    .all(`%"${RESTART_RESUME_META_KEY}"%`) as Array<{ id: string }>;
  return rows
    .map(({ id }) => getSession(id))
    .filter((session): session is Session => !!session && !!readRestartResumeState(session.transportMeta).interruptedAt);
}

/** The user has said something in this session since `sinceMs`. */
function hasUserMessageAfter(sessionId: string, sinceMs: number): boolean {
  return !!initDb().prepare("SELECT 1 FROM messages WHERE session_id = ? AND role = 'user' AND timestamp > ? LIMIT 1").get(sessionId, sinceMs);
}

/**
 * A user message recorded since `sinceMs` that an assistant reply does
 * (`answered`) or does not follow. Recording a message is the first thing a
 * turn does, so a message with nothing behind it was only received: a process
 * that is shutting down still starts the next queued turn, records its
 * message, and can exit before the session is even "running" again.
 */
function hasUserMessageSince(sessionId: string, sinceMs: number, answered: boolean): boolean {
  return !!initDb().prepare(`
    SELECT 1 FROM messages u
    WHERE u.session_id = ? AND u.role = 'user' AND u.timestamp > ?
      AND ${answered ? "" : "NOT "}EXISTS (
        SELECT 1 FROM messages a
        WHERE a.session_id = u.session_id AND a.role = 'assistant'
          AND (a.timestamp > u.timestamp OR (a.timestamp = u.timestamp AND a.rowid > u.rowid))
      )
    LIMIT 1
  `).get(sessionId, sinceMs);
}

/** New work reached the session after `sinceIso`: something the user said, or
 *  a turn queued for it (a web message, a child completion, a job wake-up).
 *  A restart nudge's own queue row is not new work. */
function hasNewInputSince(session: Session, sinceIso: string): boolean {
  if (hasUserMessageAfter(session.id, Date.parse(sinceIso))) return true;
  return !!initDb().prepare(
    "SELECT 1 FROM queue_items WHERE session_key = ? AND session_id = ? AND created_at > ? AND substr(prompt, 1, ?) <> ? LIMIT 1",
  ).get(session.sessionKey, session.id, sinceIso, RESTART_NUDGE_PREFIX.length, RESTART_NUDGE_PREFIX);
}

/**
 * The restart-loop guard. The daily cap is absolute. The cooldown is not: it
 * exists for the nudge turn itself being cut off again — the signature of a
 * turn that restarts the gateway. When new work reached the session after its
 * last nudge, the turn that was cut off is a different one, and withholding
 * its nudge would strand that work (child completions whose queue row the
 * dying process closed have no other way back).
 */
function underLoopGuard(session: Session, nudgedAt: string[], now: number): boolean {
  const recent = nudgedAt.filter((at) => now - Date.parse(at) < RESTART_NUDGE_WINDOW_MS);
  if (recent.length >= RESTART_NUDGE_WINDOW_LIMIT) return true;
  const last = recent.reduce<string | undefined>((latest, at) => (!latest || Date.parse(at) > Date.parse(latest) ? at : latest), undefined);
  if (!last || now - Date.parse(last) >= RESTART_NUDGE_COOLDOWN_MS) return false;
  return !hasNewInputSince(session, last);
}

interface SelectInput {
  now: number;
  maxAgeMs: number;
  /** True when the session already has work running or queued in this process. */
  isBusy?: (session: Session) => boolean;
}

function isActive(session: Session, isBusy?: (session: Session) => boolean): boolean {
  return session.status === "running" || session.status === "waiting" || isBusy?.(session) === true;
}

function skipReason(session: Session, input: SelectInput): RestartResumeSkip | null {
  const state = readRestartResumeState(session.transportMeta);
  const interruptedAt = Date.parse(state.interruptedAt ?? "");
  if (session.workflowProvenance) return "workflow"; // recoverStaleWorkflowAttemptSessions owns these
  if (session.source === "cron") return "cron"; // its connector lived for one run — nowhere to deliver
  if (isActive(session, input.isBusy)) return "active"; // the queue replay, or a new message, is already driving it
  // A mark can outlive its restart (the nudge could not be posted). Once the user has asked again
  // and been answered, it is history. A later message that was merely recorded proves nothing.
  if (hasUserMessageSince(session.id, interruptedAt, true)) return "moved-on";
  // The turn had recorded its reply. Its completion writes a final status only after the delivery
  // has returned, so any status but the interruption's own means the reply was dealt with — and
  // "interrupted" means the process was gone first. A later message nobody answered still needs a turn.
  if (state.replyRecorded && session.status !== "interrupted" && !hasUserMessageSince(session.id, interruptedAt, false)) return "answered";
  if (input.now - interruptedAt > input.maxAgeMs) return "too-old";
  if (underLoopGuard(session, state.nudgedAt, input.now)) return "recently-nudged";
  return null;
}

/**
 * Boot step, AFTER the queue replay: decide who gets a nudge. Everyone who
 * does not has the mark taken off here, so it cannot resurface on a later
 * restart the session had nothing to do with. A candidate keeps its mark until
 * its nudge is accepted — a restart inside the stagger window loses nothing.
 */
export function selectRestartResumeCandidates(input: SelectInput): RestartResumeSelection {
  return initDb().transaction(() => {
    const selection: RestartResumeSelection = { candidates: [], skipped: [] };
    for (const session of listMarkedSessions()) {
      const reason = skipReason(session, input);
      if (!reason) {
        selection.candidates.push(session);
        continue;
      }
      clearRestartInterruptedMark(session.id);
      selection.skipped.push({ sessionId: session.id, reason });
    }
    return selection;
  }).immediate();
}

function activityMillis(session: Session): number {
  const parsed = Date.parse(session.lastActivity);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Order the interrupted sessions, most recent conversation first, and spread
 *  their wake-ups over the stagger window. */
export function planRestartResumes(input: { candidates: Session[]; now: number }): RestartResumePlan {
  const ordered = [...input.candidates].sort((a, b) => {
    const activity = activityMillis(b) - activityMillis(a);
    return activity !== 0 ? activity : a.id.localeCompare(b.id);
  });
  return {
    resumes: ordered.slice(0, MAX_RESTART_RESUMES).map((session, index) => ({
      sessionId: session.id,
      dueAt: input.now + index * RESTART_RESUME_STAGGER_MS,
    })),
    deferred: ordered.slice(MAX_RESTART_RESUMES).map((session) => session.id),
  };
}

/**
 * The wake-up itself. The session must know the break was the gateway's doing,
 * re-check whatever was mid-flight instead of assuming it ran or running it
 * again, and — if it caused the restart — not cause another. The interruption
 * time makes the text unique per interruption: the notification route treats
 * an identical persisted notification as a duplicate.
 *
 * It always sends the session to its transcript first. A message that waited
 * in the queue is recorded when the dying process starts its turn, and may
 * never reach the engine; when that turn got as far as "running", the boot
 * stamps the session afresh and the unseen message cannot be told apart any
 * more. The transcript shows it either way.
 *
 * A turn that had already recorded its reply gets a different message: there
 * is nothing to pick back up, only a reply that may not have been delivered,
 * and the session has to be told to send that same reply again rather than
 * redo the work or carry on as if it had been cut off mid-flight.
 */
export function restartResumeMessage(session: Session, interruptedAt: string, situation: RestartNudgeSituation = {}): string {
  const transcript = `GET /api/sessions/${session.id}?last=10`;
  const ownRestart = "If you restarted or updated the gateway yourself (for example `ryoko update --restart`), that restart is this one and it is done. Do NOT trigger it again";
  if (situation.replyUndelivered) {
    return [
      `${RESTART_NUDGE_PREFIX} The gateway restarted at ${interruptedAt}, just as your last reply in this conversation was being delivered — not something the user did, and not a mistake in your work. That reply is saved in this session, but it may never have reached the conversation.`,
      "",
      "Your turn had finished, so there is no work to redo. Only the delivery is in doubt:",
      "1. If you can read the conversation itself (the thread or channel), check whether that reply arrived.",
      `2. If it did not arrive, or you cannot tell, send it again: answer this message with the same reply, unchanged. You can read it back with ${transcript}`,
      "3. If it did arrive, do not post it a second time.",
      `4. ${ownRestart}.`,
    ].join("\n");
  }
  return [
    `${RESTART_NUDGE_PREFIX} Your previous turn in this conversation was cut off by a gateway restart at ${interruptedAt} — not by the user, and not by a mistake in your work.`,
    "",
    "Pick the request back up and finish it:",
    "1. First re-check anything that was in flight (a command, a tool call, a delegated child, a detached job). Look at its actual state before you assume it finished or run it again.",
    `2. ${ownRestart} — confirm the result and report it.`,
    situation.unseenUserMessage
      ? `3. The user wrote again while the gateway was restarting, and that message never reached you. Read this session's latest messages before acting — ${transcript} — and deal with it in the same answer.`
      : `3. Read this session's latest messages before acting: ${transcript}. They show the request if you have no memory of the interrupted turn, and whether the user wrote again while the gateway was restarting — a user message with no reply after it is still waiting for an answer, whether or not it ever reached you.`,
    "4. Then answer in the original conversation as usual; it is still waiting on you. If your answer to that request had already been delivered and nothing is left to do, do not post it a second time.",
  ].join("\n");
}

function busyProbe(deps: RestartResumeDeps): (session: Session) => boolean {
  const queue = deps.queue;
  return (session) => !!queue && (queue.isRunning(session.sessionKey) || queue.getPendingCount(session.sessionKey) > 0);
}

/** Wake one session, unless something else got to it first. `shuttingDown`
 *  turns true once the boot step's nudges have been cancelled. */
async function sendRestartNudge(sessionId: string, plannedAt: number, deps: RestartResumeDeps, shuttingDown: () => boolean): Promise<void> {
  const session = getSession(sessionId);
  const interruptedAt = session ? readRestartResumeState(session.transportMeta).interruptedAt : undefined;
  if (!session || !interruptedAt) return; // deleted, or already handled
  if (isActive(session, busyProbe(deps)) || Date.parse(session.lastActivity) > plannedAt) {
    clearRestartInterruptedMark(sessionId);
    logger.info(`[restart-resume] Session ${sessionId} is active again — no nudge needed`);
    return;
  }
  try {
    await (deps.post ?? postSessionNotification)(deps.port, sessionId, {
      message: restartResumeMessage(session, interruptedAt, {
        unseenUserMessage: hasUserMessageSince(sessionId, Date.parse(interruptedAt), false),
        replyUndelivered: readRestartResumeState(session.transportMeta).replyRecorded === true && session.status === "interrupted",
      }),
      dedupeKey: `restart-resume:${sessionId}:${interruptedAt}`,
    });
  } catch (err) {
    // The mark stays: the next boot retries while the interruption is still recent.
    logger.warn(`[restart-resume] Failed to nudge session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // Posted into a gateway that has since begun shutting down: the turn it
  // started dies with the rest. Not on record, so the next boot may try again.
  if (shuttingDown()) return;
  clearRestartInterruptedMark(sessionId, new Date(deps.now?.() ?? Date.now()).toISOString());
  logger.info(
    `Nudged interrupted session ${sessionId} (${session.connector ?? session.source}${session.employee ? `, ${session.employee}` : ""}) to continue after the restart`,
  );
}

function scheduleTimer(run: () => Promise<void>, delayMs: number): () => void {
  const timer = setTimeout(() => {
    run().catch((err) => logger.warn(`[restart-resume] nudge failed: ${err instanceof Error ? err.message : String(err)}`));
  }, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function maxAgeMs(config: JinnConfig): number {
  const minutes = config.sessions?.resumeInterruptedMaxAgeMinutes;
  return (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_RESUME_MAX_AGE_MINUTES) * 60_000;
}

function describeSkipped(skipped: RestartResumeSelection["skipped"]): string {
  const counts = new Map<RestartResumeSkip, number>();
  for (const { reason } of skipped) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => `${count} ${reason}`).join(", ");
}

/**
 * Boot step: tell every session this restart interrupted to carry on. Runs
 * after the pending queue replay, so a session already back on the engine
 * through its own queue row is skipped rather than resumed twice.
 *
 * The nudges go out over the stagger window, so the gateway can be shutting
 * down again before the last one is due. A nudge accepted then starts a turn
 * that is killed at once, yet stays on record as sent — the returned `cancel`
 * stops the ones still waiting.
 */
export function resumeRestartInterruptedSessions(deps: RestartResumeDeps): RestartResumeHandle {
  const now = deps.now?.() ?? Date.now();
  if (deps.config.sessions?.resumeInterruptedOnBoot === false) {
    const left = listMarkedSessions();
    for (const session of left) clearRestartInterruptedMark(session.id);
    if (left.length > 0) {
      logger.info(`Restart resume is off (sessions.resumeInterruptedOnBoot: false) — left ${left.length} interrupted session(s) for the operator`);
    }
    return { planned: 0, deferred: 0, skipped: left.length, disabled: true, cancel: () => {} };
  }
  const selection = selectRestartResumeCandidates({ now, maxAgeMs: maxAgeMs(deps.config), isBusy: busyProbe(deps) });
  const plan = planRestartResumes({ candidates: selection.candidates, now });
  for (const sessionId of plan.deferred) clearRestartInterruptedMark(sessionId);
  const schedule = deps.schedule ?? scheduleTimer;
  let cancelled = false;
  const unschedule: Array<() => void> = [];
  for (const resume of plan.resumes) {
    const nudge = () => (cancelled ? Promise.resolve() : sendRestartNudge(resume.sessionId, now, deps, () => cancelled));
    const undo = schedule(nudge, Math.max(0, resume.dueAt - now));
    if (undo) unschedule.push(undo);
  }
  const cancel = () => {
    cancelled = true;
    for (const undo of unschedule.splice(0)) undo();
  };
  if (plan.resumes.length + plan.deferred.length + selection.skipped.length > 0) {
    logger.info(
      `Restart resume: nudging ${plan.resumes.length} interrupted session(s)` +
      (plan.deferred.length > 0 ? `, ${plan.deferred.length} over the cap of ${MAX_RESTART_RESUMES} left alone` : "") +
      (selection.skipped.length > 0 ? `, skipped ${describeSkipped(selection.skipped)}` : ""),
    );
  }
  return { planned: plan.resumes.length, deferred: plan.deferred.length, skipped: selection.skipped.length, cancel };
}
