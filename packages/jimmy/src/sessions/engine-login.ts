/**
 * Whether an engine that is installed can actually sign in.
 *
 * A machine can have a CLI on PATH that was never logged in — Codex beside a
 * Claude-only setup is the common case. Handing a session to it does not fail
 * loudly at the switch: it fails on the first turn, with a login prompt for an
 * answer. This module recognises that failure and remembers it, so the session
 * layer can take the switch back and stop offering the engine sessions.
 *
 * Two things it is careful about:
 *
 *  - A refusal is believed only after two in a row. Signing in also fails once
 *    for reasons that pass — several CLI processes racing to refresh one
 *    single-use token (see shared/claude-oauth-gate.ts) — and a healthy
 *    fallback must not be given up over that.
 *  - It is knowledge of this process only. Nothing is persisted: after a
 *    restart an engine has to answer a turn again before a session is started
 *    on it outright.
 */

import { classifyEngineFailureText, hasEngineFailureClass } from "../shared/engine-failure.js";
import type { EngineResult } from "../shared/types.js";

/** How long an engine that refused to sign in twice running is left out of
 *  fallback, and how close together two refusals must be to count as running. */
export const LOGIN_REFUSAL_HOLD_MS = 30 * 60_000;

/**
 * What the CLIs print when they have no usable login, where the shared
 * auth-terminal signatures do not already cover it. Taken from the installed
 * binaries' own strings (claude, codex 0.162), not from memory:
 *   claude  "Not logged in · Please run /login", "Login expired · Please run /login",
 *           "Invalid auth token · Fix external auth token",
 *           "Not logged in. Run claude auth login to authenticate."
 *   codex   "Run codex login or provide an API key …", "please re-run `codex login`",
 *           "Your access token could not be refreshed … Please log out and sign in again."
 */
const LOGIN_PROMPT_SIGNATURES: readonly RegExp[] = [
  /\brun \/login\b/i,
  /\bclaude auth login\b/i,
  /\bcodex login\b/i,
  /\bsign in again\b/i,
  /\binvalid auth token\b/i,
];

/** The interactive Claude PTY settles every failure with one synthetic turn, so
 *  its turn count says nothing about whether any work was done. */
const INTERACTIVE_FAILURE = /^Interactive turn failed: /;

/**
 * Whether an attempt ended because the engine could not sign in.
 *
 * Narrow on purpose: no answer at all, an error that speaks of signing in, none
 * of the signals of a limit, an outage or a network fault, and no work done. An
 * engine that ran turns or spent money failed some other way — whatever its
 * error says about credentials is then about something it touched, not itself.
 */
export function isLoginRefusal(result: EngineResult): boolean {
  const error = result.error;
  if (!error || result.retryable === false || result.result?.trim()) return false;
  const failure = classifyEngineFailureText(error);
  if (hasEngineFailureClass(failure, "rate-limit", "quota", "provider-outage", "network")) return false;
  if (!failure.classes.has("auth-terminal") && !LOGIN_PROMPT_SIGNATURES.some((signature) => signature.test(error))) return false;
  if ((result.cost ?? 0) > 0) return false;
  return INTERACTIVE_FAILURE.test(error) || !result.numTurns;
}

interface Refusals { running: number; lastAt: number; confirmedAt?: number }

const refusals = new Map<string, Refusals>();
const served = new Set<string>();

/** One more refusal from `engine`. The second inside the hold confirms it. */
export function noteLoginRefusal(engine: string, now: Date = new Date()): void {
  const previous = refusals.get(engine);
  const running = (previous && now.getTime() - previous.lastAt <= LOGIN_REFUSAL_HOLD_MS ? previous.running : 0) + 1;
  served.delete(engine);
  refusals.set(engine, { running, lastAt: now.getTime(), ...(running >= 2 ? { confirmedAt: now.getTime() } : {}) });
}

/** For a caller that has itself just watched the engine refuse twice. */
export function confirmLoginRefusal(engine: string, now: Date = new Date()): void {
  served.delete(engine);
  refusals.set(engine, { running: Math.max(2, refusals.get(engine)?.running ?? 0), lastAt: now.getTime(), confirmedAt: now.getTime() });
}

/** The engine answered a turn: it can sign in, whatever it said before. */
export function noteLoginWorked(engine: string): void {
  refusals.delete(engine);
  served.add(engine);
}

/** Whether `engine` is, as far as is known, unable to sign in right now. */
export function loginRefusalConfirmed(engine: string, now: Date = new Date()): boolean {
  const confirmedAt = refusals.get(engine)?.confirmedAt;
  return confirmedAt !== undefined && now.getTime() - confirmedAt < LOGIN_REFUSAL_HOLD_MS;
}

/**
 * Whether `engine` has answered a turn in this process and not refused to sign
 * in since. A switch after a failed turn can be taken back within that turn if
 * the engine turns out unable to sign in; a session that is *started* on an
 * engine cannot, so it is only started on one that has shown it works.
 */
export function hasServedATurn(engine: string): boolean {
  return served.has(engine);
}

/** Test-only: forget everything learned about engines signing in. */
export function _resetEngineLoginKnowledge(): void {
  refusals.clear();
  served.clear();
}
