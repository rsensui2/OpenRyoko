import { beforeEach, describe, expect, it, vi } from "vitest";
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
function interrupted(at = iso(MINUTE), overrides: Parameters<typeof slackSession>[0] = {}): Session {
  const session = slackSession(overrides);
  updateSession(session.id, {
    status: overrides.status ?? "interrupted",
    transportMeta: withRestartInterruptedMark(session.transportMeta, at),
  });
  return getSession(session.id)!;
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

  it("keeps the mark when the gateway refuses the nudge, so the next boot can try again", async () => {
    const session = interrupted(iso(MINUTE), { status: "idle" });
    const post = vi.fn<NonNullable<RestartResumeDeps["post"]>>(async () => { throw new Error("gateway responded 503"); });

    await boot({ post }).fire();

    expect(post).toHaveBeenCalledTimes(1);
    expect(markOf(session.id)).toEqual({ interruptedAt: iso(MINUTE), nudgedAt: [] });
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
