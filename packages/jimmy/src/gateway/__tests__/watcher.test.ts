import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FSWatcher } from "chokidar";

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("chokidar", () => ({ watch: mocks.watch }));
vi.mock("../../shared/logger.js", () => ({ logger: mocks.logger }));
vi.mock("../../shared/paths.js", () => {
  const root = `${process.env.JINN_HOME}/watcher-tests`;
  return {
    CONFIG_PATH: `${root}/config.yaml`, CRON_JOBS: `${root}/cron/jobs.json`,
    ORG_DIR: `${root}/org`, SKILLS_DIR: `${root}/skills`,
    CLAUDE_SKILLS_DIR: `${root}/.claude/skills`, AGENTS_SKILLS_DIR: `${root}/.agents/skills`,
  };
});

import { CONFIG_PATH, CRON_JOBS, ORG_DIR, SKILLS_DIR, CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR } from "../../shared/paths.js";
import { startWatchers, stopWatchers, type WatcherCallbacks } from "../watcher.js";

class FakeWatcher extends EventEmitter {
  close = vi.fn(async () => {});
}
let watchers: FakeWatcher[];
let callbacks: { [K in keyof WatcherCallbacks]: ReturnType<typeof vi.fn<WatcherCallbacks[K]>> };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  watchers = [];
  mocks.watch.mockImplementation(() => {
    const watcher = new FakeWatcher();
    watchers.push(watcher);
    return watcher;
  });
  callbacks = { onConfigReload: vi.fn(), onCronReload: vi.fn(), onOrgChange: vi.fn(), onSkillsChange: vi.fn() };
  for (const dir of [path.dirname(CRON_JOBS), ORG_DIR, SKILLS_DIR, CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, "{}\n");
  fs.writeFileSync(CRON_JOBS, "[]\n");
});
afterEach(async () => {
  await stopWatchers();
  vi.useRealTimers();
});
afterAll(() => fs.rmSync(path.dirname(CONFIG_PATH), { recursive: true, force: true }));

function expectNoCallbacks() {
  for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
}

