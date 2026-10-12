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
 * the nudge says so; a session is not nudged twice within the cooldown, nor
 * more than a few times a day; and a nudge turn that was itself cut off by a
 * restart is dropped from the queue rather than replayed.
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
/** A session nudged less than this long ago is not nudged again. */
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
  /** When this session was nudged, oldest first — what the loop guard reads. */
  nudgedAt: string[];
}

export type RestartResumeSkip = "workflow" | "cron" | "active" | "moved-on" | "too-old" | "recently-nudged";

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

export interface RestartResumeDeps {
  config: JinnConfig;
  /** The port this gateway is listening on. */
  port: number;
  /** The live session queue: a session with work on it is already resuming. */
  queue?: Pick<SessionQueue, "isRunning" | "getPendingCount">;
  /** Test overrides. */
  now?: () => number;
  post?: (port: number, sessionId: string, body: RestartNudgeBody) => Promise<void>;
  schedule?: (run: () => Promise<void>, delayMs: number) => void;
}

export interface RestartResumeSummary {
  planned: number;
  deferred: number;
  skipped: number;
  disabled?: true;
}

function metaObject(meta: Session["transportMeta"]): JsonObject {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
}

const isInstant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function readRestartResumeState(meta: Session["transportMeta"]): RestartResumeState {
  const raw = metaObject(meta)[RESTART_RESUME_META_KEY];
  const state = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    ...(isInstant(state.interruptedAt) ? { interruptedAt: state.interruptedAt } : {}),
    nudgedAt: Array.isArray(state.nudgedAt) ? state.nudgedAt.filter(isInstant) : [],
  };
}

function withRestartResumeState(meta: Session["transportMeta"], state: RestartResumeState): JsonObject | null {
  const next = metaObject(meta);
  const stored: JsonObject = {
    ...(state.interruptedAt ? { interruptedAt: state.interruptedAt } : {}),
    ...(state.nudgedAt.length > 0 ? { nudgedAt: state.nudgedAt } : {}),
  };
  if (Object.keys(stored).length > 0) next[RESTART_RESUME_META_KEY] = stored;
  else delete next[RESTART_RESUME_META_KEY];
  return Object.keys(next).length > 0 ? next : null;
}

