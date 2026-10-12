import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  enqueueQueueItem,
  getQueueItem,
  getSession,
  initDb,
  markQueueItemRunning,
  recoverStaleQueueItems,
  recoverStaleSessions,
  updateSession,
} from "../registry.js";
import {
  DEFAULT_RESUME_MAX_AGE_MINUTES,
  MAX_RESTART_RESUMES,
  RESTART_NUDGE_COOLDOWN_MS,
  RESTART_NUDGE_PREFIX,
  RESTART_NUDGE_WINDOW_LIMIT,
  RESTART_RESUME_META_KEY,
  RESTART_RESUME_STAGGER_MS,
  interruptRunningSessionsForShutdown,
  planRestartResumes,
  prepareRestartResume,
  readRestartResumeState,
  restartResumeMessage,
  resumeRestartInterruptedSessions,
  selectRestartResumeCandidates,
  withRestartInterruptedMark,
  type RestartResumeDeps,
} from "../restart-resume.js";
import type { JinnConfig, JsonObject, Session } from "../../shared/types.js";

const NOW = Date.parse("2026-10-12T03:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MINUTE = 60_000;
const MAX_AGE_MS = DEFAULT_RESUME_MAX_AGE_MINUTES * MINUTE;

let sequence = 0;

function config(sessions: JinnConfig["sessions"] = {}): JinnConfig {
  return { gateway: { port: 0, host: "127.0.0.1" }, sessions } as unknown as JinnConfig;
}

/** A Slack conversation whose connector turn was running when the gateway went down. */
function slackSession(overrides: { status?: Session["status"]; lastActivity?: string; transportMeta?: JsonObject | null } = {}): Session {
  const key = `slack:C_RESUME:${++sequence}`;
  const created = createSession({
    engine: "claude",
    source: "slack",
    sourceRef: key,
    connector: "slack",
    sessionKey: key,
    replyContext: { channel: "C_RESUME", thread: String(sequence) },
    transportMeta: overrides.transportMeta === undefined ? { channelExternal: false } : overrides.transportMeta ?? undefined,
  });
  updateSession(created.id, {
    status: overrides.status ?? "idle",
    lastActivity: overrides.lastActivity ?? iso(2 * MINUTE),
  });
  return getSession(created.id)!;
}

/** The same session as the gateway's shutdown loop leaves it: status interrupted + the mark. */
function interrupted(at = iso(MINUTE), overrides: Parameters<typeof slackSession>[0] & { replyRecorded?: boolean } = {}): Session {
  const session = slackSession(overrides);
  updateSession(session.id, {
    status: overrides.status ?? "interrupted",
    transportMeta: withRestartInterruptedMark(session.transportMeta, at, { replyRecorded: overrides.replyRecorded }),
  });
  return getSession(session.id)!;
}

/** A transcript entry at a chosen time (insertMessage would stamp the real clock). */
function message(sessionId: string, role: "user" | "assistant" | "notification", msAgo: number, content: string = role): void {
  initDb().prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)")
    .run(`m-${++sequence}`, sessionId, role, content, NOW - msAgo);
}

/** A queue row whose turn started at a chosen time and is still running. */
function runningRow(session: Session, prompt: string, startedMsAgo: number): string {
  const id = enqueueQueueItem(session.id, session.sessionKey, prompt);
  initDb().prepare("UPDATE queue_items SET status = 'running', created_at = ?, started_at = ? WHERE id = ?")
    .run(iso(startedMsAgo + 1_000), iso(startedMsAgo), id);
  return id;
}

function markOf(sessionId: string) {
  return readRestartResumeState(getSession(sessionId)!.transportMeta);
}

/** Boot step with every outside effect captured: nothing is posted, nothing sleeps. */
function boot(overrides: Partial<RestartResumeDeps> = {}) {
  const timers: Array<{ run: () => Promise<void>; delayMs: number }> = [];
  const post = vi.fn<NonNullable<RestartResumeDeps["post"]>>(async () => {});
  const deps: RestartResumeDeps = {
    config: config(),
    port: 0,
    now: () => NOW,
    post,
    schedule: (run, delayMs) => { timers.push({ run, delayMs }); },
    ...overrides,
  };
  const summary = resumeRestartInterruptedSessions(deps);
  /** Fire every scheduled nudge and wait for it to settle. */
  const fire = async () => {
    for (const timer of timers) await timer.run();
  };
  return { summary, timers, post: (overrides.post as typeof post | undefined) ?? post, fire };
}

beforeEach(() => {
  const db = initDb();
  db.prepare("DELETE FROM queue_items").run();
  db.prepare("DELETE FROM messages").run();
  db.prepare("DELETE FROM sessions").run();
});

