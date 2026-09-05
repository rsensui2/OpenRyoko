import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findJobsNeedingAttention,
  isPidAlive,
  listJobStates,
  pruneOldJobs,
  readJobState,
  writeJobState,
  type JobState,
} from "../state.js";

function makeState(overrides: Partial<JobState> = {}): JobState {
  return {
    id: "test-job-1",
    name: "test-job",
    sessionId: "sess-1",
    gatewayUrl: "http://127.0.0.1:7777",
    command: "echo hi",
    logFile: "/tmp/test-job-1.log",
    monitorPid: process.pid,
    startedAt: new Date().toISOString(),
    status: "running",
    ...overrides,
  };
}

describe("job state files", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a state file", () => {
    const state = makeState();
    writeJobState(state, dir);
    expect(readJobState(state.id, dir)).toEqual(state);
  });

  it("returns null for a missing or corrupt file", () => {
    expect(readJobState("nope", dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
    expect(readJobState("bad", dir)).toBeNull();
  });

  it("rejects a state file with a mismatched id or missing fields (schema guard)", () => {
    fs.writeFileSync(path.join(dir, "spoof.json"), JSON.stringify({ ...makeState(), id: "other" }));
    expect(readJobState("spoof", dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "thin.json"), JSON.stringify({ id: "thin", status: "running" }));
    expect(readJobState("thin", dir)).toBeNull();
  });

  it("rejects a path-traversal job id", () => {
    expect(readJobState("../evil", dir)).toBeNull();
  });

  it("lists states sorted by startedAt and skips corrupt files", () => {
    writeJobState(makeState({ id: "b", startedAt: "2026-08-04T02:00:00Z" }), dir);
    writeJobState(makeState({ id: "a", startedAt: "2026-08-04T01:00:00Z" }), dir);
    fs.writeFileSync(path.join(dir, "bad.json"), "{");
    expect(listJobStates(dir).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("isPidAlive: own pid alive, absurd pid dead", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 30)).toBe(false);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });

  describe("findJobsNeedingAttention", () => {
    it("flags notify_failed and STALE exited jobs, not a freshly-exited one (notify retry in flight)", () => {
      const staleFinish = new Date(Date.now() - 20 * 60_000).toISOString();
      writeJobState(makeState({ id: "stale", status: "exited", exitCode: 0, finishedAt: staleFinish }), dir);
      writeJobState(makeState({ id: "fresh", status: "exited", exitCode: 0, finishedAt: new Date().toISOString() }), dir);
      writeJobState(makeState({ id: "lost", status: "notify_failed", exitCode: 1 }), dir);
      writeJobState(makeState({ id: "ok", status: "notified" }), dir);
      const attention = findJobsNeedingAttention(dir);
      expect(attention.map((a) => [a.kind, a.state.id]).sort()).toEqual([
        ["unnotified", "lost"],
        ["unnotified", "stale"],
      ]);
    });

    it("flags a running job whose monitor is dead as orphaned (after the claim grace period)", () => {
      const oldStart = new Date(Date.now() - 5 * 60_000).toISOString();
      writeJobState(makeState({ id: "orphan", status: "running", monitorPid: 2 ** 30, startedAt: oldStart }), dir);
      writeJobState(makeState({ id: "alive", status: "running", monitorPid: process.pid, startedAt: oldStart }), dir);
      const attention = findJobsNeedingAttention(dir);
      expect(attention).toHaveLength(1);
      expect(attention[0]).toMatchObject({ kind: "orphaned", state: { id: "orphan" } });
    });

    it("gives a just-launched job grace before calling it orphaned (pid not yet claimed)", () => {
      writeJobState(makeState({ id: "launching", status: "running", monitorPid: 0 }), dir);
      expect(findJobsNeedingAttention(dir)).toHaveLength(0);
    });
  });

  it("prunes only old NOTIFIED jobs — unhandled evidence (notify_failed etc.) persists", () => {
    const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    writeJobState(makeState({ id: "old-done", status: "notified", finishedAt: old }), dir);
    writeJobState(makeState({ id: "old-lost", status: "notify_failed", finishedAt: old }), dir);
    writeJobState(makeState({ id: "old-running", status: "running", startedAt: old }), dir);
    writeJobState(makeState({ id: "fresh", status: "notified", finishedAt: new Date().toISOString() }), dir);
    expect(pruneOldJobs(dir)).toBe(1);
    expect(listJobStates(dir).map((s) => s.id).sort()).toEqual(["fresh", "old-lost", "old-running"]);
  });
});
