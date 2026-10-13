import { describe, expect, it } from "vitest";
import { alertThrottleMinutes, clearAlertThrottle, isAlertThrottled, isLimitAlertThrottled, recordAlertSent, recordLimitAlertSent } from "../alert-throttle.js";

const MINUTE = 60_000;
const ops = "slack:C-alerts";
let sequence = 0;
/** State is kept per job for the life of the process, so every test uses its own job. */
const jobId = () => `throttle-${++sequence}`;

describe("cron failure alert throttle", () => {
  it("lets a job's first failure through", () => {
    expect(isAlertThrottled(jobId(), "Not logged in", ops, undefined, 0)).toBe(false);
  });

  it("holds back the same failure for an hour after its alert went out, then lets it through again", () => {
    const job = jobId();
    recordAlertSent(job, "Not logged in", ops, 0);
    expect(isAlertThrottled(job, "Not logged in", ops, undefined, 15 * MINUTE)).toBe(true);
    expect(isAlertThrottled(job, "Not logged in", ops, undefined, 59 * MINUTE)).toBe(true);
    expect(isAlertThrottled(job, "Not logged in", ops, undefined, 60 * MINUTE)).toBe(false);
  });

  it("counts the window from the last alert that was sent, not from the first failure", () => {
    const job = jobId();
    recordAlertSent(job, "Not logged in", ops, 0);
    recordAlertSent(job, "Not logged in", ops, 60 * MINUTE);
    expect(isAlertThrottled(job, "Not logged in", ops, undefined, 75 * MINUTE)).toBe(true);
    expect(isAlertThrottled(job, "Not logged in", ops, undefined, 120 * MINUTE)).toBe(false);
  });

  it("lets a different reason through at once", () => {
    const job = jobId();
    recordAlertSent(job, "API Error: 529 Overloaded", ops, 0);
    expect(isAlertThrottled(job, "API Error: 401 OAuth token has expired", ops, undefined, MINUTE)).toBe(false);
  });

  it("is lifted by a success", () => {
    const job = jobId();
    recordAlertSent(job, "Not logged in", ops, 0);
    clearAlertThrottle(job);
    expect(isAlertThrottled(job, "Not logged in", ops, undefined, MINUTE)).toBe(false);
  });

  it("keeps each job's failures apart", () => {
    const [first, second] = [jobId(), jobId()];
    recordAlertSent(first, "Not logged in", ops, 0);
    expect(isAlertThrottled(second, "Not logged in", ops, undefined, MINUTE)).toBe(false);
  });

  it("does not hold back an alert that now goes somewhere else", () => {
    const job = jobId();
    recordAlertSent(job, "Not logged in", ops, 0);
    expect(isAlertThrottled(job, "Not logged in", "slack:C-new-alerts", undefined, MINUTE)).toBe(false);
  });

  // The same outage reports a new request id, session id or timestamp on every
  // failure. Those name the occurrence, not the cause.
  it.each([
    ['API Error: 500 {"type":"api_error","message":"Internal server error"},"request_id":"req_011CTy1VbPqk8d2nLDrYabcd"',
      'API Error: 500 {"type":"api_error","message":"Internal server error"},"request_id":"req_011CTz9QwErTy7u8IoPaSdFg"'],
    ["stream error, request id: 0b6f3a1e-5c2d-4e8f-9a7b-1c2d3e4f5a6b", "stream error, request id: 7d1e2f3a-9b8c-4d7e-8f6a-5b4c3d2e1f0a"],
    ["claude usage limit — resumes 2026-10-12T05:00:00.000Z", "claude usage limit — resumes 2026-10-12T05:15:30.250Z"],
    ["Engine response timeout after 300123ms", "Engine response timeout after 300987ms"],
    ["trace 9f86d081884c7d659a2feaa0c55ad015 failed", "trace 2c26b46b68ffc68ff99b453c1d304134 failed"],
    ["Claude AI usage limit reached|1760245200", "Claude AI usage limit reached|1760248800"],
  ])("treats one cause reported with different ids or times as the same failure", (first, second) => {
    const job = jobId();
    recordAlertSent(job, first, ops, 0);
    expect(isAlertThrottled(job, second, ops, undefined, MINUTE)).toBe(true);
  });

  // A wait that counts down, a duration, a retry count: an amount with a unit
  // moves from one failure to the next without the cause changing.
  it.each([
    ["Rate limited. Try again in 42 minutes", "Rate limited. Try again in 27 minutes"],
    ["Engine response timeout after 9876ms", "Engine response timeout after 4321ms"],
    ["You may retry this request in 30 seconds", "You may retry this request in 5 seconds"],
    ["Usage limit reached. Try again in 2 hours", "Usage limit reached. Try again in 55 minutes"],
    ["stalled for 1.5s", "stalled for 12s"],
    ["gave up after 3 attempts", "gave up after 5 attempts"],
    ["Usage limit reached, resets at 05:00", "Usage limit reached, resets at 05:15"],
    ["Rate limit reached for requests. Please try again in 6m0s.", "Rate limit reached for requests. Please try again in 7m12s."],
    ["Please try again in 1h 5m", "Please try again in 48m"],
    ["You have used 97% of your weekly limit", "You have used 98.5% of your weekly limit"],
    ["stream disconnected, retrying 2/5 failed", "stream disconnected, retrying 3/5 failed"],
    ["attempt 2 of 5 failed: socket hang up", "attempt 4 of 5 failed: socket hang up"],
    ["retry 2 failed: socket hang up", "retry 3 failed: socket hang up"],
    ["5-hour limit reached, resets 3:15pm", "5-hour limit reached, resets 3:45pm"],
    ["Rate limit reached for gpt-5.6-sol in organization org-abc123XYZ456def789 on tokens per min (TPM): Limit 30000, Used 28500, Requested 2000. Please try again in 1s.",
      "Rate limit reached for gpt-5.6-sol in organization org-abc123XYZ456def789 on tokens per min (TPM): Limit 30000, Used 29150, Requested 850. Please try again in 2.4s."],
  ])("treats one cause reported with a different wait, duration or count as the same failure", (first, second) => {
    const job = jobId();
    recordAlertSent(job, first, ops, 0);
    expect(isAlertThrottled(job, second, ops, undefined, MINUTE)).toBe(true);
  });

  it.each([
    ["API Error: 529 Overloaded", "API Error: 401 Unauthorized"],
    ["API Error: 500 server_error", "API Error: 503 server_error"],
    ["Command exited 2", "Command exited 7"],
    ["Claude exited with code 1: boom", "Claude exited with code 137: boom"],
    ["connect ECONNREFUSED 127.0.0.1:5432", "connect ECONNREFUSED 127.0.0.1:6379"],
    ["connect ECONNREFUSED 127.0.0.1:17777", "connect ECONNREFUSED 127.0.0.1:18888"],
    ["Update notification 2026.10.9 completed without a verified chat delivery", "Update notification 2026.10.10 completed without a verified chat delivery"],
    ['Engine "gemini" named by the job is not available', 'Engine "codex" named by the job is not available'],
  ])("still tells causes apart when only a short code or a name differs", (first, second) => {
    const job = jobId();
    recordAlertSent(job, first, ops, 0);
    expect(isAlertThrottled(job, second, ops, undefined, MINUTE)).toBe(false);
  });

  // A model id is long and full of digits, but it is the cause, not an occurrence.
  it.each([
    ["model: claude-opus-4-20250514 not found", "model: claude-sonnet-4-5-20250929 not found"],
    ["model: claude-3-5-haiku-20241022 not found", "model: claude-3-5-sonnet-20241022 not found"],
    ["model: claude-opus-4-20250514 not found", "model: claude-opus-4-20260101 not found"],
    ["The model `gpt-5.6-sol` does not exist", "The model `gpt-5.6-terra` does not exist"],
  ])("tells one model's failure from another's", (first, second) => {
    const job = jobId();
    recordAlertSent(job, first, ops, 0);
    expect(isAlertThrottled(job, second, ops, undefined, MINUTE)).toBe(false);
  });

  it("holds back each of several reasons a job alternates between", () => {
    const job = jobId();
    recordAlertSent(job, "Not logged in", ops, 0);
    expect(isAlertThrottled(job, "Engine crashed", ops, undefined, 15 * MINUTE)).toBe(false);
    recordAlertSent(job, "Engine crashed", ops, 15 * MINUTE);
    expect(isAlertThrottled(job, "Not logged in", ops, undefined, 30 * MINUTE)).toBe(true);
    expect(isAlertThrottled(job, "Engine crashed", ops, undefined, 45 * MINUTE)).toBe(true);
    // Each reason keeps its own window.
    expect(isAlertThrottled(job, "Not logged in", ops, undefined, 60 * MINUTE)).toBe(false);
    expect(isAlertThrottled(job, "Engine crashed", ops, undefined, 60 * MINUTE)).toBe(true);
  });

  it("is lifted for every remembered reason by a success", () => {
    const job = jobId();
    recordAlertSent(job, "Not logged in", ops, 0);
    recordAlertSent(job, "Engine crashed", ops, 0);
    clearAlertThrottle(job);
    expect(isAlertThrottled(job, "Not logged in", ops, undefined, MINUTE)).toBe(false);
    expect(isAlertThrottled(job, "Engine crashed", ops, undefined, MINUTE)).toBe(false);
  });

  it("remembers a bounded number of reasons per job and forgets the one alerted longest ago", () => {
    const job = jobId();
    const reasons = Array.from({ length: 9 }, (_, index) => `failure mode ${String.fromCharCode(65 + index)}`);
    reasons.forEach((reason, index) => recordAlertSent(job, reason, ops, index * MINUTE));
    expect(isAlertThrottled(job, reasons[0]!, ops, undefined, 10 * MINUTE)).toBe(false);
    for (const reason of reasons.slice(1)) expect(isAlertThrottled(job, reason, ops, undefined, 10 * MINUTE)).toBe(true);
    // Alerting a remembered reason again makes it the most recent, not a new entry.
    recordAlertSent(job, reasons[1]!, ops, 11 * MINUTE);
    recordAlertSent(job, "failure mode J", ops, 12 * MINUTE);
    expect(isAlertThrottled(job, reasons[1]!, ops, undefined, 13 * MINUTE)).toBe(true);
    expect(isAlertThrottled(job, reasons[2]!, ops, undefined, 13 * MINUTE)).toBe(false);
  });

  it("uses the configured window, and never holds anything back when it is 0", () => {
    const job = jobId();
    recordAlertSent(job, "Not logged in", ops, 0);
    expect(isAlertThrottled(job, "Not logged in", ops, 10, 9 * MINUTE)).toBe(true);
    expect(isAlertThrottled(job, "Not logged in", ops, 10, 10 * MINUTE)).toBe(false);
    expect(isAlertThrottled(job, "Not logged in", ops, 0, 1)).toBe(false);
  });

  it.each([undefined, null, "30", Number.NaN, -5, Number.POSITIVE_INFINITY])(
    "falls back to 60 minutes for a window that is not a usable number: %j", (configured) => {
      expect(alertThrottleMinutes(configured)).toBe(60);
    },
  );

  it.each([0, 5, 60, 1440, 0.5])("accepts a window of %j minutes", (configured) => {
    expect(alertThrottleMinutes(configured)).toBe(configured);
  });
});

