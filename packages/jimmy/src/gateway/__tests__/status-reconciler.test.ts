import { describe, it, expect, vi, beforeEach } from "vitest";

const listSessions = vi.fn();
const updateSession = vi.fn();
vi.mock("../../sessions/registry.js", () => ({
  listSessions: (...a: unknown[]) => listSessions(...a),
  updateSession: (...a: unknown[]) => updateSession(...a),
}));

import { sweepOnce, type StatusReconcilerDeps } from "../status-reconciler.js";

const NOW = Date.parse("2026-07-02T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    engine: "claude",
    status: "running",
    lastActivity: iso(120_000), // stale by default
    employee: null,
    title: "t",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<StatusReconcilerDeps> = {}): StatusReconcilerDeps & { emitted: unknown[] } {
  const emitted: unknown[] = [];
  return {
    engines: new Map(),
    emit: (event, payload) => emitted.push({ event, payload }),
    now: () => NOW,
    pendingStuck: new Set<string>(),
    emitted,
    ...overrides,
  } as StatusReconcilerDeps & { emitted: unknown[] };
}

beforeEach(() => {
  listSessions.mockReset();
  updateSession.mockReset();
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
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("resets a stuck session only on the SECOND consecutive sweep", () => {
    listSessions.mockReturnValue([makeSession()]);
    const engines = new Map<string, unknown>([
      ["claude", { isTurnRunning: () => false }],
    ]);
    const deps = makeDeps({ engines: engines as StatusReconcilerDeps["engines"] });

    expect(sweepOnce(deps)).toBe(0); // first observation — marked, not reset
    expect(updateSession).not.toHaveBeenCalled();
    expect(deps.pendingStuck!.has("s1")).toBe(true);

    expect(sweepOnce(deps)).toBe(1); // second consecutive — reset
    expect(updateSession).toHaveBeenCalledWith("s1", expect.objectContaining({ status: "idle", lastError: null }));
    expect(deps.emitted).toEqual([
      expect.objectContaining({ event: "session:completed" }),
    ]);
    expect(deps.pendingStuck!.has("s1")).toBe(false);
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
    expect(sweepOnce(deps)).toBe(1); // ghost reset on second sweep
    expect(updateSession).toHaveBeenCalledTimes(1);
    expect(updateSession).toHaveBeenCalledWith("ghost-1", expect.anything());
  });
});
