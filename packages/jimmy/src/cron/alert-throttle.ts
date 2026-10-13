/**
 * Keeps a job that fails on every fire from alerting on every fire. A failure's
 * alert is sent once and then held back for a window; a reason not alerted in
 * its own window, a different alert destination or a success in between lets
 * the next one through at once. State lives in memory only: a restart alerts
 * again.
 */
const DEFAULT_THROTTLE_MINUTES = 60;
/** The alert shows this much of the reason, so this much decides sameness. */
const COMPARED_LENGTH = 500;
/** A job rarely fails in more ways than this at once; the reason alerted
 *  longest ago is forgotten first. */
const MAX_REASONS_PER_JOB = 8;

/** Job id → failure signature → when its alert last went out, oldest first. */
const sentAlerts = new Map<string, Map<string, number>>();

/** `cron.alertThrottleMinutes`: 0 turns the throttle off, anything that is not
 *  a usable number means the default. */
export function alertThrottleMinutes(configured: unknown): number {
  return typeof configured === "number" && Number.isFinite(configured) && configured >= 0
    ? configured : DEFAULT_THROTTLE_MINUTES;
}

const AMOUNT_UNITS = [
  "ms", "msecs?", "milliseconds?", "s", "secs?", "seconds?", "m", "mins?", "minutes?", "h", "hrs?", "hours?", "d", "days?",
  "times?", "attempts?", "retries", "tries", "turns?", "messages?", "requests?", "tokens?", "bytes?", "kb", "mb", "gb",
].join("|");
const AMOUNT = `\\d+(?:\\.\\d+)?\\s?(?:${AMOUNT_UNITS})`;

/**
 * What names one occurrence of a failure rather than its cause, in the order it
 * is taken out. A bare short number is deliberately not here: an HTTP status,
 * an exit code and a port are the cause. Neither is a model id, which is broken
 * up by hyphens and dots and so matches none of the id shapes below.
 */
const OCCURRENCE_DETAILS: Array<[RegExp, string]> = [
  // 2026-10-12T05:00:00.000Z
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>"],
  // 0b6f3a1e-5c2d-4e8f-9a7b-1c2d3e4f5a6b
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  // req_011CTy1VbPqk8d2nLDrYabcd, msg_01…, call_…: a short prefix, an underscore, an opaque tail
  [/\b[a-z]{2,12}_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}\b/g, "<id>"],
  // A long unbroken run of letters and digits: a hash, a trace id
  [/\b(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{16,}\b/g, "<id>"],
  // An amount with a unit, alone or in a run: "42 minutes", "9876ms", "6m0s", "1h 5m", "3 attempts"
  [new RegExp(`(?<![\\w.-])${AMOUNT}(?:\\s?${AMOUNT})*(?![A-Za-z0-9_])`, "gi"), "<n>"],
  // 97%, 98.5 %
  [/(?<![\w.-])\d+(?:\.\d+)?\s?%/g, "<n>"],
  // A position in a count: "2/5", "attempt 2 of 5", "retry 3"
  [/(?<![\w./-])\d+\/\d+(?![\w/-])/g, "<n>"],
  [/\b(attempt|retry|try)\s+#?\d+(?:\s+of\s+\d+)?\b/gi, "$1 <n>"],
  // A labelled quantity: "Limit 30000, Used 28500, Requested 850"
  [/\b(limit|used|requested|remaining|maximum|max|minimum|min|total|count)\s*[:=]?\s*\d+(?:\.\d+)?\b/gi, "$1 <n>"],
  // 05:15, 12:34:56, 3:15pm
  [/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?\b/gi, "<time>"],
  // A long number on its own (epoch, pid): not a port after "host:", not the date inside a hyphenated id
  [/(?<![\w:-])\d{5,}(?![\w-])/g, "<n>"],
];

/** One outage reports a new request id, timestamp or wait on every failure.
 *  Those are left out, so what is compared is the cause. */
function signatureOf(reason: string, destination: string): string {
  const cause = OCCURRENCE_DETAILS
    .reduce((text, [detail, placeholder]) => text.replace(detail, placeholder), reason.slice(0, COMPARED_LENGTH))
    .replace(/\s+/g, " ")
    .trim();
  return `${destination}\n${cause}`;
}

/** True while this failure of the job was already alerted to the same place within the window. */
export function isAlertThrottled(jobId: string, reason: string, destination: string, configuredMinutes: unknown, now = Date.now()): boolean {
  const sentAt = sentAlerts.get(jobId)?.get(signatureOf(reason, destination));
  return sentAt !== undefined && now - sentAt < alertThrottleMinutes(configuredMinutes) * 60_000;
}

/** Call once the alert has actually gone out: one that could not be sent must not silence the next. */
export function recordAlertSent(jobId: string, reason: string, destination: string, now = Date.now()): void {
  rememberSent(jobId, signatureOf(reason, destination), now);
}

function rememberSent(jobId: string, signature: string, now: number): void {
  const others = [...(sentAlerts.get(jobId) ?? [])].filter(([known]) => known !== signature);
  sentAlerts.set(jobId, new Map([...others.slice(-(MAX_REASONS_PER_JOB - 1)), [signature, now]]));
}

/** A usage limit that is not waited for: the engine, and the reset it stated (ISO). */
export interface AlertedLimitPeriod {
  engine: string;
  resetsAt: string;
}

/** Told apart by the period itself, never by a reason's wording: the reset is
 *  exactly the kind of detail a reason's signature leaves out. */
function limitSignature(period: AlertedLimitPeriod, destination: string): string {
  return `${destination}\nusage limit\n${period.engine}\n${period.resetsAt}`;
}

/**
 * True when the job has already alerted this place of this limit period.
 *
 * A usage limit that is not waited for fails every fire until it resets, and
 * that can be days: an hour between alerts is then twenty-four of them a day
 * for one job. So this alert is held for as long as the period lasts — until
 * the engine names another reset — rather than for a window. A success lifts
 * it like any other, and `cron.alertThrottleMinutes: 0` still means every
 * failure alerts.
 */
export function isLimitAlertThrottled(jobId: string, period: AlertedLimitPeriod, destination: string, configuredMinutes: unknown): boolean {
  if (alertThrottleMinutes(configuredMinutes) === 0) return false;
  return sentAlerts.get(jobId)?.has(limitSignature(period, destination)) === true;
}

/** The limit-period counterpart of recordAlertSent. */
export function recordLimitAlertSent(jobId: string, period: AlertedLimitPeriod, destination: string, now = Date.now()): void {
  rememberSent(jobId, limitSignature(period, destination), now);
}

/** A successful run ends the failure, whatever its reasons were: the next one alerts at once. */
export function clearAlertThrottle(jobId: string): void {
  sentAlerts.delete(jobId);
}