describe("restart interruption mark", () => {
  it("is added without disturbing the rest of the transport meta or the nudge history", () => {
    const meta = { channelExternal: true, engineSessions: { claude: "e-1" }, [RESTART_RESUME_META_KEY]: { nudgedAt: [iso(90 * MINUTE)] } };

    const marked = withRestartInterruptedMark(meta, iso(0));

    expect(marked).toEqual({
      channelExternal: true,
      engineSessions: { claude: "e-1" },
      [RESTART_RESUME_META_KEY]: { interruptedAt: iso(0), nudgedAt: [iso(90 * MINUTE)] },
    });
    expect(meta[RESTART_RESUME_META_KEY]).toEqual({ nudgedAt: [iso(90 * MINUTE)] }); // input untouched
    expect(withRestartInterruptedMark(null, iso(0))).toEqual({ [RESTART_RESUME_META_KEY]: { interruptedAt: iso(0) } });
  });

  it("can say the turn had already recorded its reply — and a later interruption starts clean", () => {
    const marked = withRestartInterruptedMark({ channelExternal: true }, iso(MINUTE), { replyRecorded: true });
    expect(marked).toEqual({ channelExternal: true, [RESTART_RESUME_META_KEY]: { interruptedAt: iso(MINUTE), replyRecorded: true } });
    expect(readRestartResumeState(marked)).toEqual({ interruptedAt: iso(MINUTE), replyRecorded: true, nudgedAt: [] });

    // The same session, cut off again later in the middle of a turn.
    const again = withRestartInterruptedMark(marked, iso(0));
    expect(readRestartResumeState(again)).toEqual({ interruptedAt: iso(0), nudgedAt: [] });
  });

  it("is stamped at boot on a session the previous process never got to shut down cleanly", () => {
    const crashed = slackSession({ status: "running", lastActivity: iso(7 * MINUTE) });
    const idle = slackSession({ status: "idle" });
    const waiting = slackSession({ status: "waiting" });

    expect(prepareRestartResume(NOW).marked).toBe(1);

    // The last sign of life is the best estimate of when it was cut off —
    // the sweep below overwrites lastActivity, so it has to be read first.
    expect(markOf(crashed.id).interruptedAt).toBe(iso(7 * MINUTE));
    expect(recoverStaleSessions()).toBe(1);
    expect(getSession(crashed.id)?.status).toBe("interrupted");
    expect(markOf(crashed.id).interruptedAt).toBe(iso(7 * MINUTE));
    for (const untouched of [idle, waiting]) expect(markOf(untouched.id).interruptedAt).toBeUndefined();
  });

  it("records at boot that a crashed session had already recorded its reply", () => {
    // Whether that reply went out is unknown: the crash came before the turn could write its final status.
    const delivering = slackSession({ status: "running" });
    message(delivering.id, "user", 10 * MINUTE);
    message(delivering.id, "assistant", 5_000);
    const queued = slackSession({ status: "running" });
    message(queued.id, "notification", 3 * MINUTE, "📩 child finished");
    message(queued.id, "assistant", 2 * MINUTE, "the previous turn's reply");
    runningRow(queued, "📩 child finished", MINUTE);

    expect(prepareRestartResume(NOW).marked).toBe(2);

    expect(markOf(delivering.id)).toMatchObject({ interruptedAt: iso(5_000), replyRecorded: true });
    expect(markOf(queued.id).interruptedAt).toBeDefined();
    expect(markOf(queued.id).replyRecorded).toBeUndefined(); // a later turn was running: it never answered
  });

  it("dates a crash by the last sign of life — the heartbeat or the transcript, whichever is newer", () => {
    // A connector turn has no heartbeat: lastActivity is when the turn began.
    const crashed = slackSession({ status: "running", lastActivity: iso(7 * MINUTE) });
    message(crashed.id, "user", 7 * MINUTE);
    message(crashed.id, "notification", 2 * MINUTE, "📩 accepted while the turn ran");

    prepareRestartResume(NOW);

    expect(markOf(crashed.id).interruptedAt).toBe(iso(2 * MINUTE));
  });

  it("is never stamped on a workflow attempt session", () => {
    const attempt = createSession({
      engine: "claude", source: "workflow", sourceRef: "workflow:w:r:n:1", connector: "workflow", sessionKey: "workflow:w:r:n:1",
      workflowProvenance: { kind: "phase", workflowId: "w", workflowName: "w", runId: "r", triggerSource: "manual", phase: { nodeId: "n", name: "n", index: 1, round: 1, attempt: 1 } },
    });
    updateSession(attempt.id, { status: "running" });

    expect(prepareRestartResume(NOW).marked).toBe(0);
    expect(markOf(attempt.id).interruptedAt).toBeUndefined();
  });
});

