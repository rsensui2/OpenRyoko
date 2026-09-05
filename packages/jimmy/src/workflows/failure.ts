import type { WorkflowError } from "./runtime.js";
import type { WorkflowAttemptInterruptionCause } from "../shared/types.js";
import { classifyEngineFailureText, hasEngineFailureClass, type EngineFailureClass } from "../shared/engine-failure.js";

/**
 * How a workflow decides whether a failed attempt is worth re-dispatching.
 *
 * The boundary is "did the work happen and fail" versus "did the attempt never
 * land". An attempt that never landed costs nothing to repeat — the retry is the
 * SAME request, not a second one. An employee that ran and reported failure is a
 * verdict: re-dispatching it pays twice for a decision already made and can
 * override a phase that deliberately refused to proceed.
 *
 * Most of that is decided STRUCTURALLY, by which path the failure arrived on —
 * a `startAttempt` throw or a gateway restart is an undelivered attempt whatever
 * its message says, and a submitted failure is a verdict whatever its message
 * says. The signatures below are only for the one path with no structure to read:
 * an engine reporting that its turn failed, where the provider's reason exists
 * solely as prose.
 *
 * There the vocabulary is closed and anything unrecognised is terminal. Guessing
 * generously spends real money on real failures, so the default is deny.
 */

/**
 * Whether an engine diagnostic describes an upstream/transport fault.
 *
 * Read off the shared taxonomy: the two classes that mean the request never got
 * a real answer. Deliberately NOT retried are the classes that name a decision —
 * `rate-limit`/`quota` (the session manager owns rate-limit waiting, so a
 * workflow retry on top of it is pure quota burn), `auth-terminal`, and
 * `terminal` (a retry cannot fix a credential, a quota, or a malformed request).
 * A provider can be both overloaded and throttling; that text is retried here,
 * exactly as it was before the classes were named.
 */
export function isTransportFailure(message: string): boolean {
  return hasEngineFailureClass(classifyEngineFailureText(message), "provider-outage", "network");
}

/**
 * Whether an engine diagnostic names a fault in OUR configuration rather than a
 * verdict on the work.
 *
 * An engine that refuses a model id never ran the turn, so there is no decision to
 * honour and nothing was paid for — and the id it refused came from config or from
 * discovery, both of which an operator can fix without the run dying on top of work
 * already committed. The retry is not the same request either: `resolveSubstituteModel`
 * drops a pin it cannot vouch for, so the next attempt goes out on the substitute's
 * own default rather than repeating the argv that was just refused.
 */
export function isConfigFaultFailure(message: string): boolean {
  return hasEngineFailureClass(classifyEngineFailureText(message), "invalid-model");
}

/**
 * Why another engine could serve the turn this one refused, phrased for the run
 * detail — or `undefined` when swapping engines would change nothing.
 *
 * These are the classes that describe the PROVIDER rather than the work: an
 * allowance, a throttle, a fault, a socket. `auth-terminal` and `terminal` are
 * absent on purpose — a missing credential and an unrecognised verdict follow
 * the request wherever it is sent.
 */
const AVAILABILITY_REASONS: readonly (readonly [EngineFailureClass, string])[] = [
  ["quota", "out of quota"],
  ["rate-limit", "rate-limited"],
  ["provider-outage", "unavailable"],
  ["network", "unreachable"],
];

export function availabilityReason(message: string): string | undefined {
  const { classes } = classifyEngineFailureText(message);
  return AVAILABILITY_REASONS.find(([failureClass]) => classes.has(failureClass))?.[1];
}

/**
 * Wrap a failure whose only account of itself is its message: an engine turn that
 * reported an error, or a run-level fault (an unavailable employee, control flow
 * that did not settle). Retryable when the message names a transport fault or a
 * model id we got wrong; anything else is read as a verdict.
 */
export function workflowError(error: unknown, nodeId: string, attempt?: number): WorkflowError {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    code: "workflow-step-failed",
    message: value.message,
    retryable: isTransportFailure(value.message) || isConfigFaultFailure(value.message),
    nodeId,
    ...(attempt ? { attempt } : {}),
  };
}

/**
 * A dispatch that threw before the attempt reached a session. Nothing ran, so
 * this is the undelivered-attempt case by construction — no message-matching,
 * because the diagnostic belongs to whatever failed to spawn, not to a provider.
 */
export function dispatchFailure(error: unknown, nodeId: string, attempt: number): WorkflowError {
  const value = error instanceof Error ? error : new Error(String(error));
  return { code: "workflow-dispatch-failed", message: value.message, retryable: true, nodeId, attempt };
}

export const RESTART_INTERRUPTED = "workflow-attempt-restart-interrupted";

/**
 * An attempt killed under the runtime. The turn was interrupted rather than
 * judged, so like a timeout or a missing output block there is no verdict to
 * honour and the phase re-runs.
 *
 * The cause decides what kind of interruption it was. A gateway restart is not a
 * fault of the work at all — the process the attempt lived in went away — so its
 * replacement is dispatched at once rather than parked on the node's backoff,
 * and the count of these on a node is what bounds a restart loop. An operator
 * stopping the attempt is the opposite: a decision ABOUT this attempt, which
 * like a submitted failure earns no retry. Only an unexplained interruption
 * keeps the old benefit of the doubt.
 */
export function interruptedAttemptFailure(message: string, nodeId: string, attempt: number,
  cause?: WorkflowAttemptInterruptionCause): WorkflowError {
  return { code: cause === "gateway-restart" ? RESTART_INTERRUPTED : "workflow-attempt-interrupted",
    message, retryable: cause !== "attempt-stop", nodeId, attempt };
}
