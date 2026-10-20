import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, CronJob, JinnConfig } from "../../shared/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-cron-runner-breaker-"));
process.env.RYOKO_HOME = root;

const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock("../command.js", () => ({ runCommand }));
vi.mock("../../updates/checker.js", () => ({ checkForUpdates: vi.fn(), buildUpdateNotificationPrompt: vi.fn() }));
vi.mock("../../updates/notification-state.js", () => ({ getLastNotifiedVersion: vi.fn(), markVersionNotified: vi.fn() }));
vi.mock("../../updates/maintenance.js", () => ({ runUpdateMaintenance: vi.fn() }));

let runCronJob: typeof import("../runner.js").runCronJob;
let breaker: typeof import("../breaker.js");

beforeAll(async () => {
  ({ runCronJob } = await import("../runner.js"));
  breaker = await import("../breaker.js");
});
afterEach(() => { fs.rmSync(path.join(root, "cron"), { recursive: true, force: true }); });
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

const sendMessage = vi.fn().mockResolvedValue("message-1");
const connectors = new Map<string, Connector>([["slack", { sendMessage, replyMessage: vi.fn() } as unknown as Connector]]);
const config = {
  engines: { default: "claude", claude: { bin: "claude", model: "m" } },
  portal: { portalName: "Ryoko" },
  cron: { alertConnector: "slack", alertChannel: "CDEFAULT" },
} as unknown as JinnConfig;
const sessionManager = { route: vi.fn() };

const commandJob: CronJob = {
  id: "flaky", name: "Flaky", kind: "command", enabled: true, schedule: "* * * * *", prompt: "",
  command: { executable: "/bin/false" }, failureDelivery: { connector: "slack", channel: "C1" }, maxConsecutiveFailures: 3,
};
const failing = { status: "error", error: "Command exited 1", logFile: "/logs/flaky.log" };
const working = { status: "success", exitCode: 0 };

function runLogStatuses(id: string): string[] {
  const file = path.join(root, "cron", "runs", `${id}.jsonl`);
  return fs.readFileSync(file, "utf-8").trim().split("\n").map(line => JSON.parse(line).status);
}
const pauseAlerts = () => sendMessage.mock.calls.filter(([, text]) => /一時停止/.test(String(text)));

beforeEach(() => { vi.clearAllMocks(); });

