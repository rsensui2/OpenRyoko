import { describe, it, expect } from "vitest";
import { computeEngineOverrideRevert } from "../manager.js";
import type { Session } from "../../shared/types.js";

// Regression: the Claude rate-limit fallback used to carry the Claude session's
// model id (e.g. "sonnet" / "claude-opus-5") onto Codex, which exits 1 on it.
// The fix clears session.model while the override is active and stashes it in
// engineOverride.originalModel; the revert restores it. These tests pin the
// revert half (the pure function); the fallback half is a config-value read.

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: "s1",
    engine: "codex",
    engineSessionId: "codex-thread-1",
    source: "slack",
    sourceRef: "C1",
    connector: "slack",
    sessionKey: "slack:C1",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: null,
    title: null,
    parentSessionId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: "2026-07-25T00:00:00.000Z",
    lastActivity: "2026-07-25T00:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

const PAST = "2026-07-25T00:00:00.000Z";
const NOW = new Date("2026-07-25T12:00:00.000Z").getTime();

describe("computeEngineOverrideRevert", () => {
  it("restores the stashed Claude model when the override expires", () => {
    const session = makeSession({
      transportMeta: {
        engineOverride: {
          originalEngine: "claude",
          originalEngineSessionId: "claude-sess-1",
          originalModel: "sonnet",
          until: PAST,
          syncSince: PAST,
        },
      },
    });
    const updates = computeEngineOverrideRevert(session, NOW);
    expect(updates).not.toBeNull();
    expect(updates!.engine).toBe("claude");
    expect(updates!.engineSessionId).toBe("claude-sess-1");
    expect(updates!.model).toBe("sonnet");
    expect((updates!.transportMeta as Record<string, unknown>).engineOverride).toBeUndefined();
  });

  it("restores model to null when the session had no model override before the fallback", () => {
    const session = makeSession({
      transportMeta: {
        engineOverride: {
          originalEngine: "claude",
          originalEngineSessionId: null,
          originalModel: null,
          until: PAST,
          syncSince: null,
        },
      },
    });
    const updates = computeEngineOverrideRevert(session, NOW);
    expect(updates).not.toBeNull();
    // model must be present and null — clears the (already null) fallback value
    expect("model" in updates!).toBe(true);
    expect(updates!.model).toBeNull();
  });

  it("leaves session.model untouched for legacy overrides without originalModel", () => {
    const session = makeSession({
      model: "gpt-5.6-sol", // whatever the row holds — a legacy revert must not decide
      transportMeta: {
        engineOverride: {
          originalEngine: "claude",
          originalEngineSessionId: "claude-sess-1",
          until: PAST,
          syncSince: null,
        },
      },
    });
    const updates = computeEngineOverrideRevert(session, NOW);
    expect(updates).not.toBeNull();
    expect("model" in updates!).toBe(false);
  });

  it("does not revert before the override deadline", () => {
    const session = makeSession({
      transportMeta: {
        engineOverride: {
          originalEngine: "claude",
          originalEngineSessionId: "claude-sess-1",
          originalModel: "sonnet",
          until: "2026-07-26T10:00:00.000Z",
          syncSince: null,
        },
      },
    });
    expect(computeEngineOverrideRevert(session, NOW)).toBeNull();
  });

  it("returns null when there is no override", () => {
    expect(computeEngineOverrideRevert(makeSession({}), NOW)).toBeNull();
  });
});