describe("interruptRunningSessionsForShutdown — the graceful-shutdown half", () => {
  it("marks a running session interrupted and stamps the restart mark", () => {
    const running = slackSession({ status: "running" });

    expect(interruptRunningSessionsForShutdown(NOW)).toBe(1);

    const after = getSession(running.id)!;
    expect(after.status).toBe("interrupted");
    expect(after.lastActivity).toBe(iso(0));
    expect(after.lastError).toBe("Interrupted: gateway shutting down gracefully");
    expect(markOf(running.id).interruptedAt).toBe(iso(0));
    expect(after.transportMeta).toMatchObject({ channelExternal: false }); // the rest of the meta is kept
  });

  it("leaves sessions that are not mid-turn exactly as they are", () => {
    const others = (["idle", "waiting", "error", "interrupted"] as const).map((status) => slackSession({ status }));

    expect(interruptRunningSessionsForShutdown(NOW)).toBe(0);

    for (const before of others) {
      const after = getSession(before.id)!;
      expect(after.status).toBe(before.status);
      expect(after.lastActivity).toBe(before.lastActivity);
      expect(markOf(before.id).interruptedAt).toBeUndefined();
    }
  });

  it("stamps a turn that had recorded its reply, and says that only the delivery is in doubt", () => {
    // A connector turn records its reply, then delivers it, then writes idle.
    const delivering = slackSession({ status: "running" });
    message(delivering.id, "user", 10 * MINUTE);
    message(delivering.id, "assistant", 5_000);

    expect(interruptRunningSessionsForShutdown(NOW)).toBe(1);

    expect(getSession(delivering.id)?.status).toBe("interrupted");
    expect(markOf(delivering.id)).toEqual({ interruptedAt: iso(0), replyRecorded: true, nudgedAt: [] });
  });

  it("still stamps a queued turn whose input was recorded before the previous turn's reply", () => {
    // A notification (or a web message) is persisted when it is ACCEPTED. If it
    // waited behind a running turn, that turn's reply is the newer entry — but
    // the turn running now is the queued one, and it has not answered.
    const parent = slackSession({ status: "running" });
    message(parent.id, "user", 10 * MINUTE);
    message(parent.id, "notification", 3 * MINUTE, "📩 child finished");
    message(parent.id, "assistant", 2 * MINUTE, "reply of the turn that was running when the child finished");
    runningRow(parent, "📩 child finished", MINUTE);

    interruptRunningSessionsForShutdown(NOW);

    expect(markOf(parent.id)).toEqual({ interruptedAt: iso(0), nudgedAt: [] }); // mid-turn: nothing recorded for it yet
  });

  it("leaves a workflow attempt to its own sweep", () => {
    const attempt = createSession({
      engine: "claude", source: "workflow", sourceRef: "workflow:w:r:n:9", connector: "workflow", sessionKey: "workflow:w:r:n:9",
      workflowProvenance: { kind: "phase", workflowId: "w", workflowName: "w", runId: "r", triggerSource: "manual", phase: { nodeId: "n", name: "n", index: 1, round: 1, attempt: 9 } },
    });
    updateSession(attempt.id, { status: "running" });

    expect(interruptRunningSessionsForShutdown(NOW)).toBe(0);

    // recoverStaleWorkflowAttemptSessions() stamps the gateway-restart receipt; a plain interrupt here would misclassify it.
    expect(getSession(attempt.id)?.status).toBe("running");
    expect(markOf(attempt.id).interruptedAt).toBeUndefined();
  });
});

