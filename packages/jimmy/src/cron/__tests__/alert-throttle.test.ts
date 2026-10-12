import { describe, expect, it } from "vitest";
import { alertThrottleMinutes, clearAlertThrottle, isAlertThrottled, recordAlertSent } from "../alert-throttle.js";

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
  ])("treats one cause reported with different ids or times as the same failure", (first, second) => {
    const job = jobId();
    recordAlertSent(job, first, ops, 0);
    expect(isAlertThrottled(job, second, ops, undefined, MINUTE)).toBe(true);
  });

  it.each([
    ["API Error: 529 Overloaded", "API Error: 401 Unauthorized"],
    ["Command exited 2", "Command exited 7"],
    ['Engine "gemini" named by the job is not available', 'Engine "codex" named by the job is not available'],
  ])("still tells causes apart when only a short code or a name differs", (first, second) => {
    const job = jobId();
    recordAlertSent(job, first, ops, 0);
    expect(isAlertThrottled(job, second, ops, undefined, MINUTE)).toBe(false);
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