// A usage limit that is not waited for fails every fire until it resets, and
// that can be days. An hour's silence between alerts is then twenty-four of
// them a day for one job; this alert is held for the limit period instead.
describe("the alert for a usage limit that is not waited for", () => {
  const period = { engine: "claude", resetsAt: "2026-10-17T03:00:00.000Z" };
  const DAY = 24 * 60 * MINUTE;

  it("is let through once for a job and limit period, and held back for as long as the period lasts", () => {
    const job = jobId();
    expect(isLimitAlertThrottled(job, period, ops, undefined)).toBe(false);
    recordLimitAlertSent(job, period, ops, 0);

    expect(isLimitAlertThrottled(job, period, ops, undefined)).toBe(true);
    recordLimitAlertSent(job, period, ops, 4 * DAY); // nothing here counts hours
    expect(isLimitAlertThrottled(job, period, ops, 5)).toBe(true);
  });

  it.each([
    ["the reset moves", { engine: "claude", resetsAt: "2026-10-24T03:00:00.000Z" }],
    ["it is another engine's limit", { engine: "codex", resetsAt: "2026-10-17T03:00:00.000Z" }],
  ])("is let through again when %s", (_label, next) => {
    const job = jobId();
    recordLimitAlertSent(job, period, ops, 0);

    expect(isLimitAlertThrottled(job, next, ops, undefined)).toBe(false);
  });

  it("is each job's own, and each alert destination's own", () => {
    const [job, other] = [jobId(), jobId()];
    recordLimitAlertSent(job, period, ops, 0);

    expect(isLimitAlertThrottled(other, period, ops, undefined)).toBe(false);
    expect(isLimitAlertThrottled(job, period, "slack:C-new-alerts", undefined)).toBe(false);
  });

  it("is lifted by a success, like any other", () => {
    const job = jobId();
    recordLimitAlertSent(job, period, ops, 0);
    clearAlertThrottle(job);

    expect(isLimitAlertThrottled(job, period, ops, undefined)).toBe(false);
  });

  it("is not held back at all when the throttle is turned off", () => {
    const job = jobId();
    recordLimitAlertSent(job, period, ops, 0);

    expect(isLimitAlertThrottled(job, period, ops, 0)).toBe(false);
  });

  it("leaves the window of every other failure as it was, and is not mistaken for one that reads the same", () => {
    const job = jobId();
    const sameWords = "claude usage limit reached. It resets Sat, 17 Oct, 12:00 (2026-10-17T03:00:00.000Z), which is too far off to wait for.";
    recordLimitAlertSent(job, period, ops, 0);

    expect(isAlertThrottled(job, "Not logged in", ops, undefined, MINUTE)).toBe(false);
    expect(isAlertThrottled(job, sameWords, ops, undefined, MINUTE)).toBe(false);
    recordAlertSent(job, "Not logged in", ops, MINUTE);
    expect(isAlertThrottled(job, "Not logged in", ops, undefined, 30 * MINUTE)).toBe(true);
    expect(isAlertThrottled(job, "Not logged in", ops, undefined, 61 * MINUTE)).toBe(false);
    expect(isLimitAlertThrottled(job, period, ops, undefined)).toBe(true);
  });
});
