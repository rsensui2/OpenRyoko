import { describe, it, expect } from "vitest";
import type { EngineResult } from "../types.js";
import { isDeadSessionError, detectRateLimit, isUnresumableTranscriptError } from "../rateLimit.js";

function makeResult(overrides: Partial<EngineResult> = {}): EngineResult {
  return {
    sessionId: "test-session",
    result: "",
    ...overrides,
  };
}

describe("isDeadSessionError", () => {
  it("returns true for error with zero cost and no rate limit", () => {
    const result = makeResult({
      error: "Claude exited with code 1 (no stderr output)",
      cost: 0,
      numTurns: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for error with undefined cost/turns (no work done)", () => {
    const result = makeResult({
      error: "Claude exited with code 1",
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns false when rate limit status is present", () => {
    const result = makeResult({
      error: "Claude usage limit reached",
      cost: 0,
      rateLimit: { status: "rejected" },
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when cost > 0 (work was done)", () => {
    const result = makeResult({
      error: "Some error after work",
      cost: 0.05,
      numTurns: 3,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when numTurns > 0 (work was done)", () => {
    const result = makeResult({
      error: "Some error after work",
      cost: 0,
      numTurns: 1,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns false when there is no error", () => {
    const result = makeResult({ result: "success" });
    expect(isDeadSessionError(result)).toBe(false);
  });

  // Secondary pattern matching — requires zero cost as conjunction
  it("returns true for 'error_during_execution' with zero cost", () => {
    const result = makeResult({
      error: "error_during_execution",
      cost: 0,
      numTurns: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns false for 'error_during_execution' when cost > 0 (real work done)", () => {
    const result = makeResult({
      error: "error_during_execution",
      cost: 0.05,
      numTurns: 1,
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("returns true for 'session not found' in error text", () => {
    const result = makeResult({
      error: "Session not found or expired",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for 'invalid session' in error text", () => {
    const result = makeResult({
      error: "Invalid session ID provided",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("returns true for 'session expired' in error text", () => {
    const result = makeResult({
      error: "The session has expired",
      cost: 0,
    });
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("does not false-positive on rate limit errors with no cost", () => {
    const result = makeResult({
      error: "rate limit exceeded",
      cost: 0,
      rateLimit: { status: "rejected", resetsAt: 1234567890 },
    });
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("does not interfere with detectRateLimit", () => {
    const rateLimited = makeResult({
      error: "Claude usage limit reached",
      rateLimit: { status: "rejected", resetsAt: 9999999999 },
    });
    expect(detectRateLimit(rateLimited).limited).toBe(true);
    expect(isDeadSessionError(rateLimited)).toBe(false);
  });
});

describe("isUnresumableTranscriptError", () => {
  // The exact API 400 surfaced when resuming a transcript whose latest assistant
  // turn carries thinking blocks that no longer round-trip.
  const THINKING_400 =
    "API Error: 400 messages.19.content.1: thinking or redacted_thinking blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";

  it("detects the thinking-block 400 even with a non-zero turn count", () => {
    // This is the crux: a resumed conversation reports the full prior turn count,
    // so isDeadSessionError ignores it — but the transcript is still unresumable.
    const result = makeResult({ error: THINKING_400, cost: 0, numTurns: 19 });
    expect(isUnresumableTranscriptError(result)).toBe(true);
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("detects the error when wrapped in a generic 'exited with code 1' message", () => {
    const result = makeResult({
      error: `Claude exited with code 1: ${THINKING_400}`,
      cost: 0.04,
      numTurns: 19,
    });
    expect(isUnresumableTranscriptError(result)).toBe(true);
  });

  it("detects redacted_thinking phrasing", () => {
    const result = makeResult({
      error: "400 redacted_thinking blocks in the latest assistant message cannot be modified",
    });
    expect(isUnresumableTranscriptError(result)).toBe(true);
  });

  it("returns false when there is no error", () => {
    expect(isUnresumableTranscriptError(makeResult({ result: "ok" }))).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isUnresumableTranscriptError(makeResult({ error: "Claude exited with code 1" }))).toBe(false);
    expect(isUnresumableTranscriptError(makeResult({ error: "session not found" }))).toBe(false);
  });

  it("returns false when an actual rate limit (rejected) is present", () => {
    const result = makeResult({
      error: THINKING_400,
      rateLimit: { status: "rejected" },
    });
    expect(isUnresumableTranscriptError(result)).toBe(false);
  });

  it("still detects when a non-rejected rate_limit_event is attached (CLI streams status 'allowed')", () => {
    // Regression: the Claude CLI emits a rate_limit_event with status "allowed"
    // on ordinary requests, so a blanket rateLimit?.status guard would wrongly
    // swallow the real 400 and skip the fresh-session fallback.
    const result = makeResult({
      error: THINKING_400,
      rateLimit: { status: "allowed" },
      numTurns: 19,
    });
    expect(isUnresumableTranscriptError(result)).toBe(true);
  });
});
