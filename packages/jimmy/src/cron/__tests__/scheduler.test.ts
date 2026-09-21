import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob, JinnConfig, Connector } from "../../shared/types.js";
import type { SessionManager } from "../../sessions/manager.js";

const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  runCronJob: vi.fn(),
  loadJobs: vi.fn(),
  saveJobs: vi.fn(),
  tasks: [] as Array<{ callback: () => void; destroy: ReturnType<typeof vi.fn> }>,
}));

vi.mock("node-cron", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-cron")>();
  return { ...actual, default: { ...actual.default, schedule: mocks.schedule } };
});
vi.mock("../runner.js", () => ({ runCronJob: mocks.runCronJob }));
vi.mock("../jobs.js", () => ({ loadJobs: mocks.loadJobs, saveJobs: mocks.saveJobs }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getCronJobScheduleStatus,
  getSchedulerSnapshot,
  reloadScheduler,
  setCronJobEnabled,
  startScheduler,
  stopScheduler,
} from "../scheduler.js";

const job = (id: string, extra: Partial<CronJob> = {}): CronJob => ({
  id, name: id, enabled: true, schedule: "*/15 * * * *", prompt: "Do the job", ...extra,
});
const manager = {} as SessionManager;
const config = {} as JinnConfig;
const connectors = new Map<string, Connector>();
const start = (jobs: CronJob[]) => startScheduler(jobs, manager, config, connectors);

beforeEach(() => {
  stopScheduler();
  vi.clearAllMocks();
  mocks.tasks.length = 0;
  mocks.runCronJob.mockResolvedValue(undefined);
  mocks.schedule.mockImplementation((_expression: string, callback: () => void) => {
    const task = { callback, destroy: vi.fn() };
    mocks.tasks.push(task);
    return task;
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  stopScheduler();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("cron scheduler reconciliation", () => {
  it("reports actual registration independently of desired enabled state", () => {
    const enabled = job("enabled");
    const disabled = job("disabled", { enabled: false });
    start([enabled, disabled]);

    expect(getSchedulerSnapshot()).toEqual({
      running: true, configuredJobIds: ["disabled", "enabled"], registeredJobIds: ["enabled"],
      lastReloadAt: "2026-09-21T00:00:00.000Z",
    });
    expect(getCronJobScheduleStatus(enabled)).toEqual({ state: "scheduled", registered: true });
    expect(getCronJobScheduleStatus(disabled)).toEqual({ state: "disabled", registered: false });
    expect(getCronJobScheduleStatus(job("new"))).toEqual({ state: "pending", registered: false });
    expect(getCronJobScheduleStatus({ ...enabled, prompt: "Changed on disk" }))
      .toEqual({ state: "pending", registered: true });
    expect(getCronJobScheduleStatus({ ...enabled, enabled: false }))
      .toEqual({ state: "pending", registered: true });
  });

  it("keeps unchanged tasks and jitter across periodic reloads and JSON key reordering", async () => {
    const original = job("stable", { kind: "command", command: { executable: "/bin/echo", args: ["hello"] } });
    const other = job("other");
    start([original, other]);
    const first = mocks.tasks[0]!;
    first.callback();
    await vi.advanceTimersByTimeAsync(5_000);
    const reordered = {
      command: { args: ["hello"], executable: "/bin/echo" }, kind: "command" as const,
      prompt: original.prompt, schedule: original.schedule, enabled: true, name: "stable", id: "stable",
    };
    const before = getSchedulerSnapshot();
    expect(reloadScheduler([other, reordered])).toBe(false);
    expect(getSchedulerSnapshot()).toEqual(before);
    expect(mocks.schedule).toHaveBeenCalledTimes(2);
    expect(first.destroy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.runCronJob).toHaveBeenCalledExactlyOnceWith(original, manager, config, connectors);
  });

  it("only replaces changed jobs and cancels their old delayed runs", async () => {
    const original = job("changed");
    const stable = job("stable");
    start([original, stable]);
    const oldTask = mocks.tasks[0]!;
    oldTask.callback();
    mocks.tasks[1]!.callback();
    const updated = { ...original, prompt: "Use the new instructions" };
    expect(reloadScheduler([updated, stable])).toBe(true);
    expect(oldTask.destroy).toHaveBeenCalledOnce();
    expect(mocks.tasks[1]!.destroy).not.toHaveBeenCalled();
    expect(mocks.schedule).toHaveBeenCalledTimes(3);
    expect(getCronJobScheduleStatus(updated)).toEqual({ state: "scheduled", registered: true });
    // A callback queued by node-cron before destruction is also harmless.
    oldTask.callback();
    mocks.tasks[2]!.callback();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.runCronJob.mock.calls.map(([value]) => value)).toEqual([stable, updated]);
  });

  it("removes disabled/deleted jobs and cancels their jitter", async () => {
    const disabled = job("disabled");
    const deleted = job("deleted");
    start([disabled, deleted]);
    for (const task of mocks.tasks) task.callback();
    expect(reloadScheduler([{ ...disabled, enabled: false }])).toBe(true);
    expect(getSchedulerSnapshot().registeredJobIds).toEqual([]);
    expect(getCronJobScheduleStatus({ ...disabled, enabled: false }))
      .toEqual({ state: "disabled", registered: false });
    for (const task of mocks.tasks) {
      expect(task.destroy).toHaveBeenCalledOnce();
      task.callback();
    }
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.runCronJob).not.toHaveBeenCalled();
  });

  it("isolates invalid schedules/timezones and retries a corrected job", () => {
    const badSchedule = job("bad-schedule", { schedule: "not cron" });
    const badTimezone = job("bad-timezone", { timezone: "Mars/Olympus_Mons" });
    const good = job("good", { timezone: "Asia/Tokyo" });
    expect(() => start([badSchedule, badTimezone, good])).not.toThrow();
    expect(getSchedulerSnapshot().registeredJobIds).toEqual(["good"]);
    expect(getCronJobScheduleStatus(badSchedule))
      .toMatchObject({ state: "error", registered: false, error: expect.stringContaining("schedule") });
    expect(getCronJobScheduleStatus(badTimezone))
      .toMatchObject({ state: "error", registered: false, error: expect.stringContaining("timezone") });
    expect(reloadScheduler([badSchedule, badTimezone, good])).toBe(false);
    expect(mocks.schedule).toHaveBeenCalledOnce();
    const corrected = { ...badTimezone, timezone: "Asia/Tokyo" };
    expect(getCronJobScheduleStatus(corrected)).toEqual({ state: "pending", registered: false });
    expect(reloadScheduler([badSchedule, corrected, good])).toBe(true);
    expect(getCronJobScheduleStatus(corrected)).toEqual({ state: "scheduled", registered: true });
  });

  it("surfaces node-cron registration errors without blocking other jobs, then recovers", () => {
    mocks.schedule.mockImplementationOnce(() => { throw new Error("scheduler registration failed"); });
    const failed = job("failed");
    const good = job("good");
    expect(() => start([failed, good])).not.toThrow();
    expect(getCronJobScheduleStatus(failed)).toEqual({
      state: "error", registered: false, error: "scheduler registration failed",
    });
    expect(getSchedulerSnapshot().registeredJobIds).toEqual(["good"]);
    expect(reloadScheduler([failed, good])).toBe(true);
    expect(getCronJobScheduleStatus(failed)).toEqual({ state: "scheduled", registered: true });
    expect(reloadScheduler([failed, good])).toBe(false);
  });

  it("does not continue executing an old valid schedule after an invalid edit", async () => {
    const original = job("edited");
    start([original]);
    const oldTask = mocks.tasks[0]!;
    oldTask.callback();
    const invalid = { ...original, timezone: "Invalid/Timezone" };
    expect(reloadScheduler([invalid])).toBe(true);
    expect(oldTask.destroy).toHaveBeenCalledOnce();
    expect(getCronJobScheduleStatus(invalid)).toMatchObject({ state: "error", registered: false });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.runCronJob).not.toHaveBeenCalled();
  });

  it("reports stop and does not restart from a late reconciliation", async () => {
    const enabled = job("enabled");
    start([enabled]);
    mocks.tasks[0]!.callback();
    stopScheduler();
    expect(getSchedulerSnapshot()).toMatchObject({ running: false, registeredJobIds: [] });
    expect(getCronJobScheduleStatus(enabled)).toEqual({ state: "stopped", registered: false });
    expect(reloadScheduler([enabled])).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.runCronJob).not.toHaveBeenCalled();
    start([enabled]);
    expect(getCronJobScheduleStatus(enabled)).toEqual({ state: "scheduled", registered: true });
  });

  it("registers a snapshot so caller mutations cannot change a pending fire", async () => {
    const original = job("snapshot");
    start([original]);
    mocks.tasks[0]!.callback();
    original.prompt = "Changed but not reconciled";
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.runCronJob.mock.calls[0]![0].prompt).toBe("Do the job");
    expect(getCronJobScheduleStatus(original)).toEqual({ state: "pending", registered: true });
  });

  it("preserves set-enabled persistence and synchronous reconciliation", () => {
    const original = job("toggle");
    start([original]);
    mocks.loadJobs.mockReturnValue([original]);
    const disabled = setCronJobEnabled(" TOGGLE ", false);
    expect(disabled).toEqual({ ...original, enabled: false });
    expect(mocks.saveJobs).toHaveBeenCalledExactlyOnceWith([disabled]);
    expect(getCronJobScheduleStatus(disabled!)).toEqual({ state: "disabled", registered: false });
    expect(mocks.tasks[0]!.destroy).toHaveBeenCalledOnce();
  });
});