describe("selectRestartResumeCandidates", () => {
  const select = (overrides: Partial<Parameters<typeof selectRestartResumeCandidates>[0]> = {}) =>
    selectRestartResumeCandidates({ now: NOW, maxAgeMs: MAX_AGE_MS, ...overrides });

  it("picks a session a restart interrupted, whatever its completion handler left in `status`", () => {
    // Web path: the shutdown status survives. Connector path: the killed turn's
    // completion overwrites it with idle (or error) — only the mark is left.
    const web = interrupted(iso(MINUTE), { status: "interrupted" });
    const connector = interrupted(iso(MINUTE), { status: "idle" });
    const errored = interrupted(iso(MINUTE), { status: "error" });

    const { candidates, skipped } = select();

    expect(candidates.map((s) => s.id).sort()).toEqual([web.id, connector.id, errored.id].sort());
    expect(skipped).toEqual([]);
  });

  it("ignores sessions that carry no mark", () => {
    slackSession({ status: "interrupted" });
    slackSession({ status: "idle", transportMeta: { [RESTART_RESUME_META_KEY]: { nudgedAt: [iso(5 * MINUTE)] } } });

    expect(select()).toEqual({ candidates: [], skipped: [] });
  });

  it("leaves out cron runs and workflow attempts, and consumes their marks", () => {
    const cron = createSession({ engine: "claude", source: "cron", sourceRef: "cron:job:1", connector: "cron", sessionKey: "cron:job:1" });
    updateSession(cron.id, { status: "interrupted", transportMeta: withRestartInterruptedMark(null, iso(MINUTE)) });
    const attempt = createSession({
      engine: "claude", source: "workflow", sourceRef: "workflow:w:r:n:2", connector: "workflow", sessionKey: "workflow:w:r:n:2",
      workflowProvenance: { kind: "phase", workflowId: "w", workflowName: "w", runId: "r", triggerSource: "manual", phase: { nodeId: "n", name: "n", index: 1, round: 1, attempt: 2 } },
    });
    updateSession(attempt.id, { status: "interrupted", transportMeta: withRestartInterruptedMark(null, iso(MINUTE)) });

    const { candidates, skipped } = select();

    expect(candidates).toEqual([]);
    expect(skipped).toEqual(expect.arrayContaining([
      { sessionId: cron.id, reason: "cron" },
      { sessionId: attempt.id, reason: "workflow" },
    ]));
    expect(markOf(cron.id).interruptedAt).toBeUndefined();
    expect(markOf(attempt.id).interruptedAt).toBeUndefined();
    expect(getSession(cron.id)?.transportMeta).toBeNull(); // nothing else was in there
  });

  it("leaves out a session the queue replay (or a new message) is already driving", () => {
    const replayed = interrupted(iso(MINUTE), { status: "running" });
    const waiting = interrupted(iso(MINUTE), { status: "waiting" });
    const queued = interrupted(iso(MINUTE), { status: "idle" });

    const { candidates, skipped } = select({ isBusy: (session) => session.id === queued.id });

    expect(candidates).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["active", "active", "active"]);
    for (const session of [replayed, waiting, queued]) expect(markOf(session.id).interruptedAt).toBeUndefined();
  });

  it("leaves out an interruption older than the limit", () => {
    const stale = interrupted(iso(121 * MINUTE));
    const recent = interrupted(iso(119 * MINUTE));

    const { candidates, skipped } = select();

    expect(candidates.map((s) => s.id)).toEqual([recent.id]);
    expect(skipped).toEqual([{ sessionId: stale.id, reason: "too-old" }]);
    expect(markOf(stale.id).interruptedAt).toBeUndefined();
    expect(markOf(recent.id).interruptedAt).toBe(iso(119 * MINUTE)); // a candidate keeps its mark until it is nudged
  });

  it("leaves out a turn whose reply was recorded and whose completion then finished", () => {
    // The completion handler writes its final status only after the delivery has
    // returned, so anything other than the shutdown's own "interrupted" means it did.
    const delivered = interrupted(iso(MINUTE), { status: "idle", replyRecorded: true });
    const deliveredWithError = interrupted(iso(MINUTE), { status: "error", replyRecorded: true });

    const { candidates, skipped } = select();

    expect(candidates).toEqual([]);
    expect(skipped).toEqual(expect.arrayContaining([
      { sessionId: delivered.id, reason: "answered" },
      { sessionId: deliveredWithError.id, reason: "answered" },
    ]));
    expect(markOf(delivered.id)).toEqual({ nudgedAt: [] });
  });

  it("picks a turn whose reply was recorded but whose delivery never came back", () => {
    // Still "interrupted": the process was gone before the turn could write anything else.
    const undelivered = interrupted(iso(MINUTE), { status: "interrupted", replyRecorded: true });

    const { candidates, skipped } = select();

    expect(candidates.map((s) => s.id)).toEqual([undelivered.id]);
    expect(skipped).toEqual([]);
  });

  it("picks an answered turn after all when a later message was recorded and never answered", () => {
    // The reply went out; then the dying process started the next queued message and got no further.
    const session = interrupted(iso(MINUTE), { status: "idle", replyRecorded: true });
    message(session.id, "user", 5 * MINUTE, "the request that was answered");
    message(session.id, "assistant", MINUTE + 2_000, "its answer");
    message(session.id, "user", 30_000, "a follow-up that was waiting in the queue");

    expect(select()).toMatchObject({ candidates: [{ id: session.id }], skipped: [] });
  });

  it("leaves out a session whose conversation moved on after the mark", () => {
    // The mark outlived its restart (the nudge could not be posted), and the
    // user has since carried on: asked again, and was answered.
    const movedOn = interrupted(iso(10 * MINUTE), { status: "idle" });
    message(movedOn.id, "user", 20 * MINUTE, "the request that was cut off");
    message(movedOn.id, "user", 5 * MINUTE, "a new request, after the restart");
    message(movedOn.id, "assistant", 4 * MINUTE, "the answer to it");
    const waiting = interrupted(iso(10 * MINUTE), { status: "idle" });
    message(waiting.id, "user", 20 * MINUTE, "the request that was cut off");
    message(waiting.id, "notification", 5 * MINUTE, "not something the user said");

    const { candidates, skipped } = select();

    expect(candidates.map((s) => s.id)).toEqual([waiting.id]);
    expect(skipped).toEqual([{ sessionId: movedOn.id, reason: "moved-on" }]);
    expect(markOf(movedOn.id).interruptedAt).toBeUndefined();
  });

  it("keeps a session whose later message was only recorded, never answered", () => {
    // A message queued behind the turn that was cut off: the dying process
    // starts its turn, records it, and exits before anything else happens.
    // That is not the conversation moving on — neither turn was resumed.
    const session = interrupted(iso(10 * MINUTE), { status: "idle" });
    message(session.id, "user", 20 * MINUTE, "the request that was cut off");
    message(session.id, "assistant", 9 * MINUTE + 59_000, "Interrupted: gateway shutting down");
    message(session.id, "user", 9 * MINUTE + 58_000, "a follow-up that was waiting in the queue");

    const { candidates, skipped } = select();

    expect(candidates.map((s) => s.id)).toEqual([session.id]);
    expect(skipped).toEqual([]);
    expect(markOf(session.id).interruptedAt).toBe(iso(10 * MINUTE));
  });

  it("leaves out a session that was nudged a moment ago (restart-loop guard)", () => {
    const justNudged = interrupted(iso(MINUTE), {
      transportMeta: { [RESTART_RESUME_META_KEY]: { nudgedAt: [iso(RESTART_NUDGE_COOLDOWN_MS - MINUTE)] } },
    });
    const longAgo = interrupted(iso(MINUTE), {
      transportMeta: { [RESTART_RESUME_META_KEY]: { nudgedAt: [iso(RESTART_NUDGE_COOLDOWN_MS + MINUTE)] } },
    });

    const { candidates, skipped } = select();

    expect(candidates.map((s) => s.id)).toEqual([longAgo.id]);
    expect(skipped).toEqual([{ sessionId: justNudged.id, reason: "recently-nudged" }]);
    // The history is what the guard reads next time — only the pending mark goes.
    expect(markOf(justNudged.id)).toEqual({ nudgedAt: [iso(RESTART_NUDGE_COOLDOWN_MS - MINUTE)] });
  });

  it("does not hold the cooldown against a session cut off in a NEW turn after its nudge", () => {
    // The loop guard is about the nudge turn itself being cut off again. A
    // user turn that started after the nudge is a different interruption.
    const nudged = { [RESTART_RESUME_META_KEY]: { nudgedAt: [iso(20 * MINUTE)] } };
    const newUserTurn = interrupted(iso(MINUTE), { transportMeta: nudged });
    message(newUserTurn.id, "user", 10 * MINUTE, "nudge のあとに来た新しい依頼");
    // Child completions queued after the nudge are new work too: when the turn
    // running them is cut off, their queue row is gone and the nudge is all that is left.
    const completions = interrupted(iso(MINUTE), { transportMeta: nudged });
    const row = enqueueQueueItem(completions.id, completions.sessionKey, "📬 2 child-session updates arrived while this session was busy.");
    initDb().prepare("UPDATE queue_items SET status = 'completed', created_at = ? WHERE id = ?").run(iso(10 * MINUTE), row);

    const { candidates, skipped } = select();

    expect(candidates.map((s) => s.id).sort()).toEqual([newUserTurn.id, completions.id].sort());
    expect(skipped).toEqual([]);
  });

  it("still holds the cooldown when the turn that was cut off is the nudge itself", () => {
    // What a nudge turn that restarted the gateway leaves behind: its own queue
    // row, its own notification, and the web runner's "interrupted" notice.
    const looping = interrupted(iso(MINUTE), { transportMeta: { [RESTART_RESUME_META_KEY]: { nudgedAt: [iso(20 * MINUTE)] } } });
    const nudge = restartResumeMessage(looping, iso(25 * MINUTE));
    message(looping.id, "user", 40 * MINUTE, "アップデートして");
    message(looping.id, "notification", 20 * MINUTE + 50, nudge);
    message(looping.id, "notification", 2 * MINUTE, "🔄 新しいメッセージを踏まえて再検討");
    const row = enqueueQueueItem(looping.id, looping.sessionKey, nudge);
    initDb().prepare("UPDATE queue_items SET status = 'cancelled', created_at = ? WHERE id = ?").run(iso(20 * MINUTE + 50), row);

    expect(select().skipped).toEqual([{ sessionId: looping.id, reason: "recently-nudged" }]);
  });

  it("holds the daily cap whatever arrived in between", () => {
    const history = Array.from({ length: RESTART_NUDGE_WINDOW_LIMIT }, (_, i) => iso((i + 1) * 3 * 60 * MINUTE)).reverse();
    const capped = interrupted(iso(MINUTE), { transportMeta: { [RESTART_RESUME_META_KEY]: { nudgedAt: history } } });
    message(capped.id, "user", 10 * MINUTE, "a new request after the last nudge");

    expect(select().skipped).toEqual([{ sessionId: capped.id, reason: "recently-nudged" }]);
  });

  it("stops nudging a session that keeps getting interrupted within a day", () => {
    const history = Array.from({ length: RESTART_NUDGE_WINDOW_LIMIT }, (_, i) => iso((i + 1) * 3 * 60 * MINUTE)).reverse();
    const looping = interrupted(iso(MINUTE), { transportMeta: { [RESTART_RESUME_META_KEY]: { nudgedAt: history } } });

    expect(select().skipped).toEqual([{ sessionId: looping.id, reason: "recently-nudged" }]);
  });
});

