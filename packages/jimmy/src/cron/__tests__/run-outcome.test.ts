import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.js";

const { getSession, warn } = vi.hoisted(() => ({ getSession: vi.fn(), warn: vi.fn() }));

vi.mock("../../sessions/registry.js", () => ({ getSession }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() },
}));

import { sessionRunFailure, settledRunFailure } from "../run-outcome.js";

const session = (fields: Partial<Session>): Session =>
  ({ id: "session-1", status: "idle", lastError: null, ...fields }) as Session;

beforeEach(() => vi.clearAllMocks());

describe("what a settled cron session says about its run", () => {
  it.each([null, "", "   "])("is a success when the turn ended idle with no error recorded: %j", (lastError) => {
    expect(sessionRunFailure(session({ status: "idle", lastError }))).toBeNull();
  });

  // A reply that cannot be delivered may leave the engine result in place: the
  // session stays idle and only lastError says so. A clean turn resets it to
  // null, so anything recorded there is a failure — whatever it is worded as.
  it.each([
    "origin delivery failed — reply not posted to the original conversation",
    "Background turn failed: unknown",
    "any reason the gateway recorded",
  ])("is a failure when an idle session still carries an error: %s", (lastError) => {
    expect(sessionRunFailure(session({ status: "idle", lastError }))).toBe(lastError);
  });

  it("reports the session's own reason when the turn ended in error", () => {
    expect(sessionRunFailure(session({ status: "error", lastError: "Not logged in · Please run /login" })))
      .toBe("Not logged in · Please run /login");
  });

  it.each([null, "", "   "])("keeps an error status a failure when no reason was recorded: %j", (lastError) => {
    const failure = sessionRunFailure(session({ status: "error", lastError }));
    expect(failure).toBeTruthy();
    expect(failure!.trim()).not.toBe("");
  });

  // A wake-up queued behind the cron turn (child callback, detached job) starts
  // before the runner can read the row, so the status already says "running".
  it("still reads the failure a turn left behind once a queued follow-up turn has started", () => {
    expect(sessionRunFailure(session({ status: "running", lastError: "Engine response timeout" })))
      .toBe("Engine response timeout");
  });

  it("does not turn a clean run red because a queued follow-up turn has started", () => {
    expect(sessionRunFailure(session({ status: "running", lastError: null }))).toBeNull();
  });

  it.each([
    ["waiting", "claude usage limit — waiting for reset"],
    ["interrupted", "Interrupted: gateway shutting down gracefully"],
  ] as const)("never calls an unsettled %s session a success", (status, lastError) => {
    expect(sessionRunFailure(session({ status, lastError }))).toBe(lastError);
    expect(sessionRunFailure(session({ status, lastError: null }))).toContain(status);
  });

  it("has nothing to judge when the session row is gone", () => {
    expect(sessionRunFailure(undefined)).toBeNull();
  });

  // lastError is raw engine output; the run log and the alert are new places for it.
  it("does not copy a credential out of the engine's error text", () => {
    const failure = sessionRunFailure(session({ status: "error", lastError: "401 from upstream. Authorization: Bearer abc.def.ghi" }));
    expect(failure).toBe("401 from upstream. Authorization: Bearer [REDACTED]");
  });

  it("bounds an engine error that is a whole reply", () => {
    const failure = sessionRunFailure(session({ status: "error", lastError: `API Error: 529 ${"x".repeat(50_000)}` }));
    expect(failure!.startsWith("API Error: 529 ")).toBe(true);
    expect(failure!.length).toBeLessThanOrEqual(1000);
  });
});

describe("reading the settled session of a cron fire", () => {
  it("returns the failure of the session route() reported", () => {
    getSession.mockReturnValue(session({ status: "error", lastError: "engine crashed" }));
    expect(settledRunFailure("session-1", "Morning briefing")).toBe("engine crashed");
    expect(getSession).toHaveBeenCalledExactlyOnceWith("session-1");
  });

  it.each([undefined, null, ""])("has nothing to read when route() created no session: %j", (sessionId) => {
    expect(settledRunFailure(sessionId, "Morning briefing")).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("does not fail a run that otherwise worked because the registry could not be read", () => {
    getSession.mockImplementation(() => { throw new Error("database is locked"); });
    expect(settledRunFailure("session-1", "Morning briefing")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("Morning briefing");
  });
});
