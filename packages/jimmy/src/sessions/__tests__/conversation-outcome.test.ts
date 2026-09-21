import { describe, expect, it } from "vitest";
import type { SessionGoal } from "../../shared/types.js";
import { conversationOutcome } from "../conversation-outcome.js";

function goal(status: SessionGoal["status"], updatedAt = "2026-09-21T00:01:00.000Z"): SessionGoal {
  return { id: "task-1", condition: "Deliver the change", request: "Implement this", status, updatedAt,
    waitingFor: status === "waiting" || status === "blocked" ? "user" : undefined };
}
function input(status: SessionGoal["status"]) {
  return {
    engine: "codex", beforeGoal: goal("active", "2026-09-21T00:00:00.000Z"),
    session: { source: "slack", goal: goal(status) }, result: {}, deliveredReply: true,
  };
}

describe("conversationOutcome", () => {
  it.each(["waiting", "blocked"] as const)("maps fresh %s assessment to awaiting input", (status) => {
    expect(conversationOutcome(input(status))).toBe("awaiting_input");
  });
  it.each([undefined, "background", "external", "unknown"] as const)("does not treat %s dependencies as a user input wait", (waitingFor) => {
    for (const status of ["waiting", "blocked"] as const) {
      const value = input(status);
      value.session.goal.waitingFor = waitingFor;
      expect(conversationOutcome(value)).toBeUndefined();
    }
  });
  it.each(["complete", "cancelled"] as const)("maps fresh %s assessment to completed conversation", (status) => {
    expect(conversationOutcome(input(status))).toBe("completed");
  });
  it.each(["active", "incomplete"] as const)("does not infer an outcome from %s", (status) => {
    expect(conversationOutcome(input(status))).toBeUndefined();
  });
  it.each(["waiting", "blocked", "complete", "cancelled"] as const)("ignores stale %s goal retained by an untracked turn", (status) => {
    const value = input(status);
    expect(conversationOutcome({ ...value, beforeGoal: value.session.goal })).toBeUndefined();
  });
  it("allows a newly assessed goal even when its state matches the prior turn", () => {
    const value = input("waiting");
    expect(conversationOutcome({ ...value, beforeGoal: goal("waiting", "2026-09-21T00:00:00.000Z") })).toBe("awaiting_input");
  });
  it("ignores error and interruption, including an externally cancelled run", () => {
    expect(conversationOutcome({ ...input("waiting"), result: { error: "network error" } })).toBeUndefined();
    expect(conversationOutcome({ ...input("waiting"), result: { error: "Interrupted: stopped" } })).toBeUndefined();
    expect(conversationOutcome({ ...input("waiting"), interrupted: true })).toBeUndefined();
  });
  it("requires a successfully delivered public text reply", () => {
    expect(conversationOutcome({ ...input("waiting"), deliveredReply: false })).toBeUndefined();
  });
  it("does not infer native Claude or fallback-engine goal state", () => {
    expect(conversationOutcome({ ...input("waiting"), engine: "claude" })).toBeUndefined();
    expect(conversationOutcome({ ...input("waiting"), engine: "gemini" })).toBeUndefined();
  });
  it("does not use a reset, goalless, or cron session", () => {
    expect(conversationOutcome({ ...input("waiting"), session: null })).toBeUndefined();
    expect(conversationOutcome({ ...input("waiting"), session: { source: "slack", goal: null } })).toBeUndefined();
    expect(conversationOutcome({ ...input("waiting"), session: { source: "cron", goal: goal("waiting") } })).toBeUndefined();
  });
});
