import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-cron-breaker-"));
process.env.RYOKO_HOME = root;
const runs = path.join(root, "cron", "runs");
const state = path.join(root, "cron", "state");
let breaker: typeof import("../breaker.js");

beforeAll(async () => { breaker = await import("../breaker.js"); });
afterEach(() => { fs.rmSync(path.join(root, "cron"), { recursive: true, force: true }); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

function writeRuns(id: string, statuses: string[]): void {
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, `${id}.jsonl`), statuses.map(status => JSON.stringify({ status })).join("\n") + "\n");
}

describe("counting consecutive failures", () => {
  it("counts the failures at the end of the run log and stops at the last success", () => {
    writeRuns("job", ["error", "error", "success", "error", "error", "error"]);
    expect(breaker.countConsecutiveFailures("job")).toBe(3);
  });

  it("is zero after a success, for a job that never ran and for a log that cannot be read", () => {
    writeRuns("healthy", ["error", "error", "success"]);
    expect(breaker.countConsecutiveFailures("healthy")).toBe(0);
    expect(breaker.countConsecutiveFailures("never-ran")).toBe(0);
  });

  it("looks through skipped and paused entries instead of treating them as a recovery", () => {
    writeRuns("job", ["error", "skipped", "error", "paused", "paused", "error"]);
    expect(breaker.countConsecutiveFailures("job")).toBe(3);
  });

  it("ignores lines it cannot parse", () => {
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, "job.jsonl"), '{"status":"error"}\nnot json\n{"status":"error"}\n{"status":"err');
    expect(breaker.countConsecutiveFailures("job")).toBe(2);
  });

  it("starts counting again after a resume", () => {
    writeRuns("job", ["error", "error", "error", "error", "error", "paused", "resumed", "error"]);
    expect(breaker.countConsecutiveFailures("job")).toBe(1);
  });

  it("does not count the maintenance entries an update-notification job logs beside its result", () => {
    fs.mkdirSync(runs, { recursive: true });
    const lines = [{ status: "error", kind: "maintenance" }, { status: "error" }, { status: "error", kind: "maintenance" }, { status: "error" }];
    fs.writeFileSync(path.join(runs, "job.jsonl"), lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    expect(breaker.countConsecutiveFailures("job")).toBe(2);
  });

  it("reads only the tail of a long log and still gets the streak right", () => {
    writeRuns("job", [...Array(20_000).fill("success"), ...Array(7).fill("error")]);
    expect(breaker.countConsecutiveFailures("job")).toBe(7);
  });
});

describe("failure limit", () => {
  it("defaults to five and accepts a positive whole number", () => {
    expect(breaker.failureLimit({})).toBe(5);
    expect(breaker.failureLimit({ maxConsecutiveFailures: 2 })).toBe(2);
  });

  it("is switched off by null or 0", () => {
    expect(breaker.failureLimit({ maxConsecutiveFailures: null })).toBeNull();
    expect(breaker.failureLimit({ maxConsecutiveFailures: 0 })).toBeNull();
  });

  it.each([-1, 1.5, Number.NaN, "3" as unknown as number])("falls back to the default for the unusable value %s", value => {
    expect(breaker.failureLimit({ maxConsecutiveFailures: value })).toBe(5);
  });
});

describe("paused state", () => {
  it("is written, read back and cleared", () => {
    expect(breaker.readBreaker("job")).toBeNull();
    const tripped = breaker.tripBreaker("job", 5, "Command exited 1");
    expect(breaker.readBreaker("job")).toEqual(tripped);
    expect(tripped).toMatchObject({ reason: "consecutive_failures", failures: 5, lastError: "Command exited 1" });
    expect(breaker.resumeBreaker("job")).toBe(true);
    expect(breaker.readBreaker("job")).toBeNull();
    expect(breaker.resumeBreaker("job")).toBe(false);
  });

  it("leaves a resumed entry in the run log, but only when the job really was paused", () => {
    breaker.resumeBreaker("job");
    expect(fs.existsSync(path.join(runs, "job.jsonl"))).toBe(false);
    breaker.tripBreaker("job", 5, "x");
    breaker.resumeBreaker("job");
    expect(fs.readFileSync(path.join(runs, "job.jsonl"), "utf-8")).toContain('"status":"resumed"');
  });

  it("is due for a probe an hour after the pause, and again an hour after each probe", () => {
    const state = breaker.tripBreaker("job", 5, "x");
    const pausedAt = Date.parse(state.pausedAt);
    expect(breaker.probeDue(state, pausedAt + breaker.PROBE_INTERVAL_MS - 1)).toBe(false);
    expect(breaker.probeDue(state, pausedAt + breaker.PROBE_INTERVAL_MS)).toBe(true);
    const probed = { ...state, lastProbeAt: new Date(pausedAt + breaker.PROBE_INTERVAL_MS).toISOString() };
    expect(breaker.probeDue(probed, pausedAt + breaker.PROBE_INTERVAL_MS + 1000)).toBe(false);
    expect(breaker.probeDue(probed, pausedAt + 2 * breaker.PROBE_INTERVAL_MS)).toBe(true);
  });

  it("records a probe without losing the reason for the pause", () => {
    const state = breaker.tripBreaker("job", 5, "Command exited 1");
    breaker.markProbe("job", state);
    expect(breaker.readBreaker("job")).toMatchObject({ failures: 5, lastError: "Command exited 1", lastProbeAt: expect.any(String) });
  });

  it("never stops a job because its state file is unreadable", () => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "job.json"), "{broken");
    expect(breaker.readBreaker("job")).toBeNull();
  });

  it("keeps a job id from addressing a path outside the state directory", () => {
    breaker.tripBreaker("../../escape", 5, "x");
    expect(fs.existsSync(path.join(root, "escape.json"))).toBe(false);
    expect(fs.readdirSync(state).filter(name => name.endsWith(".json"))).toHaveLength(1);
    expect(breaker.readBreaker("../../escape")).not.toBeNull();
  });

  it("does not leave temporary files behind", () => {
    breaker.tripBreaker("job", 5, "x");
    expect(fs.readdirSync(state).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });
});
