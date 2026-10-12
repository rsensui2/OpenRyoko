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
  const root = `${process.env.JINN_HOME}/watcher-config-tests`;
  return {
    CONFIG_PATH: `${root}/config.yaml`, CRON_JOBS: `${root}/cron/jobs.json`,
    ORG_DIR: `${root}/org`, SKILLS_DIR: `${root}/skills`,
    CLAUDE_SKILLS_DIR: `${root}/.claude/skills`, AGENTS_SKILLS_DIR: `${root}/.agents/skills`,
  };
});

import { CONFIG_PATH, CRON_JOBS, ORG_DIR, SKILLS_DIR, CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR } from "../../shared/paths.js";
import { startWatchers, stopWatchers, type WatcherCallbacks } from "../watcher.js";

/* Every API save replaces config.yaml by rename, which gives the path a new
 * inode. A watch on the file itself follows the old inode: it survives a
 * replacement only by catching the event for it, and one missed event (a save
 * right after start-up, an edit from the host side of a bind mount) leaves it
 * deaf for good — hot reload stops without a word. So the directory is
 * watched instead, and a timer compares the file with what was last loaded
 * for the case where no event arrives at all. */

const HOME = path.dirname(CONFIG_PATH);

class FakeWatcher extends EventEmitter {
  close = vi.fn(async () => {});
}
let watchers: FakeWatcher[];
let callbacks: { [K in keyof WatcherCallbacks]: ReturnType<typeof vi.fn<WatcherCallbacks[K]>> };

/** The watcher that covers config.yaml, and the arguments it was created with. */
const configWatcher = () => watchers[0];
const configWatchArgs = () => mocks.watch.mock.calls[0] as [string, { ignored: (candidate: string) => boolean } & Record<string, unknown>];

/** Replace config.yaml the way the gateway's writer does: stage, then rename. */
function replaceConfig(contents: string) {
  const staged = path.join(HOME, `.config.yaml.${process.pid}.tmp`);
  fs.writeFileSync(staged, contents);
  fs.renameSync(staged, CONFIG_PATH);
}

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
  fs.writeFileSync(CONFIG_PATH, "engines:\n  default: claude\n");
  fs.writeFileSync(CRON_JOBS, "[]\n");
});
afterEach(async () => {
  await stopWatchers();
  vi.useRealTimers();
});
afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));

describe("config.yaml watcher", () => {
  it("watches the directory config.yaml lives in, one level deep", () => {
    startWatchers(callbacks);
    const [watched, options] = configWatchArgs();
    expect(watched).toBe(HOME);
    expect(options).toMatchObject({ ignoreInitial: true, depth: 0, awaitWriteFinish: { stabilityThreshold: 300 } });
  });

  it("follows nothing in that directory but config.yaml", () => {
    startWatchers(callbacks);
    const { ignored } = configWatchArgs()[1];
    expect(ignored(HOME)).toBe(false);
    expect(ignored(CONFIG_PATH)).toBe(false);
    for (const neighbour of ["gateway.json", "MEMORY.md", ".config.yaml.123-abc.tmp", "config.yaml.bak", "logs", "tmp", "sessions"]) {
      expect(ignored(path.join(HOME, neighbour))).toBe(true);
    }
    expect(ignored(path.join(HOME, "logs", "config.yaml"))).toBe(true);
  });

  it.each(["change", "add"])("reloads when the directory reports a %s of config.yaml", async (event) => {
    startWatchers(callbacks);
    configWatcher().emit(event, CONFIG_PATH);
    await vi.advanceTimersByTimeAsync(499);
    expect(callbacks.onConfigReload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.onConfigReload).toHaveBeenCalledTimes(1);
    expect(mocks.logger.info).toHaveBeenCalledWith("config.yaml changed, reloading...");
  });

  it("does not reload for a neighbour, nor for config.yaml disappearing", async () => {
    startWatchers(callbacks);
    configWatcher().emit("change", path.join(HOME, "gateway.json"));
    configWatcher().emit("add", path.join(HOME, ".config.yaml.123-abc.tmp"));
    configWatcher().emit("unlink", CONFIG_PATH); // there is nothing to load until it is back
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.onConfigReload).not.toHaveBeenCalled();
  });

  it("reloads once for an editor's delete-then-recreate", async () => {
    startWatchers(callbacks);
    configWatcher().emit("unlink", CONFIG_PATH);
    await vi.advanceTimersByTimeAsync(200);
    configWatcher().emit("add", CONFIG_PATH);
    await vi.advanceTimersByTimeAsync(200);
    configWatcher().emit("change", CONFIG_PATH);
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.onConfigReload).toHaveBeenCalledTimes(1);
  });
});

