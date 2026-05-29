import type { EngineResult } from "./types.js";

const RATE_LIMIT_ERROR_RE =
  /rate.?limit|too many requests|429|overloaded|usage.*limit|exceeded.*limit|out of extra usage/i;

export interface RateLimitDetection {
  limited: boolean;
  /** Unix timestamp in seconds */
  resetsAt?: number;
}

/** Patterns that indicate the engine session is dead (expired, not found, etc.) */
const DEAD_SESSION_PATTERNS = [
  /error.during.execution/i,
  /session.not.found/i,
  /invalid.session/i,
  /session.*expired/i,
];

/**
 * Patterns indicating the persisted transcript can no longer be replayed via
 * `--resume`, independent of how much work the original session did. The most
 * common case is an API 400 when the latest assistant turn contains
 * thinking/redacted_thinking blocks that no longer round-trip (e.g. the model
 * or thinking config changed between turns). Unlike a dead session, these come
 * back WITH a non-zero turn count (the resumed conversation length), so they
 * must be matched by message text rather than the zero-work heuristic.
 */
const UNRESUMABLE_TRANSCRIPT_PATTERNS = [
  /(thinking|redacted_thinking)[\s\S]{0,80}blocks?[\s\S]{0,80}(cannot be modified|must remain)/i,
  /blocks in the latest assistant message cannot be modified/i,
];

/**
 * Detect whether an engine result indicates a dead/expired session rather than
 * a transient or rate-limit error. A dead session is one where the engine exited
 * with an error but did zero work (no cost, no turns) and there is no rate-limit
 * signal — meaning the --resume ID is stale and should not be retried.
 */
export function isDeadSessionError(result: EngineResult): boolean {
  if (!result.error) return false;

  // If rate limit info is present, this is a rate limit, not a dead session
  if (result.rateLimit?.status) return false;

  const zeroCost = result.cost === undefined || result.cost === 0;
  const zeroTurns = result.numTurns === undefined || result.numTurns === 0;

  // Primary: error with zero work done and no rate limit
  if (zeroCost && zeroTurns) return true;

  // Secondary: known dead-session patterns in error text, but only when no real
  // work was done (zeroCost) — avoids wiping IDs after a real session that
  // happened to include a matching substring in its error message.
  if (zeroCost && DEAD_SESSION_PATTERNS.some((p) => p.test(result.error!))) return true;

  return false;
}

/**
 * Detect whether the engine failed specifically because the persisted transcript
 * can no longer be resumed (e.g. thinking/redacted_thinking blocks in the latest
 * assistant message cannot be modified). The remedy is identical to a dead
 * session — drop the stale `--resume` ID and start fresh — but unlike
 * {@link isDeadSessionError} this is NOT gated on zero cost/turns, because a
 * resumed conversation reports the full prior turn count even when it fails
 * before doing any new work.
 */
export function isUnresumableTranscriptError(result: EngineResult): boolean {
  if (!result.error) return false;
  // An actual rate limit is a transient capacity signal, not a poisoned
  // transcript. Match detectRateLimit's definition (status "rejected") — the CLI
  // streams a rate_limit_event with status "allowed" on ordinary requests too,
  // so a broader `result.rateLimit?.status` check would swallow real failures.
  if (result.rateLimit?.status === "rejected") return false;
  return UNRESUMABLE_TRANSCRIPT_PATTERNS.some((p) => p.test(result.error!));
}

export function detectRateLimit(result: EngineResult): RateLimitDetection {
  const resetsAt = typeof result.rateLimit?.resetsAt === "number"
    ? result.rateLimit.resetsAt
    : undefined;

  if (result.rateLimit?.status === "rejected") {
    return { limited: true, resetsAt };
  }

  if (result.error && RATE_LIMIT_ERROR_RE.test(result.error)) {
    return { limited: true, resetsAt };
  }

  return { limited: false };
}

export function computeRateLimitDeadlineMs(resetsAtSeconds?: number, extraMs = 30 * 60_000): number {
  if (typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)) {
    return resetsAtSeconds * 1000 + extraMs;
  }
  return Date.now() + extraMs;
}

export function computeNextRetryDelayMs(resetsAtSeconds?: number): { delayMs: number; resumeAt?: Date } {
  if (typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)) {
    const resumeAt = new Date(resetsAtSeconds * 1000);
    // Add a small buffer to avoid retrying a few ms before the reset boundary.
    const bufferMs = 10_000;
    const delayMs = Math.max(10_000, resumeAt.getTime() - Date.now() + bufferMs);
    return { delayMs, resumeAt };
  }
  return { delayMs: 60_000 };
}

