import { describe, it, expect } from "vitest";
import type { EngineResult } from "../types.js";
import { isDeadSessionError, detectRateLimit, isPoisonedTranscriptError, isTransientServerError } from "../rateLimit.js";

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

describe("isPoisonedTranscriptError", () => {
  // The exact 400 surfaced from Anthropic when a resumed transcript has a
  // corrupted assistant turn (collapsed thinking blocks).
  const REAL_ERROR =
    "API Error: 400 messages.1.content.13: thinking or redacted_thinking blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";

  it("returns true for the real corrupted-thinking 400", () => {
    expect(isPoisonedTranscriptError(makeResult({ error: REAL_ERROR }))).toBe(true);
  });

  it("returns true even when real work was done (non-zero cost/turns)", () => {
    // The whole point: this happens AFTER a long successful tool loop, so the
    // zeroCost gate of isDeadSessionError would miss it.
    const result = makeResult({ error: REAL_ERROR, cost: 0.42, numTurns: 40 });
    expect(isPoisonedTranscriptError(result)).toBe(true);
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("matches the redacted_thinking variant", () => {
    const result = makeResult({
      error: "400 redacted_thinking blocks ... cannot be modified",
    });
    expect(isPoisonedTranscriptError(result)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isPoisonedTranscriptError(makeResult({ error: "rate limit exceeded" }))).toBe(false);
    expect(isPoisonedTranscriptError(makeResult({ error: "Claude exited with code 1" }))).toBe(false);
    expect(isPoisonedTranscriptError(makeResult({}))).toBe(false);
  });

  it("does not treat a rate-limited result as poisoned", () => {
    const result = makeResult({
      error: REAL_ERROR,
      rateLimit: { status: "rejected", resetsAt: 9999999999 },
    });
    expect(isPoisonedTranscriptError(result)).toBe(false);
  });
});

describe("isTransientServerError", () => {
  it("matches the interactive engine's StopFailure server_error marker", () => {
    expect(isTransientServerError(makeResult({ error: "Interactive turn failed: server_error", numTurns: 1 }))).toBe(true);
  });

  it("does not match other StopFailure kinds", () => {
    expect(isTransientServerError(makeResult({ error: "Interactive turn failed: authentication_failed" }))).toBe(false);
    expect(isTransientServerError(makeResult({ error: "Interactive turn failed: rate_limit" }))).toBe(false);
    expect(isTransientServerError(makeResult({ error: "Interactive turn failed: unknown" }))).toBe(false);
  });

  it("does not match headless engine errors or success", () => {
    expect(isTransientServerError(makeResult({ error: "API Error: 529 Overloaded" }))).toBe(false);
    expect(isTransientServerError(makeResult({}))).toBe(false);
  });

  it("defers to the rate-limit machinery when rateLimit status is present", () => {
    expect(isTransientServerError(makeResult({
      error: "Interactive turn failed: server_error",
      rateLimit: { status: "rejected" },
    }))).toBe(false);
  });
});