describe("config.yaml reconciliation", () => {
  it("reloads a replaced config.yaml even when no event arrives at all", async () => {
    startWatchers(callbacks);
    replaceConfig("engines:\n  default: codex\n");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(callbacks.onConfigReload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 + 500);
    expect(callbacks.onConfigReload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000); // and not again for the same file
    expect(callbacks.onConfigReload).toHaveBeenCalledTimes(1);
  });

  it("notices an edit made in place as well", async () => {
    startWatchers(callbacks);
    fs.appendFileSync(CONFIG_PATH, "logging:\n  level: debug\n");
    await vi.advanceTimersByTimeAsync(30_500);
    expect(callbacks.onConfigReload).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while nothing changes", async () => {
    startWatchers(callbacks);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(callbacks.onConfigReload).not.toHaveBeenCalled();
    expect(mocks.logger.info).not.toHaveBeenCalledWith("config.yaml changed, reloading...");
  });

  it("does not reload a second time for a change the watcher already delivered", async () => {
    startWatchers(callbacks);
    replaceConfig("engines:\n  default: codex\n");
    configWatcher().emit("change", CONFIG_PATH);
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.onConfigReload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(callbacks.onConfigReload).toHaveBeenCalledTimes(1);
  });

  it("waits for a config.yaml that is gone, and reloads once it is back", async () => {
    startWatchers(callbacks);
    fs.rmSync(CONFIG_PATH);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbacks.onConfigReload).not.toHaveBeenCalled();
    fs.writeFileSync(CONFIG_PATH, "engines:\n  default: codex\n");
    await vi.advanceTimersByTimeAsync(30_500);
    expect(callbacks.onConfigReload).toHaveBeenCalledTimes(1);
  });

  it("stops with the watchers", async () => {
    startWatchers(callbacks);
    await stopWatchers();
    replaceConfig("engines:\n  default: codex\n");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(callbacks.onConfigReload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("config.yaml watcher against a real directory", () => {
  it("reloads for every rename-replacement of config.yaml, and for none of its neighbours", async () => {
    vi.useRealTimers();
    const actual = await vi.importActual<typeof import("chokidar")>("chokidar");
    const realWatchers: FSWatcher[] = [];
    mocks.watch.mockImplementation((...args: Parameters<typeof actual.watch>) => {
      // Polling, as in watcher.test.ts: real directory reads and chokidar's own
      // event logic, without depending on native watch delivery in CI runners.
      const watcher = actual.watch(args[0], { ...args[1], usePolling: true, interval: 25 });
      realWatchers.push(watcher);
      return watcher;
    });
    startWatchers(callbacks);
    await Promise.all(realWatchers.map((watcher) => new Promise<void>((resolve) => watcher.once("ready", resolve))));

    for (let round = 1; round <= 3; round++) {
      replaceConfig(`engines:\n  default: codex\n  round: ${round}\n`);
      await vi.waitFor(() => expect(callbacks.onConfigReload).toHaveBeenCalledTimes(round), { timeout: 4000, interval: 25 });
    }
    fs.writeFileSync(path.join(HOME, "gateway.json"), "{}\n");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(callbacks.onConfigReload).toHaveBeenCalledTimes(3);
  }, 20_000);
});
