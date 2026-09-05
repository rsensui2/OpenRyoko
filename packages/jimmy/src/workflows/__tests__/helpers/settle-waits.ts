import { expect, vi } from "vitest";
import type { SessionManager } from "../../../sessions/manager.js";
import { getSession } from "../../../sessions/registry.js";

/**
 * Every wait here is on an observed state change, never on elapsed time — but how long reaching
 * that state takes is bounded by scheduling, not by wall clock: the service subscribes an async
 * completion listener the publisher never awaits, and workflow dispatch hops through
 * `setImmediate` plus a serial session queue. vitest's implicit 1 s `vi.waitFor` ceiling is
 * therefore a bet on an idle machine, and with several vitest runs contending for the same cores
 * that bet loses. This ceiling only decides how long a starved machine is allowed to take; it is
 * not a timing assumption. A state observed never to arrive inside it is a settle-ordering bug in
 * the runner, not a ceiling to raise.
 */
const SETTLE_CEILING_MS = 10_000;

/** Importers pin their test timeout to this: a bare `vitest run` gives 5 s, under the ceiling. */
export const SETTLE_TEST_TIMEOUT_MS = 30_000;

export function waitForSettle<T>(condition: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(condition, { timeout: SETTLE_CEILING_MS, interval: 10 });
}

/**
 * A late engine result on an already-terminal attempt writes nothing durable — which is what the
 * cancellation tests assert, and why sequencing them on `setImmediate` ticks left the assertion
 * resting on a guessed number of event-loop turns. The session's queue slot is released only once
 * the whole turn task has run, so this is the observable that says the late turn really did land
 * and really did change nothing.
 */
export function waitForTurnDrained(manager: SessionManager, sessionId: string): Promise<void> {
  const sessionKey = getSession(sessionId)!.sessionKey;
  return waitForSettle(() => { expect(manager.getQueue().isRunning(sessionKey)).toBe(false); });
}