describe("planRestartResumes", () => {
  const candidate = (id: string, lastActivity: string) => ({ id, lastActivity }) as Session;

  it("wakes the most recently active session first and staggers the rest", () => {
    const plan = planRestartResumes({
      candidates: [candidate("older", iso(60 * MINUTE)), candidate("newest", iso(MINUTE)), candidate("middle", iso(30 * MINUTE))],
      now: NOW,
    });

    expect(plan.resumes).toEqual([
      { sessionId: "newest", dueAt: NOW },
      { sessionId: "middle", dueAt: NOW + RESTART_RESUME_STAGGER_MS },
      { sessionId: "older", dueAt: NOW + 2 * RESTART_RESUME_STAGGER_MS },
    ]);
    expect(plan.deferred).toEqual([]);
  });

  it("caps one boot at ten wake-ups and names the overflow", () => {
    const candidates = Array.from({ length: MAX_RESTART_RESUMES + 2 }, (_, i) => candidate(`s${String(i).padStart(2, "0")}`, iso(i * 1_000)));

    const plan = planRestartResumes({ candidates, now: NOW });

    expect(plan.resumes).toHaveLength(MAX_RESTART_RESUMES);
    expect(plan.resumes.at(-1)?.dueAt).toBe(NOW + (MAX_RESTART_RESUMES - 1) * RESTART_RESUME_STAGGER_MS);
    expect(plan.deferred).toEqual(["s10", "s11"]);
  });

  it("orders deterministically when two sessions share a last activity", () => {
    const plan = planRestartResumes({ candidates: [candidate("b", iso(0)), candidate("a", iso(0))], now: NOW });
    expect(plan.resumes.map((r) => r.sessionId)).toEqual(["a", "b"]);
  });
});