/** The transport meta to persist for a session a restart is cutting off now. */
export function withRestartInterruptedMark(meta: Session["transportMeta"], at: string): JsonObject {
  return withRestartResumeState(meta, { ...readRestartResumeState(meta), interruptedAt: at }) ?? {};
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

const newestMessage = (sessionId: string): SessionMessage | undefined => getMessagePage(sessionId, { limit: 1 }).messages.at(-1);

/**
 * True when a "running" session has in fact answered its current turn and has
 * nothing left to resume. A connector turn records its reply, THEN delivers
 * it, and only then leaves "running" — a restart that lands in between must
 * not be answered with a nudge, whose output would be posted into the thread
 * as an unprompted second message.
 *
 * The newest transcript entry being the assistant's reply is the evidence,
 * with one exception. A notification or web message is recorded when it is
 * accepted, so when it waited behind a running turn, that turn's reply is the
 * newer entry while the queued turn runs. A queue row that started running
 * after the reply says so: the reply belongs to the turn before it.
 */
function turnAlreadyAnswered(sessionId: string, newest = newestMessage(sessionId)): boolean {
  if (newest?.role !== "assistant") return false;
  const running = initDb().prepare(
    "SELECT started_at AS startedAt FROM queue_items WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
  ).get(sessionId) as { startedAt: string | null } | undefined;
  return !(running?.startedAt && Date.parse(running.startedAt) >= newest.timestamp);
}

/**
 * Graceful shutdown, right before the engines are killed: every session that
 * is mid-turn becomes "interrupted" (its engine session id is kept, so it can
 * be resumed) and, unless its turn has already answered, gets the mark the
 * next boot reads. Returns how many were interrupted.
 *
 * Workflow attempts are skipped: recoverStaleWorkflowAttemptSessions(), which
 * the caller runs first, stamps their `gateway-restart` receipt — a plain
 * interrupt here would read as an operator stop on the next boot.
 */
export function interruptRunningSessionsForShutdown(now = Date.now()): number {
  const interruptedAt = new Date(now).toISOString();
  let interrupted = 0;
  for (const session of listSessions({ status: "running" })) {
    if (session.workflowProvenance?.kind === "phase") continue;
    updateSession(session.id, {
      status: "interrupted",
      lastActivity: interruptedAt,
      lastError: "Interrupted: gateway shutting down gracefully",
      // The killed turn's completion overwrites the status; the mark is what the next boot reads.
      ...(turnAlreadyAnswered(session.id) ? {} : { transportMeta: withRestartInterruptedMark(session.transportMeta, interruptedAt) }),
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
 *   when it was cut off. One whose turn had already answered is not stamped.
 * - A nudge turn that was itself in flight is cancelled instead of going back
 *   to pending: replaying it is how a turn that restarts the gateway would
 *   loop. The session is interrupted again and falls under the cooldown.
 */
export function prepareRestartResume(now = Date.now()): { marked: number; cancelledNudges: number } {
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
      if (turnAlreadyAnswered(session.id, newest)) continue;
      const heartbeat = Date.parse(session.lastActivity);
      const lastAlive = Math.max(Number.isFinite(heartbeat) ? heartbeat : 0, newest?.timestamp ?? 0);
      const at = new Date(lastAlive > 0 ? Math.min(lastAlive, now) : now).toISOString();
      updateSession(session.id, { transportMeta: withRestartInterruptedMark(session.transportMeta, at) });
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

function recentlyNudged(nudgedAt: string[], now: number): boolean {
  const ages = nudgedAt.map((at) => now - Date.parse(at)).filter((age) => age < RESTART_NUDGE_WINDOW_MS);
  return ages.length >= RESTART_NUDGE_WINDOW_LIMIT || ages.some((age) => age < RESTART_NUDGE_COOLDOWN_MS);
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

/** The user has said something in this session since `sinceMs`. */
function hasUserMessageAfter(sessionId: string, sinceMs: number): boolean {
  return !!initDb().prepare("SELECT 1 FROM messages WHERE session_id = ? AND role = 'user' AND timestamp > ? LIMIT 1").get(sessionId, sinceMs);
}

function skipReason(session: Session, input: SelectInput): RestartResumeSkip | null {
  const state = readRestartResumeState(session.transportMeta);
  const interruptedAt = Date.parse(state.interruptedAt ?? "");
  if (session.workflowProvenance) return "workflow"; // recoverStaleWorkflowAttemptSessions owns these
  if (session.source === "cron") return "cron"; // its connector lived for one run — nowhere to deliver
  if (isActive(session, input.isBusy)) return "active"; // the queue replay, or a new message, is already driving it
  // A mark can outlive its restart (the nudge could not be posted). Once the user has carried on, it is history.
  if (hasUserMessageAfter(session.id, interruptedAt)) return "moved-on";
  if (input.now - interruptedAt > input.maxAgeMs) return "too-old";
  if (recentlyNudged(state.nudgedAt, input.now)) return "recently-nudged";
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
 */
export function restartResumeMessage(session: Session, interruptedAt: string): string {
  return [
    `${RESTART_NUDGE_PREFIX} Your previous turn in this conversation was cut off by a gateway restart at ${interruptedAt} — not by the user, and not by a mistake in your work.`,
    "",
    "Pick the request back up and finish it:",
    "1. First re-check anything that was in flight (a command, a tool call, a delegated child, a detached job). Look at its actual state before you assume it finished or run it again.",
    "2. If you restarted or updated the gateway yourself (for example `ryoko update --restart`), that restart is this one and it is done. Do NOT trigger it again — confirm the result and report it.",
    `3. If you have no memory of the interrupted turn, read this session's latest messages before acting: GET /api/sessions/${session.id}?last=10`,
    "4. Then answer in the original conversation as usual; it is still waiting on you. If your answer to that request had already been delivered and nothing is left to do, do not post it a second time.",
  ].join("\n");
}

function busyProbe(deps: RestartResumeDeps): (session: Session) => boolean {
  const queue = deps.queue;
  return (session) => !!queue && (queue.isRunning(session.sessionKey) || queue.getPendingCount(session.sessionKey) > 0);
}

/** Wake one session, unless something else got to it first. */
async function sendRestartNudge(sessionId: string, plannedAt: number, deps: RestartResumeDeps): Promise<void> {
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
      message: restartResumeMessage(session, interruptedAt),
      dedupeKey: `restart-resume:${sessionId}:${interruptedAt}`,
    });
  } catch (err) {
    // The mark stays: the next boot retries while the interruption is still recent.
    logger.warn(`[restart-resume] Failed to nudge session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  clearRestartInterruptedMark(sessionId, new Date(deps.now?.() ?? Date.now()).toISOString());
  logger.info(
    `Nudged interrupted session ${sessionId} (${session.connector ?? session.source}${session.employee ? `, ${session.employee}` : ""}) to continue after the restart`,
  );
}

function scheduleTimer(run: () => Promise<void>, delayMs: number): void {
  const timer = setTimeout(() => {
    run().catch((err) => logger.warn(`[restart-resume] nudge failed: ${err instanceof Error ? err.message : String(err)}`));
  }, delayMs);
  timer.unref?.();
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
 */
export function resumeRestartInterruptedSessions(deps: RestartResumeDeps): RestartResumeSummary {
  const now = deps.now?.() ?? Date.now();
  if (deps.config.sessions?.resumeInterruptedOnBoot === false) {
    const left = listMarkedSessions();
    for (const session of left) clearRestartInterruptedMark(session.id);
    if (left.length > 0) {
      logger.info(`Restart resume is off (sessions.resumeInterruptedOnBoot: false) — left ${left.length} interrupted session(s) for the operator`);
    }
    return { planned: 0, deferred: 0, skipped: left.length, disabled: true };
  }
  const selection = selectRestartResumeCandidates({ now, maxAgeMs: maxAgeMs(deps.config), isBusy: busyProbe(deps) });
  const plan = planRestartResumes({ candidates: selection.candidates, now });
  for (const sessionId of plan.deferred) clearRestartInterruptedMark(sessionId);
  const schedule = deps.schedule ?? scheduleTimer;
  for (const resume of plan.resumes) {
    schedule(() => sendRestartNudge(resume.sessionId, now, deps), Math.max(0, resume.dueAt - now));
  }
  if (plan.resumes.length + plan.deferred.length + selection.skipped.length > 0) {
    logger.info(
      `Restart resume: nudging ${plan.resumes.length} interrupted session(s)` +
      (plan.deferred.length > 0 ? `, ${plan.deferred.length} over the cap of ${MAX_RESTART_RESUMES} left alone` : "") +
      (selection.skipped.length > 0 ? `, skipped ${describeSkipped(selection.skipped)}` : ""),
    );
  }
  return { planned: plan.resumes.length, deferred: plan.deferred.length, skipped: selection.skipped.length };
}
