import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runJobMonitor } from "../monitor.js";
import { isPidAlive, readJobState, writeJobState, type JobState } from "../state.js";

/**
 * Integration: the monitor runs a real `/bin/sh` command, captures the log,
 * and wakes the session through a (fake) gateway. This pins the acceptance
 * criteria: notification on success AND failure, exactly once, with exit
 * code + log tail; orphan/no-rerun safety on restart.
 */
describe("runJobMonitor", () => {
  let dir: string;
  let server: http.Server;
  let gatewayUrl: string;
  let received: { url: string; authorization?: string; body: { message: string; role: string } }[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-monitor-"));
    received = [];
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        received.push({
          url: req.url ?? "",
          authorization: req.headers.authorization,
          body: JSON.parse(raw),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    gatewayUrl = typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : "";
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedJob(overrides: Partial<JobState> = {}): JobState {
    const state: JobState = {
      id: "j1",
      name: "test-job",
      sessionId: "sess-42",
      gatewayUrl,
      command: "echo hello-from-job",
      logFile: path.join(dir, "j1.log"),
      // Mirror the launcher: pid 0 until the monitor claims the job.
      monitorPid: 0,
      startedAt: new Date().toISOString(),
      status: "running",
      ...overrides,
    };
    writeJobState(state, dir);
    return state;
  }

  it("success: runs the command, logs output, wakes the session once with exit 0", async () => {
    seedJob();
    const final = await runJobMonitor("j1", {
      jobsDir: dir,
      retryDelaysMs: [10],
      readAuthToken: () => "monitor-gateway-token",
    });

    expect(final?.status).toBe("notified");
    expect(final?.exitCode).toBe(0);
    expect(fs.readFileSync(final!.logFile, "utf8")).toContain("hello-from-job");

    expect(received).toHaveLength(1);
    expect(received[0].url).toBe("/api/sessions/sess-42/message");
    expect(received[0].authorization).toBe("Bearer monitor-gateway-token");
    expect(received[0].body.role).toBe("notification");
    expect(received[0].body.message).toContain('✅ Detached job "test-job" completed successfully');
    expect(received[0].body.message).toContain("hello-from-job");

    expect(readJobState("j1", dir)?.status).toBe("notified");
  });

  it("failure: non-zero exit still wakes the session, with failure wording", async () => {
    seedJob({ command: "echo about-to-fail; exit 3" });
    const final = await runJobMonitor("j1", { jobsDir: dir, retryDelaysMs: [10] });

    expect(final?.status).toBe("notified");
    expect(final?.exitCode).toBe(3);
    expect(received).toHaveLength(1);
    expect(received[0].body.message).toContain("FAILED — exited with code 3");
    expect(received[0].body.message).toContain("about-to-fail");
  });

  it("timeout: the job is killed and reported as timed out", async () => {
    seedJob({ command: "sleep 30", timeoutSec: 1 });
    const final = await runJobMonitor("j1", { jobsDir: dir, retryDelaysMs: [10] });

    expect(final?.timedOut).toBe(true);
    expect(final?.status).toBe("notified");
    expect(received).toHaveLength(1);
    expect(received[0].body.message).toContain("timed out after 1s");
  }, 15_000);

  it("gateway down: state becomes notify_failed (detectable next turn), never silent", async () => {
    const state = seedJob({ gatewayUrl: "http://127.0.0.1:1" });
    const final = await runJobMonitor("j1", { jobsDir: dir, retryDelaysMs: [1] });

    expect(final?.status).toBe("notify_failed");
    expect(final?.notifyError).toBeTruthy();
    expect(readJobState(state.id, dir)?.status).toBe("notify_failed");
  });

  it("restart safety: a monitor re-run on a finished job does not re-run or re-notify", async () => {
    seedJob();
    await runJobMonitor("j1", { jobsDir: dir, retryDelaysMs: [10] });
    const again = await runJobMonitor("j1", { jobsDir: dir, retryDelaysMs: [10] });

    expect(again?.status).toBe("notified");
    expect(received).toHaveLength(1); // still exactly one notification
  });

  it("unknown job id: returns null without side effects", async () => {
    expect(await runJobMonitor("nope", { jobsDir: dir })).toBeNull();
    expect(received).toHaveLength(0);
  });

  it("timeout kills the whole process tree, not just the shell", async () => {
    const childPidsFile = path.join(dir, "child-pids.txt");
    const marker = "sleep 61.234";
    seedJob({
      command: `${marker} & echo $! >> ${JSON.stringify(childPidsFile)}; ${marker} & echo $! >> ${JSON.stringify(childPidsFile)}; wait`,
      timeoutSec: 1,
    });
    const final = await runJobMonitor("j1", { jobsDir: dir, retryDelaysMs: [10] });

    expect(final?.timedOut).toBe(true);
    const childPids = fs.readFileSync(childPidsFile, "utf8")
      .trim()
      .split("\n")
      .map(Number)
      .filter(Number.isInteger);
    expect(childPids).toHaveLength(2);

    // Check the exact child PIDs rather than `pgrep -f <marker>`. On Linux,
    // pgrep can match the wrapper shell whose argv contains the marker and
    // report a false survivor. Allow init a short window to reap killed jobs.
    const deadline = Date.now() + 3_000;
    while (childPids.some(isPidAlive) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(childPids.filter(isPidAlive)).toEqual([]);
  }, 20_000);

  it("never re-runs a job a dead monitor already claimed (its child may still be alive)", async () => {
    // A previous monitor claimed the job (monitorPid set, dead) and vanished.
    seedJob({ command: "echo should-not-run >> " + path.join(dir, "reran.txt"), monitorPid: 2 ** 30 });
    const result = await runJobMonitor("j1", { jobsDir: dir, retryDelaysMs: [10] });

    expect(result?.status).toBe("running"); // untouched — orphan detection owns it
    expect(fs.existsSync(path.join(dir, "reran.txt"))).toBe(false);
    expect(received).toHaveLength(0);
  });

  it("two concurrent monitors on the same job run the command and notify only once", async () => {
    seedJob({ command: "echo once >> " + path.join(dir, "ran.txt") });
    const [a, b] = await Promise.all([
      runJobMonitor("j1", { jobsDir: dir, retryDelaysMs: [10] }),
      runJobMonitor("j1", { jobsDir: dir, retryDelaysMs: [10] }),
    ]);

    // One claimed and finished; the other bailed at the claim.
    const statuses = [a?.status, b?.status].sort();
    expect(statuses).toContain("notified");
    expect(received).toHaveLength(1);
    const runs = fs.readFileSync(path.join(dir, "ran.txt"), "utf8").trim().split("\n");
    expect(runs).toHaveLength(1);
  });
});