describe("restartResumeMessage", () => {
  it("names the restart, demands re-verification, and forbids restarting again", () => {
    const session = interrupted(iso(MINUTE));

    const message = restartResumeMessage(session, iso(MINUTE));

    expect(message.startsWith(RESTART_NUDGE_PREFIX)).toBe(true);
    expect(message).toContain("cut off by a gateway restart");
    expect(message).toContain("re-check");
    expect(message).toContain("Do NOT trigger it again");
    expect(message).toContain(`GET /api/sessions/${session.id}?last=10`);
  });

  it("always starts from the session's latest messages", () => {
    // A message that waited in the queue can be recorded without ever reaching
    // the engine, and not every such case is detectable (see the boot test
    // below). The transcript shows it either way, so the nudge sends the
    // session there first instead of leaving that to its memory of the turn.
    const session = interrupted(iso(MINUTE));

    const message = restartResumeMessage(session, iso(MINUTE));

    expect(message).toContain(`Read this session's latest messages before acting: GET /api/sessions/${session.id}?last=10`);
    expect(message).toContain("with no reply after it");
    expect(message).not.toContain("If you have no memory of the interrupted turn, read");
  });

  it("points at a message the user sent that never reached the session", () => {
    const session = interrupted(iso(MINUTE));

    const plain = restartResumeMessage(session, iso(MINUTE));
    const withUnseen = restartResumeMessage(session, iso(MINUTE), { unseenUserMessage: true });

    expect(plain).not.toContain("never reached you");
    expect(withUnseen).toContain("never reached you");
    expect(withUnseen).toContain(`GET /api/sessions/${session.id}?last=10`);
    // Everything else the session has to know is still there.
    expect(withUnseen.startsWith(RESTART_NUDGE_PREFIX)).toBe(true);
    expect(withUnseen).toContain("Do NOT trigger it again");
  });

  it("asks for the reply to be delivered again — not for the work to be redone — when only the delivery is in doubt", () => {
    const session = interrupted(iso(MINUTE), { replyRecorded: true });

    const message = restartResumeMessage(session, iso(MINUTE), { replyUndelivered: true });

    expect(message.startsWith(RESTART_NUDGE_PREFIX)).toBe(true);
    expect(message).toContain(iso(MINUTE));
    expect(message).toContain("may never have reached the conversation");
    expect(message).toContain("there is no work to redo");
    expect(message).toContain("send it again");
    expect(message).toContain("do not post it a second time");
    expect(message).toContain(`GET /api/sessions/${session.id}?last=10`);
    expect(message).toContain("Do NOT trigger it again");
    // Not the "you were cut off mid-flight" instructions.
    expect(message).not.toContain("Pick the request back up");
    expect(message).not.toBe(restartResumeMessage(session, iso(MINUTE)));
  });

  it("differs per interruption, so the route's duplicate check never swallows a later nudge", () => {
    const session = interrupted(iso(MINUTE));
    expect(restartResumeMessage(session, iso(MINUTE))).not.toBe(restartResumeMessage(session, iso(0)));
    expect(restartResumeMessage(session, iso(MINUTE))).toBe(restartResumeMessage(session, iso(MINUTE)));
  });
});

