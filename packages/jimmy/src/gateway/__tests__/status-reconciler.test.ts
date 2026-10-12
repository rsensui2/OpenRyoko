import { describe, it, expect, vi, beforeEach } from "vitest";

const listSessions = vi.fn();
const updateSession = vi.fn();
const getMessagePage = vi.fn();
vi.mock("../../sessions/registry.js", () => ({
  listSessions: (...a: unknown[]) => listSessions(...a),
  updateSession: (...a: unknown[]) => updateSession(...a),
  getMessagePage: (...a: unknown[]) => getMessagePage(...a),
}));

const notifyParentSession = vi.fn();
vi.mock("../../sessions/callbacks.js", () => ({
  notifyParentSession: (...a: unknown[]) => notifyParentSession(...a),
}));

import { sweepOnce, type StatusReconcilerDeps } from "../status-reconciler.js";
import { LOST_TURN_ERROR } from "../../sessions/lost-turn.js";

const NOW = Date.parse("2026-07-02T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    engine: "claude",
    status: "running",
    sessionKey: "web:s1",
    lastActivity: iso(120_000), // stale by default
    employee: null,
    parentSessionId: null,
    title: "t",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<StatusReconcilerDeps> = {}): StatusReconcilerDeps & { emitted: Array<{ event: string; payload: Record<string, unknown> }> } {
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    engines: new Map(),
    emit: (event, payload) => emitted.push({ event, payload: payload as Record<string, unknown> }),
    now: () => NOW,
    pendingStuck: new Set<string>(),
    emitted,
    ...overrides,
  } as StatusReconcilerDeps & { emitted: Array<{ event: string; payload: Record<string, unknown> }> };
}

const noTurnEngines = () =>
  new Map<string, unknown>([["claude", { isTurnRunning: () => false }]]) as StatusReconcilerDeps["engines"];

beforeEach(() => {
  listSessions.mockReset();
  updateSession.mockReset();
  getMessagePage.mockReset();
  notifyParentSession.mockReset();
  // updateSession returns the row as persisted; the settle path reads it back.
  updateSession.mockImplementation((id: string, fields: Record<string, unknown>) => ({
    ...(listSessions.mock.results.at(-1)?.value as Array<Record<string, unknown>> | undefined)?.find((s) => s.id === id),
    ...fields,
  }));
  // Default transcript: the turn's prompt is the newest entry — no reply landed.
  getMessagePage.mockReturnValue({ messages: [{ id: "m1", role: "user", content: "do it", timestamp: NOW - 120_000 }], hasOlder: false });
});