describe("gateway file watchers", () => {
  it.each(["add", "change", "unlink"])("reconciles cron after a %s event", async (event) => {
    startWatchers(callbacks);
    watchers[1].emit(event, CRON_JOBS);
    await vi.advanceTimersByTimeAsync(499);
    expect(callbacks.onCronReload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.onCronReload).toHaveBeenCalledTimes(1);
  });

  it("coalesces deletion, recreation and write events into one reload", async () => {
    startWatchers(callbacks);
    expect(mocks.watch.mock.calls[1]).toEqual([path.dirname(CRON_JOBS), {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 300 },
    }]);
    watchers[1].emit("unlink", CRON_JOBS);
    await vi.advanceTimersByTimeAsync(200);
    watchers[1].emit("add", CRON_JOBS);
    await vi.advanceTimersByTimeAsync(200);
    watchers[1].emit("change", CRON_JOBS);
    await vi.advanceTimersByTimeAsync(499);
    expect(callbacks.onCronReload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.onCronReload).toHaveBeenCalledTimes(1);
  });

  it("ignores neighboring files and cron run logs", async () => {
    startWatchers(callbacks);
    watchers[1].emit("add", path.join(path.dirname(CRON_JOBS), "jobs.json.tmp"));
    watchers[1].emit("change", path.join(path.dirname(CRON_JOBS), "runs", "job.jsonl"));
    watchers[1].emit("unlink", path.join(path.dirname(CRON_JOBS), "jobs.backup.json"));
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.onCronReload).not.toHaveBeenCalled();
  });

  it("checks cron every 30 seconds even when no filesystem event arrives", async () => {
    startWatchers(callbacks);
    await vi.advanceTimersByTimeAsync(29_999);
    expectNoCallbacks();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.onCronReload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callbacks.onCronReload).toHaveBeenCalledTimes(2);
    expect(callbacks.onConfigReload).not.toHaveBeenCalled();
    expect(callbacks.onOrgChange).not.toHaveBeenCalled();
    expect(callbacks.onSkillsChange).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalledWith("cron/jobs.json changed, reloading...");
  });

  it.each(["config.yaml", "cron/jobs.json", "org/", "skills/"])("logs %s watcher errors without losing cron reconciliation", async (label) => {
    startWatchers(callbacks);
    const index = ["config.yaml", "cron/jobs.json", "org/", "skills/"].indexOf(label);
    expect(() => watchers[index].emit("error", new Error("watch handle lost"))).not.toThrow();
    expect(mocks.logger.error).toHaveBeenCalledWith(`File watcher error (${label}): watch handle lost`);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callbacks.onCronReload).toHaveBeenCalledTimes(1);
  });

  it("contains synchronous and asynchronous callback failures and keeps polling", async () => {
    callbacks.onConfigReload.mockImplementationOnce(() => { throw new Error("bad config"); });
    callbacks.onCronReload.mockImplementationOnce(async () => { throw new Error("bad jobs"); });
    startWatchers(callbacks);
    watchers[0].emit("change", CONFIG_PATH);
    watchers[1].emit("change", CRON_JOBS);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.logger.error).toHaveBeenCalledWith("File watcher callback failed (config.yaml): bad config");
    expect(mocks.logger.error).toHaveBeenCalledWith("File watcher callback failed (cron/jobs.json): bad jobs");
    callbacks.onCronReload.mockImplementationOnce(() => { throw new Error("poll failed"); });
    await vi.advanceTimersByTimeAsync(29_500);
    expect(mocks.logger.error).toHaveBeenCalledWith("File watcher callback failed (cron reconciliation): poll failed");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(callbacks.onCronReload).toHaveBeenCalledTimes(3);
  });

  it("cancels every debounce and poll immediately, including while close is pending", async () => {
    startWatchers(callbacks);
    let finishClose!: () => void;
    watchers[0].close.mockImplementationOnce(() => new Promise<void>((resolve) => { finishClose = resolve; }));
    watchers[0].emit("change", CONFIG_PATH);
    watchers[1].emit("add", CRON_JOBS);
    watchers[2].emit("all", "add", ORG_DIR);
    watchers[3].emit("all", "addDir", SKILLS_DIR);
    expect(vi.getTimerCount()).toBe(5);
    const stopping = stopWatchers();
    expect(vi.getTimerCount()).toBe(0);
    for (const watcher of watchers) {
      watcher.emit("change", CRON_JOBS);
      watcher.emit("all", "change");
      watcher.emit("error", new Error("late close event"));
    }
    await vi.advanceTimersByTimeAsync(90_000);
    expectNoCallbacks();
    expect(vi.getTimerCount()).toBe(0);
    finishClose();
    await stopping;
    for (const watcher of watchers) expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it("restarting watchers cannot revive an old group's callbacks or clear new timers", async () => {
    startWatchers(callbacks);
    watchers[1].emit("change", CRON_JOBS);
    const old = watchers.slice();
    const replacement = { onConfigReload: vi.fn(), onCronReload: vi.fn(), onOrgChange: vi.fn(), onSkillsChange: vi.fn() };
    startWatchers(replacement);
    old[1].emit("add", CRON_JOBS);
    await vi.advanceTimersByTimeAsync(30_000);
    expectNoCallbacks();
    expect(replacement.onCronReload).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    for (const watcher of old) expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it("preserves config, org and skill change behavior including skill links", async () => {
    const skill = `fixture-${Date.now()}`;
    fs.mkdirSync(path.join(SKILLS_DIR, skill));
    startWatchers(callbacks);
    watchers[0].emit("change", CONFIG_PATH);
    watchers[2].emit("all", "add", path.join(ORG_DIR, "employee.md"));
    watchers[3].emit("all", "addDir", path.join(SKILLS_DIR, skill));
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.onConfigReload).toHaveBeenCalledTimes(1);
    expect(callbacks.onOrgChange).toHaveBeenCalledTimes(1);
    expect(callbacks.onSkillsChange).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(CLAUDE_SKILLS_DIR, skill))).toBe(true);
    expect(fs.existsSync(path.join(AGENTS_SKILLS_DIR, skill))).toBe(true);
    fs.rmSync(path.join(SKILLS_DIR, skill), { recursive: true });
    watchers[3].emit("all", "unlinkDir", path.join(SKILLS_DIR, skill));
    await vi.advanceTimersByTimeAsync(500);
    expect(fs.readdirSync(CLAUDE_SKILLS_DIR)).not.toContain(skill);
    expect(fs.readdirSync(AGENTS_SKILLS_DIR)).not.toContain(skill);
  });

  it("closes all watchers even when one close fails", async () => {
    startWatchers(callbacks);
    watchers[1].close.mockRejectedValueOnce(new Error("close failed"));
    await stopWatchers();
    expect(mocks.logger.error).toHaveBeenCalledWith("Failed to close file watcher: close failed");
    for (const watcher of watchers) expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reloads a real cron file after deletion and recreation using polling in hermetic runners", async () => {
    vi.useRealTimers();
    const actual = await vi.importActual<typeof import("chokidar")>("chokidar");
    const realWatchers: FSWatcher[] = [];
    mocks.watch.mockImplementation((...args: Parameters<typeof actual.watch>) => {
      // Exercise actual filesystem reads and chokidar events without relying
      // on native watch delivery or handle limits in sandboxed CI runners.
      // This override is test-only; production options are asserted above.
      const watcher = actual.watch(args[0], { ...args[1], usePolling: true, interval: 25 });
      realWatchers.push(watcher);
      return watcher;
    });
    startWatchers(callbacks);
    await Promise.all(realWatchers.map((watcher) => new Promise<void>((resolve) => watcher.once("ready", resolve))));
    fs.unlinkSync(CRON_JOBS);
    await vi.waitFor(() => expect(callbacks.onCronReload).toHaveBeenCalledTimes(1), { timeout: 4000, interval: 25 });
    callbacks.onCronReload.mockClear();
    fs.writeFileSync(CRON_JOBS, JSON.stringify([{ id: "recreated-job", enabled: false }]) + "\n");
    await vi.waitFor(() => expect(callbacks.onCronReload).toHaveBeenCalledTimes(1), { timeout: 4000, interval: 25 });
  }, 10_000);
});