describe("resumeRestartInterruptedSessions", () => {
  it("nudges an interrupted session exactly once", async () => {
    const session = interrupted(iso(MINUTE), { status: "idle" });

    const first = boot();
    expect(first.summary).toMatchObject({ planned: 1, deferred: 0, skipped: 0 });
    expect(first.timers.map((t) => t.delayMs)).toEqual([0]);
    await first.fire();

    expect(first.post).toHaveBeenCalledTimes(1);
    const [port, sessionId, body] = first.post.mock.calls[0];
    expect(port).toBe(0);
    expect(sessionId).toBe(session.id);
    expect(body).toEqual({
      message: restartResumeMessage(session, iso(MINUTE)),
      dedupeKey: `restart-resume:${session.id}:${iso(MINUTE)}`,
    });
    // Consumed: the pending mark is gone, the nudge is on record.
    expect(markOf(session.id)).toEqual({ nudgedAt: [new Date(NOW).toISOString()] });
    expect(getSession(session.id)?.transportMeta).toMatchObject({ channelExternal: false });

    // The next boot finds nothing left to do.
    const second = boot({ now: () => NOW + 60 * MINUTE });
    expect(second.summary).toMatchObject({ planned: 0 });
    expect(second.timers).toEqual([]);
    expect(second.post).not.toHaveBeenCalled();
  });

  it("does not nudge the same session again when it is interrupted right after a nudge", async () => {
    const session = interrupted(iso(MINUTE), { status: "idle" });
    await boot().fire();

    // The nudged turn restarts the gateway again a minute later.
    const later = NOW + 2 * MINUTE;
    updateSession(session.id, { status: "interrupted", transportMeta: withRestartInterruptedMark(getSession(session.id)!.transportMeta, new Date(later).toISOString()) });
    const again = boot({ now: () => later + MINUTE });

    expect(again.summary).toMatchObject({ planned: 0, skipped: 1 });
    expect(again.post).not.toHaveBeenCalled();
    expect(markOf(session.id).interruptedAt).toBeUndefined();
  });

  it("caps one boot at ten nudges, fifteen seconds apart, and drops the overflow's marks", async () => {
    const sessions = Array.from({ length: MAX_RESTART_RESUMES + 2 }, (_, i) => interrupted(iso(MINUTE), { lastActivity: iso((i + 1) * MINUTE) }));

    const run = boot();

    expect(run.summary).toMatchObject({ planned: MAX_RESTART_RESUMES, deferred: 2 });
    expect(run.timers.map((t) => t.delayMs)).toEqual(Array.from({ length: MAX_RESTART_RESUMES }, (_, i) => i * RESTART_RESUME_STAGGER_MS));
    await run.fire();
    expect(run.post).toHaveBeenCalledTimes(MAX_RESTART_RESUMES);
    // Least recently active are the ones left out; they do not resurface on a later boot.
    for (const dropped of sessions.slice(-2)) expect(markOf(dropped.id).interruptedAt).toBeUndefined();
    expect(run.post.mock.calls.map((call) => call[1])).not.toContain(sessions.at(-1)!.id);
  });

  it("does nothing but consume the marks when sessions.resumeInterruptedOnBoot is false", () => {
    const session = interrupted(iso(MINUTE));

    const run = boot({ config: config({ resumeInterruptedOnBoot: false }) });

    expect(run.summary).toMatchObject({ planned: 0, disabled: true });
    expect(run.timers).toEqual([]);
    expect(run.post).not.toHaveBeenCalled();
    expect(markOf(session.id).interruptedAt).toBeUndefined();
  });

  it("takes the age limit from sessions.resumeInterruptedMaxAgeMinutes", () => {
    const session = interrupted(iso(20 * MINUTE));

    expect(boot({ config: config({ resumeInterruptedMaxAgeMinutes: 10 }) }).summary).toMatchObject({ planned: 0, skipped: 1 });
    expect(markOf(session.id).interruptedAt).toBeUndefined();
  });

  it("skips a session that someone else started driving before its turn came", async () => {
    const session = interrupted(iso(MINUTE), { status: "idle" });
    const run = boot();

    // The user re-sent the request during the stagger window.
    updateSession(session.id, { status: "running" });
    await run.fire();

    expect(run.post).not.toHaveBeenCalled();
    expect(markOf(session.id)).toEqual({ nudgedAt: [] });
  });

  it("sends the delivery nudge to a session whose reply was recorded but never came back from delivery", async () => {
    const session = interrupted(iso(MINUTE), { status: "interrupted", replyRecorded: true });
    message(session.id, "user", 5 * MINUTE, "本番にデプロイして");
    message(session.id, "assistant", MINUTE + 1_000, "デプロイが完了しました。");

    const run = boot();
    expect(run.summary).toMatchObject({ planned: 1, skipped: 0 });
    await run.fire();

    expect(run.post).toHaveBeenCalledTimes(1);
    expect(run.post.mock.calls[0][2].message).toBe(restartResumeMessage(session, iso(MINUTE), { replyUndelivered: true }));
    expect(markOf(session.id)).toEqual({ nudgedAt: [new Date(NOW).toISOString()] });
  });

  it("tells the session about a message that was recorded after the interruption but never answered", async () => {
    const session = interrupted(iso(MINUTE), { status: "idle" });
    message(session.id, "user", 5 * MINUTE, "the request that was cut off");
    message(session.id, "user", 30_000, "a follow-up that was waiting in the queue");

    const run = boot();
    await run.fire();

    expect(run.post).toHaveBeenCalledTimes(1);
    expect(run.post.mock.calls[0][2].message).toBe(restartResumeMessage(session, iso(MINUTE), { unseenUserMessage: true }));
  });

  it("does not retry a refused nudge once the user has carried on by themselves", async () => {
    const session = interrupted(iso(MINUTE), { status: "idle" });
    const refused = vi.fn<NonNullable<RestartResumeDeps["post"]>>(async () => { throw new Error("gateway responded 503"); });
    await boot({ post: refused }).fire();
    expect(markOf(session.id).interruptedAt).toBe(iso(MINUTE)); // still pending

    // The user re-sends, gets an answer, and some time later the gateway restarts again.
    const later = NOW + 20 * MINUTE;
    message(session.id, "user", -5 * MINUTE, "もう一度お願いします");
    message(session.id, "assistant", -6 * MINUTE, "完了しました");
    const next = boot({ now: () => later });
    await next.fire();

    expect(next.summary).toMatchObject({ planned: 0, skipped: 1 });
    expect(next.post).not.toHaveBeenCalled();
    expect(markOf(session.id).interruptedAt).toBeUndefined();
  });

  it("keeps the mark when the gateway refuses the nudge, so the next boot can try again", async () => {
    const session = interrupted(iso(MINUTE), { status: "idle" });
    const post = vi.fn<NonNullable<RestartResumeDeps["post"]>>(async () => { throw new Error("gateway responded 503"); });

    await boot({ post }).fire();

    expect(post).toHaveBeenCalledTimes(1);
    expect(markOf(session.id)).toEqual({ interruptedAt: iso(MINUTE), nudgedAt: [] });
  });
});

