/**
 * Keeps a job that fails on every fire from alerting on every fire. While the
 * same failure of a job goes on, its alert is sent once and then held back for
 * a window; a different reason, a different alert destination or a success in
 * between lets the next one through at once. State lives in memory only: a
 * restart alerts again.
 */
const DEFAULT_THROTTLE_MINUTES = 60;
/** The alert shows this much of the reason, so this much decides sameness. */
const COMPARED_LENGTH = 500;

interface SentAlert { signature: string; sentAt: number }
const lastSent = new Map<string, SentAlert>();

/** `cron.alertThrottleMinutes`: 0 turns the throttle off, anything that is not
 *  a usable number means the default. */
export function alertThrottleMinutes(configured: unknown): number {
  return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
    ? configured : DEFAULT_THROTTLE_MINUTES;
}

/** One outage reports a new request id, session id or timestamp each time it
 *  fails. Those name the occurrence, not the cause, and are left out; short
 *  numbers (HTTP status, exit code) stay, because they are the cause. */
function signatureOf(reason: string, destination: string): string {
  const cause = reason.slice(0, COMPARED_LENGTH)
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g, "<id>")
    .replace(/\d{5,}/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
  return `${destination}\n${cause}`;
}

/** True while this job's same failure was already alerted to the same place within the window. */
export function isAlertThrottled(jobId: string, reason: string, destination: string, configuredMinutes: unknown, now = Date.now()): boolean {
  const last = lastSent.get(jobId);
  if (!last || last.signature !== signatureOf(reason, destination)) return false;
  return now - last.sentAt < alertThrottleMinutes(configuredMinutes) * 60_000;
}

/** Call once the alert has actually gone out: one that could not be sent must not silence the next. */
export function recordAlertSent(jobId: string, reason: string, destination: string, now = Date.now()): void {
  lastSent.set(jobId, { signature: signatureOf(reason, destination), sentAt: now });
}

/** A successful run ends the failure: the next one alerts at once. */
export function clearAlertThrottle(jobId: string): void {
  lastSent.delete(jobId);
}