describe("pausing a job after consecutive failures", () => {
  it("pauses on the failure that reaches the limit, alerts once, and stops running the job", async () => {
    runCommand.mockResolvedValue(failing);
    await runCronJob(commandJob, sessionManager as never, config, connectors);
    await runCronJob(commandJob, sessionManager as never, config, connectors);
    expect(breaker.readBreaker("flaky")).toBeNull();
    expect(pauseAlerts()).toHaveLength(0);

    await runCronJob(commandJob, sessionManager as never, config, connectors);
    expect(breaker.readBreaker("flaky")).toMatchObject({ failures: 3, lastError: "Command exited 1" });
    expect(pauseAlerts()).toHaveLength(1);
    expect(pauseAlerts()[0][0]).toEqual({ channel: "C1" });
    expect(String(pauseAlerts()[0][1])).toContain("ryoko automation resume flaky");
    expect(String(pauseAlerts()[0][1])).toContain("/logs/flaky.log");

    runCommand.mockClear();
    await runCronJob(commandJob, sessionManager as never, config, connectors);
    expect(runCommand).not.toHaveBeenCalled();
    expect(runLogStatuses("flaky")).toEqual(["error", "error", "error", "paused"]);
    expect(pauseAlerts()).toHaveLength(1);
  });

  it("does not pause when a success breaks up the failures", async () => {
    for (const result of [failing, failing, working, failing, failing]) {
      runCommand.mockResolvedValueOnce(result);
      await runCronJob(commandJob, sessionManager as never, config, connectors);
    }
    expect(breaker.readBreaker("flaky")).toBeNull();
  });

  it("never pauses a job that opted out", async () => {
    runCommand.mockResolvedValue(failing);
    for (let i = 0; i < 8; i++) await runCronJob({ ...commandJob, maxConsecutiveFailures: null }, sessionManager as never, config, connectors);
    expect(breaker.readBreaker("flaky")).toBeNull();
    expect(runCommand).toHaveBeenCalledTimes(8);
  });

  it("still pauses a job whose alerts were switched off, just without a message", async () => {
    runCommand.mockResolvedValue(failing);
    for (let i = 0; i < 3; i++) await runCronJob({ ...commandJob, failureDelivery: null }, sessionManager as never, config, connectors);
    expect(breaker.readBreaker("flaky")).not.toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("pauses an AI job through the same path and alerts the configured channel", async () => {
    sessionManager.route.mockRejectedValue(new Error("engine unavailable"));
    const aiJob: CronJob = { id: "ai", name: "AI job", enabled: true, schedule: "* * * * *", prompt: "do it", maxConsecutiveFailures: 2 };
    await runCronJob(aiJob, sessionManager as never, config, connectors);
    await runCronJob(aiJob, sessionManager as never, config, connectors);
    expect(breaker.readBreaker("ai")).toMatchObject({ failures: 2, lastError: "engine unavailable" });
    expect(pauseAlerts()).toHaveLength(1);
    expect(pauseAlerts()[0][0]).toEqual({ channel: "CDEFAULT" });
    sessionManager.route.mockClear();
    await runCronJob(aiJob, sessionManager as never, config, connectors);
    expect(sessionManager.route).not.toHaveBeenCalled();
  });
});

describe("trying a paused job again", () => {
  const hourAgo = () => {
    const state = breaker.tripBreaker("flaky", 3, "Command exited 1");
    fs.writeFileSync(path.join(root, "cron", "state", "flaky.json"), JSON.stringify({ ...state, pausedAt: new Date(Date.now() - 61 * 60_000).toISOString() }));
  };

  it("runs the job once an hour after the pause and resumes it when that run succeeds", async () => {
    hourAgo();
    runCommand.mockResolvedValue(working);
    await runCronJob(commandJob, sessionManager as never, config, connectors);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(breaker.readBreaker("flaky")).toBeNull();
  });

  it("keeps the job paused, and quiet, when the trial run fails, then waits another hour", async () => {
    hourAgo();
    runCommand.mockResolvedValue(failing);
    await runCronJob(commandJob, sessionManager as never, config, connectors);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(breaker.readBreaker("flaky")).toMatchObject({ failures: 3, lastProbeAt: expect.any(String) });
    expect(sendMessage).not.toHaveBeenCalled();
    await runCronJob(commandJob, sessionManager as never, config, connectors);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("does not run the job again before the hour is up", async () => {
    breaker.tripBreaker("flaky", 3, "Command exited 1");
    await runCronJob(commandJob, sessionManager as never, config, connectors);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("resuming", () => {
  it("starts the streak from zero, so one failure after a resume does not pause the job again", async () => {
    runCommand.mockResolvedValue(failing);
    for (let i = 0; i < 3; i++) await runCronJob(commandJob, sessionManager as never, config, connectors);
    expect(breaker.readBreaker("flaky")).not.toBeNull();
    breaker.resumeBreaker("flaky");
    await runCronJob(commandJob, sessionManager as never, config, connectors);
    expect(breaker.readBreaker("flaky")).toBeNull();
    expect(pauseAlerts()).toHaveLength(1);
  });

  describe("from a paused job", () => {
  beforeEach(() => { breaker.tripBreaker("flaky", 3, "Command exited 1"); });

  it("a manual run goes ahead while paused and a success resumes the job", async () => {
    fs.mkdirSync(path.join(root, "cron", "runs"), { recursive: true });
    runCommand.mockResolvedValue(working);
    await runCronJob(commandJob, sessionManager as never, config, connectors, { manual: true });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(breaker.readBreaker("flaky")).toBeNull();
  });

  it("a manual run that fails leaves the job paused and does not alert again", async () => {
    runCommand.mockResolvedValue(failing);
    await runCronJob(commandJob, sessionManager as never, config, connectors, { manual: true });
    expect(breaker.readBreaker("flaky")).not.toBeNull();
    expect(pauseAlerts()).toHaveLength(0);
  });

  it("resuming by hand lets the scheduler run the job again", async () => {
    breaker.resumeBreaker("flaky");
    runCommand.mockResolvedValue(working);
    await runCronJob(commandJob, sessionManager as never, config, connectors);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
  });
});