describe("status-reconciler sweepOnce", () => {
  it("skips sessions with a fresh heartbeat", () => {
    listSessions.mockReturnValue([makeSession({ lastActivity: iso(10_000) })]);
    const deps = makeDeps();
    expect(sweepOnce(deps)).toBe(0);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("skips stale sessions whose engine reports a live turn", () => {
    listSessions.mockReturnValue([makeSession()]);
    const engines = new Map<string, unknown>([
      ["claude", { isTurnRunning: (id: string) => id === "s1" }],
    ]);
    const deps = makeDeps({ engines: engines as StatusReconcilerDeps["engines"] });
    expect(sweepOnce(deps)).toBe(0);
    expect(sweepOnce(deps)).toBe(0);
    expect(updateSession).not.toHaveBeenCalled();
    expect(notifyParentSession).not.toHaveBeenCalled();
  });

  it("settles a stuck session only on the SECOND consecutive sweep — with the reason, never as a success", () => {
    listSessions.mockReturnValue([makeSession()]);
    const deps = makeDeps({ engines: noTurnEngines() });

    expect(sweepOnce(deps)).toBe(0); // first observation — marked, not settled
    expect(updateSession).not.toHaveBeenCalled();
    expect(deps.pendingStuck!.has("s1")).toBe(true);

    expect(sweepOnce(deps)).toBe(1); // second consecutive — settled
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(updateSession).toHaveBeenCalledWith("s1", {
      status: "interrupted",
      lastActivity: new Date(NOW).toISOString(),
      lastError: LOST_TURN_ERROR,
    });
    expect(deps.emitted).toEqual([
      { event: "session:completed", payload: expect.objectContaining({ sessionId: "s1", result: null, error: LOST_TURN_ERROR }) },
    ]);
    expect(deps.pendingStuck!.has("s1")).toBe(false);
  });

  it("wakes the parent of a stuck child with the error", () => {
    listSessions.mockReturnValue([makeSession({ id: "child-1", parentSessionId: "parent-1", employee: "worker" })]);
    const deps = makeDeps({ engines: noTurnEngines() });

    sweepOnce(deps);
    expect(notifyParentSession).not.toHaveBeenCalled(); // not before the confirming sweep
    sweepOnce(deps);

    expect(notifyParentSession).toHaveBeenCalledTimes(1);
    const [child, result, options] = notifyParentSession.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(child).toMatchObject({ id: "child-1", parentSessionId: "parent-1", status: "interrupted", lastError: LOST_TURN_ERROR });
    expect(result).toEqual({ error: LOST_TURN_ERROR });
    expect(options).toEqual({ alwaysNotify: undefined });
  });

  it("passes the employee's alwaysNotify setting through, like the runners do", () => {
    listSessions.mockReturnValue([makeSession({ id: "child-1", parentSessionId: "parent-1", employee: "quiet" })]);
    const alwaysNotifyFor = vi.fn(() => false);
    const deps = makeDeps({ engines: noTurnEngines(), alwaysNotifyFor });

    sweepOnce(deps);
    sweepOnce(deps);

    expect(alwaysNotifyFor).toHaveBeenCalledWith(expect.objectContaining({ id: "child-1", employee: "quiet" }));
    expect(notifyParentSession).toHaveBeenCalledWith(expect.anything(), { error: LOST_TURN_ERROR }, { alwaysNotify: false });
  });

  it("never settles a session whose runner still owns its queue slot", () => {
    // No engine turn + stale heartbeat is what a live connector turn looks like
    // while it posts its reply, reviews a goal, or runs over SSH: the runner is
    // still there and writes the terminal receipt itself.
    listSessions.mockReturnValue([makeSession({ id: "live-1", sessionKey: "slack:C1:1.2", parentSessionId: "parent-1" })]);
    const isOwned = vi.fn((session: { sessionKey: string }) => session.sessionKey === "slack:C1:1.2");
    const deps = makeDeps({ engines: noTurnEngines(), isOwned: isOwned as StatusReconcilerDeps["isOwned"] });

    for (let i = 0; i < 5; i++) expect(sweepOnce(deps)).toBe(0);

    expect(isOwned).toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(notifyParentSession).not.toHaveBeenCalled();
    expect(deps.emitted).toEqual([]);
    expect(deps.pendingStuck!.size).toBe(0);
  });

  it("settles once the runner has let go of the queue slot", () => {
    listSessions.mockReturnValue([makeSession({ id: "child-1", parentSessionId: "parent-1" })]);
    let owned = true;
    const deps = makeDeps({ engines: noTurnEngines(), isOwned: () => owned });

    expect(sweepOnce(deps)).toBe(0);
    owned = false;
    expect(sweepOnce(deps)).toBe(0); // first stuck observation
    expect(sweepOnce(deps)).toBe(1); // confirmed
    expect(notifyParentSession).toHaveBeenCalledTimes(1);
  });

  it("a live turn between sweeps clears the stuck mark (turn-boundary race)", () => {
    listSessions.mockReturnValue([makeSession()]);
    let running = false;
    const engines = new Map<string, unknown>([
      ["claude", { isTurnRunning: () => running }],
    ]);
    const deps = makeDeps({ engines: engines as StatusReconcilerDeps["engines"] });

    expect(sweepOnce(deps)).toBe(0); // marked
    running = true;
    expect(sweepOnce(deps)).toBe(0); // live turn — mark cleared
    expect(deps.pendingStuck!.has("s1")).toBe(false);
    running = false;
    expect(sweepOnce(deps)).toBe(0); // needs two consecutive observations again
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("a mark does not outlive a sweep in which the session was not running", () => {
    // Marked at a turn boundary, then the turn settles normally (the session
    // leaves the running list). A later turn of the same session must again
    // be seen stuck twice in a row before it is settled.
    const deps = makeDeps({ engines: noTurnEngines() });

    listSessions.mockReturnValue([makeSession()]);
    expect(sweepOnce(deps)).toBe(0); // marked
    listSessions.mockReturnValue([]);
    expect(sweepOnce(deps)).toBe(0); // settled on its own — no longer running
    expect(deps.pendingStuck!.has("s1")).toBe(false);

    listSessions.mockReturnValue([makeSession()]);
    expect(sweepOnce(deps)).toBe(0); // first observation of the NEW turn
    expect(updateSession).not.toHaveBeenCalled();
    expect(notifyParentSession).not.toHaveBeenCalled();
  });

  it("does not report a turn whose reply already landed (delivered by the orphan-Stop path)", () => {
    // handleOrphanHook records the late reply and wakes the parent itself, but
    // leaves a still-"running" status alone. Only the phantom status is left
    // to clear — reporting it again would notify the parent twice.
    listSessions.mockReturnValue([makeSession({ id: "child-1", parentSessionId: "parent-1" })]);
    getMessagePage.mockReturnValue({ messages: [{ id: "m2", role: "assistant", content: "done", timestamp: NOW - 50_000 }], hasOlder: false });
    const deps = makeDeps({ engines: noTurnEngines() });

    sweepOnce(deps);
    expect(sweepOnce(deps)).toBe(1);

    expect(getMessagePage).toHaveBeenCalledWith("child-1", { limit: 1 });
    expect(updateSession).toHaveBeenCalledWith("child-1", expect.objectContaining({ status: "idle", lastError: null }));
    expect(notifyParentSession).not.toHaveBeenCalled();
    expect(deps.emitted).toEqual([
      { event: "session:completed", payload: expect.objectContaining({ sessionId: "child-1", error: null }) },
    ]);
  });

  it("keeps the plain idle reset for workflow attempt sessions (the workflow runtime owns their receipts)", () => {
    listSessions.mockReturnValue([makeSession({
      id: "wf-1",
      workflowProvenance: { kind: "phase", workflowId: "w", runId: "r", phase: { nodeId: "n", attempt: 1 } },
    })]);
    const deps = makeDeps({ engines: noTurnEngines() });

    sweepOnce(deps);
    expect(sweepOnce(deps)).toBe(1);

    expect(updateSession).toHaveBeenCalledWith("wf-1", expect.objectContaining({ status: "idle", lastError: null }));
    expect(notifyParentSession).not.toHaveBeenCalled();
    expect(getMessagePage).not.toHaveBeenCalled();
  });

  it("falls back to isAlive for headless engines and treats unknown engines as no-turn", () => {
    listSessions.mockReturnValue([
      makeSession({ id: "codex-1", engine: "codex" }),
      makeSession({ id: "ghost-1", engine: "ghost" }),
    ]);
    const engines = new Map<string, unknown>([
      ["codex", { isAlive: () => true }], // live headless process — skip
    ]);
    const deps = makeDeps({ engines: engines as StatusReconcilerDeps["engines"] });
    expect(sweepOnce(deps)).toBe(0); // codex skipped; ghost marked (first sweep)
    expect(deps.pendingStuck!.has("ghost-1")).toBe(true);
    expect(sweepOnce(deps)).toBe(1); // ghost settled on second sweep
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(updateSession).toHaveBeenCalledWith("ghost-1", expect.anything());
  });
});