describe("resumeRestartInterruptedSessions — cancel", () => {
  afterEach(() => vi.useRealTimers());

  it("stops the nudges that have not gone out yet, and leaves their marks for the next boot", async () => {
    // Three sessions, fifteen seconds apart: the gateway shuts down again after the first.
    const sessions = [1, 2, 3].map((minutesAgo) => interrupted(iso(MINUTE), { status: "idle", lastActivity: iso(minutesAgo * MINUTE) }));
    const run = boot();
    await run.timers[0].run();
    expect(run.post).toHaveBeenCalledTimes(1);

    run.summary.cancel();
    for (const timer of run.timers.slice(1)) await timer.run(); // a timer that still fires does nothing

    expect(run.post).toHaveBeenCalledTimes(1);
    expect(markOf(sessions[0].id).interruptedAt).toBeUndefined();
    expect(markOf(sessions[1].id).interruptedAt).toBe(iso(MINUTE));
    expect(markOf(sessions[2].id).interruptedAt).toBe(iso(MINUTE));
    expect(markOf(sessions[1].id).nudgedAt).toEqual([]); // not on record as nudged: nothing was sent

    // The next boot picks the two up.
    const next = boot({ now: () => NOW + 5 * MINUTE });
    expect(next.summary).toMatchObject({ planned: 2 });
    await next.fire();
    expect(next.post.mock.calls.map((call) => call[1]).sort()).toEqual([sessions[1].id, sessions[2].id].sort());
  });

  it("clears the real timers, so nothing fires into a gateway that is shutting down", async () => {
    vi.useFakeTimers();
    [1, 2, 3].forEach((minutesAgo) => interrupted(iso(MINUTE), { status: "idle", lastActivity: iso(minutesAgo * MINUTE) }));
    const post = vi.fn<NonNullable<RestartResumeDeps["post"]>>(async () => {});

    const handle = resumeRestartInterruptedSessions({ config: config(), port: 0, now: () => NOW, post });
    expect(vi.getTimerCount()).toBe(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1); // the first nudge is immediate

    handle.cancel();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not put a nudge on record when the shutdown began while it was being posted", async () => {
    // The turn that nudge starts is killed with everything else. On record as
    // sent, it would keep the session under the loop guard at the next boot.
    const session = interrupted(iso(MINUTE), { status: "idle" });
    let accept!: () => void;
    const post = vi.fn<NonNullable<RestartResumeDeps["post"]>>(() => new Promise<void>((resolve) => { accept = resolve; }));
    const run = boot({ post });
    const sending = run.timers[0].run();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    run.summary.cancel();
    accept();
    await sending;

    expect(markOf(session.id)).toEqual({ interruptedAt: iso(MINUTE), nudgedAt: [] });
  });

  it("is a no-op when there was nothing to nudge or the feature is off", () => {
    expect(() => boot().summary.cancel()).not.toThrow();
    expect(() => boot({ config: config({ resumeInterruptedOnBoot: false }) }).summary.cancel()).not.toThrow();
  });
});

describe("prepareRestartResume — a nudge that was itself cut off", () => {
  it("is not replayed by the queue, so a turn that restarts the gateway cannot loop", () => {
    const session = interrupted(iso(MINUTE), { status: "running" });
    const key = session.sessionKey;
    const nudge = enqueueQueueItem(session.id, key, restartResumeMessage(session, iso(MINUTE)));
    expect(markQueueItemRunning(nudge)).toBe(true);
    // Still pending (never started) nudges and ordinary in-flight rows are replayed as before.
    const other = slackSession({ status: "running" });
    const pendingNudge = enqueueQueueItem(other.id, other.sessionKey, restartResumeMessage(other, iso(MINUTE)));
    const jobWake = enqueueQueueItem(other.id, other.sessionKey, '✅ Detached job "pdf" completed successfully (exit 0).');
    expect(markQueueItemRunning(jobWake)).toBe(true);

    expect(prepareRestartResume(NOW).cancelledNudges).toBe(1);
    recoverStaleQueueItems();

    expect(getQueueItem(nudge)?.status).toBe("cancelled");
    expect(getQueueItem(pendingNudge)?.status).toBe("pending");
    expect(getQueueItem(jobWake)?.status).toBe("pending");
  });
});
