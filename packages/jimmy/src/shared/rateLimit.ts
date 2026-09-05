import type { EngineResult } from "./types.js";
import { classifyEngineFailureText, hasEngineFailureClass } from "./engine-failure.js";

/** Whether error text reads as a quota window rather than a fault. Engine
 *  results are one caller; a settled attempt's stored error is the other, and
 *  both have to reach the same verdict or the same outage reads two ways.
 *
 *  Throttling and allowance are one verdict here: the caller waits either way. */
export function isRateLimitMessage(text: string | null | undefined): boolean {
  return hasEngineFailureClass(classifyEngineFailureText(text), "rate-limit", "quota");
}

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
 * Anthropic rejects a `--resume` request whose transcript contains a corrupted
 * assistant turn — most commonly when extended-thinking blocks no longer match
 * the original signed response (e.g. a long tool loop that got collapsed under a
 * single message id, or a turn that was killed mid-stream). The 400 looks like:
 *   "messages.1.content.13: thinking or redacted_thinking blocks in the latest
 *    assistant message cannot be modified. These blocks must remain as they were
 *    in the original response."
 * Unlike a rate limit or a transient failure, this error is *baked into the
 * persisted transcript*: every subsequent resume of the same engine session
 * replays the poisoned history and fails identically. The only recovery is to
 * abandon the engine session id and start a fresh one — and crucially this can
 * happen *after* real work was done, so it is NOT gated on zeroCost the way
 * isDeadSessionError is.
 */
const POISONED_TRANSCRIPT_RE =
  /(thinking|redacted_thinking)\b[\s\S]*?blocks[\s\S]*?(cannot be modified|must remain as they were)/i;

/**
 * Detect whether an engine result indicates the persisted transcript can no
 * longer be resumed (see POISONED_TRANSCRIPT_RE). Caller should clear the engine
 * session id and retry with a fresh session, identically to a dead session.
 */
export function isPoisonedTranscriptError(result: EngineResult): boolean {
  if (!result.error) return false;
  if (result.rateLimit?.status) return false;
  return POISONED_TRANSCRIPT_RE.test(result.error);
}

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
 * Transient upstream failure: the interactive engine's Stop hook reported
 * `server_error` — Anthropic returned 5xx/529 and the CLI exhausted its own
 * in-process retries (~minutes). Unlike a rate limit there is no reset time and
 * unlike a dead session the conversation history is intact, so the correct
 * recovery is to wait briefly and re-drive the SAME engine session with a
 * continuation prompt. Scoped narrowly to the interactive marker so headless
 * engine error handling is unchanged.
 */
const TRANSIENT_SERVER_ERROR_RE = /Interactive turn failed: server_error/i;

export function isTransientServerError(result: EngineResult): boolean {
  if (!result.error) return false;
  if (result.rateLimit?.status) return false;
  return TRANSIENT_SERVER_ERROR_RE.test(result.error);
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

