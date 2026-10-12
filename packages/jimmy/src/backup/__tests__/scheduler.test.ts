import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../shared/logger.js";
import { CONFIG_PATH, JINN_HOME } from "../../shared/paths.js";
import type { DiskSpaceStatus } from "../../shared/storage-health.js";
import type { JinnConfig } from "../../shared/types.js";
import { inspectHomeArchive } from "../archive.js";
import { listBackups } from "../catalog.js";
import { runBackup, type BackupRunOptions, type BackupRunReport, type BackupTargetName } from "../run.js";
import { getBackupStatus, startBackupScheduler, type BackupScheduler } from "../scheduler.js";
import { applyRunReport, BACKUP_STATE_FILE, readBackupState, writeBackupState } from "../state.js";
import { makeHome, removeTempDirs, rowCount, tempDir } from "./fixture.js";

const START = new Date("2026-10-12T03:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const ROOMY: DiskSpaceStatus = { level: "ok", freeBytes: 50 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, freePercent: 50 };

type BackupConfig = Pick<JinnConfig, "backup">;

interface Harness {
  home: string;
  directory: string;
  calls: BackupRunOptions[];
  scheduler: BackupScheduler;
  database: Database.Database;
  /**
   * What the next runs report, by target. Anything not named succeeds.
   * "failed for good" is a failure trying again cannot change, like a home over the size cap.
   */
  outcomes: Partial<Record<BackupTargetName, "ok" | "skipped" | "failed" | "failed for good">>;
  config: BackupConfig;
}

const schedulers: BackupScheduler[] = [];
const databases: Database.Database[] = [];

function reportFor(options: BackupRunOptions, outcomes: Harness["outcomes"]): BackupRunReport {
  const targets = (options.targets ?? ["home", "sessions", "workflows"]).map((name) => {
    const outcome = outcomes[name] ?? "ok";
    if (outcome === "failed for good") {
      return { name, status: "failed" as const, warnings: [], error: `${name} is over the limit`, persistent: true as const };
    }
    return { name, status: outcome, warnings: [], ...(outcome === "failed" ? { error: `${name} could not be written` } : {}) };
  });
  return {
    directory: options.settings.directory,
    startedAt: options.now.toISOString(),
    finishedAt: options.now.toISOString(),
    status: targets.some((target) => target.status === "failed") ? "failed" : "ok",
    targets,
    pruned: [],
  };
}

/** A scheduler over a temp home whose runs are recorded instead of performed. */
function start(config: BackupConfig = {}, extra: Partial<Parameters<typeof startBackupScheduler>[0]> = {}): Harness {
  const home = makeHome(tempDir());
  const database = new Database(":memory:");
  databases.push(database);
  const harness: Harness = {
    home, directory: path.join(home, "backups"), calls: [], database, outcomes: {}, config,
    scheduler: undefined as unknown as BackupScheduler,
  };
  harness.scheduler = startBackupScheduler({
    database,
    config,
    home,
    loadConfig: () => harness.config,
    run: async (options) => {
      harness.calls.push(options);
      return reportFor(options, harness.outcomes);
    },
    ...extra,
  });
  schedulers.push(harness.scheduler);
  return harness;
}

const targetsOf = (harness: Harness): (readonly BackupTargetName[] | undefined)[] => harness.calls.map((call) => call.targets);

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  removeTempDirs();
});

describe("startBackupScheduler", () => {
  it("does not hold up boot, and backs everything up once the gateway has settled", async () => {
    const harness = start();

    expect(harness.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(harness.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(targetsOf(harness)).toEqual([["home", "sessions", "workflows"]]);
    expect(harness.calls[0]).toMatchObject({ home: harness.home, settings: { directory: harness.directory, retention: 14 } });
  });

  it("runs again only once a day has passed since the last success", async () => {
    const harness = start();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(harness.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(23 * HOUR_MS);
    expect(harness.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(HOUR_MS + 15 * MINUTE_MS);
    expect(harness.calls).toHaveLength(2);
    const gap = harness.calls[1]!.now.getTime() - harness.calls[0]!.now.getTime();
    expect(gap).toBeGreaterThanOrEqual(24 * HOUR_MS);
    expect(gap).toBeLessThanOrEqual(24 * HOUR_MS + 15 * MINUTE_MS);
  });

  it("stays daily across a week of uptime", async () => {
    const harness = start();

    await vi.advanceTimersByTimeAsync(7 * 24 * HOUR_MS + HOUR_MS);

    expect(harness.calls).toHaveLength(8);
  });

  it("remembers the last success across a restart instead of backing up on every boot", async () => {
    const first = start();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    first.scheduler.stop();
    expect(readBackupState(first.directory).targets.home?.lastSuccessAt).toBe(first.calls[0]!.now.toISOString());

    const calls: BackupRunOptions[] = [];
    const database = new Database(":memory:");
    databases.push(database);
    const second = startBackupScheduler({
      database, config: {}, home: first.home, loadConfig: () => ({}),
      run: async (options) => { calls.push(options); return reportFor(options, {}); },
    });
    schedulers.push(second);
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(calls).toEqual([]);
  });

  it("retries only the target that failed, an hour later", async () => {
    const harness = start();
    harness.outcomes = { workflows: "failed" };
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(targetsOf(harness)).toEqual([["home", "sessions", "workflows"]]);

    await vi.advanceTimersByTimeAsync(45 * MINUTE_MS);
    expect(harness.calls).toHaveLength(1);

    harness.outcomes = {};
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(targetsOf(harness)).toEqual([["home", "sessions", "workflows"], ["workflows"]]);
  });

  it("leaves a failure that trying again cannot change until the next daily run, and logs it once a day", async () => {
    const harness = start();
    harness.outcomes = { home: "failed for good" };

    await vi.advanceTimersByTimeAsync(23 * HOUR_MS + 45 * MINUTE_MS);

    // One attempt in the day, so one error line in the log - not twenty-four of each.
    expect(targetsOf(harness)).toEqual([["home", "sessions", "workflows"]]);
    const errors = vi.mocked(logger.error).mock.calls.map(([line]) => line);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Backup failed (home): home is over the limit");
    expect(errors[0]).toMatch(/not be retried until the next daily backup/);
    expect(getBackupStatus()).toMatchObject({ level: "warning", targets: { home: { error: "home is over the limit" } } });

    // The next day it is tried again with everything else, and can succeed once the cause is gone.
    harness.outcomes = {};
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);

    expect(targetsOf(harness)).toEqual([["home", "sessions", "workflows"], ["home", "sessions", "workflows"]]);
    expect(getBackupStatus().level).toBe("ok");
  });

  it("logs a failed target as an error and a written one as info", async () => {
    const harness = start();
    harness.outcomes = { home: "failed" };

    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect(vi.mocked(logger.error).mock.calls.map(([line]) => line)).toEqual(["Backup failed (home): home could not be written"]);
    expect(vi.mocked(logger.info).mock.calls.some(([line]) => /sessions/.test(line))).toBe(true);
  });

  it("does nothing while backups are disabled, and picks up a config that turns them on", async () => {
    const harness = start({ backup: { enabled: false } });
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);

    expect(harness.calls).toEqual([]);
    expect(getBackupStatus()).toMatchObject({ level: "disabled" });

    harness.config = { backup: { enabled: true, retention: 3 } };
    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.settings.retention).toBe(3);
  });

  it("keeps its last good settings when config.yaml stops parsing", async () => {
    const harness = start({ backup: { retention: 5 } }, {
      loadConfig: () => { throw new Error("bad indentation of a mapping entry"); },
    });

    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.settings.retention).toBe(5);
  });

  it("backs up straight away into a directory the config newly points at", async () => {
    const harness = start();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(harness.calls).toHaveLength(1);
    const elsewhere = path.join(tempDir(), "external");

    harness.config = { backup: { directory: elsewhere } };
    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);

    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]).toMatchObject({ settings: { directory: elsewhere }, targets: ["home", "sessions", "workflows"] });
    expect(getBackupStatus().directory).toBe(elsewhere);
  });

  it("warns once about a setting it had to ignore, not on every check", async () => {
    start({ backup: { retention: 0 } });

    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);

    expect(vi.mocked(logger.warn).mock.calls.map(([line]) => line)).toEqual([
      expect.stringMatching(/^Backup settings: backup\.retention/),
    ]);
  });

  it("stops checking once it is stopped", async () => {
    const harness = start();
    harness.scheduler.stop();

    await vi.advanceTimersByTimeAsync(3 * 24 * HOUR_MS);

    expect(harness.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("survives a run that throws and tries again later", async () => {
    let attempts = 0;
    const harness = start({}, {
      run: async () => {
        attempts += 1;
        throw new Error("unexpected");
      },
    });

    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);

    expect(attempts).toBeGreaterThan(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(attempts);
    expect(vi.mocked(logger.error).mock.calls.every(([line]) => /Backup check failed: unexpected/.test(line))).toBe(true);
    expect(harness.calls).toEqual([]);
  });

  it("never starts a second run while one is still going", async () => {
    let active = 0;
    let peak = 0;
    let finished = 0;
    const harness = start({}, {
      run: async (options) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 3 * HOUR_MS));
        active -= 1;
        finished += 1;
        return reportFor(options, { home: "failed" });
      },
    });

    await vi.advanceTimersByTimeAsync(12 * HOUR_MS);
    await harness.scheduler.check();

    expect(peak).toBe(1);
    expect(finished).toBeGreaterThan(1);
  });

  it("hands the run the gateway's own registry connection", async () => {
    const harness = start();

    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    const handle = harness.calls[0]!.databases!.sessions!()!;
    expect(handle.database).toBe(harness.database);
    handle.release();
    expect(harness.database.open).toBe(true);
    expect(harness.calls[0]!.databases!.workflows).toBeUndefined();
  });

  it("counts a backup taken from the CLI towards the daily schedule", async () => {
    const harness = start();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(harness.calls).toHaveLength(1);

    // Twenty hours in, somebody runs `ryoko backup run`: it writes the same state file.
    await vi.advanceTimersByTimeAsync(20 * HOUR_MS);
    const manual = reportFor({ ...harness.calls[0]!, now: new Date() }, {});
    writeBackupState(harness.directory, applyRunReport(readBackupState(harness.directory), manual));

    await vi.advanceTimersByTimeAsync(10 * HOUR_MS);
    expect(harness.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(14 * HOUR_MS + 15 * MINUTE_MS);
    expect(harness.calls).toHaveLength(2);
  });
});

describe("getBackupStatus", () => {
  it("is unknown before the first check and ok once everything has been backed up", async () => {
    const harness = start();
    expect(getBackupStatus()).toMatchObject({ level: "unknown", directory: harness.directory });

    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    const status = getBackupStatus();
    expect(status.level).toBe("ok");
    expect(status.targets.home).toEqual({
      lastSuccessAt: harness.calls[0]!.now.toISOString(), lastAttemptAt: harness.calls[0]!.now.toISOString(), error: null,
    });
    expect(Object.keys(status.targets).sort()).toEqual(["home", "sessions", "workflows"]);
  });

  it("turns to warning, naming the target and the reason, while a backup is failing", async () => {
    const harness = start();
    harness.outcomes = { sessions: "failed" };

    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    const status = getBackupStatus();
    expect(status.level).toBe("warning");
    expect(status.targets.sessions).toMatchObject({ lastSuccessAt: null, error: "sessions could not be written" });
    expect(status.targets.home!.error).toBeNull();

    harness.outcomes = {};
    await vi.advanceTimersByTimeAsync(HOUR_MS + 15 * MINUTE_MS);
    expect(getBackupStatus().level).toBe("ok");
  });

  it("keeps reporting the failure when the state file itself cannot be written", async () => {
    const harness = start();
    harness.outcomes = { home: "failed", sessions: "failed", workflows: "failed" };
    fs.rmSync(harness.directory, { recursive: true });
    fs.writeFileSync(harness.directory, "a file where the directory should be\n");

    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect(getBackupStatus().level).toBe("warning");
    expect(fs.existsSync(path.join(harness.directory, BACKUP_STATE_FILE))).toBe(false);
    // Held in memory, so the retry still waits its hour instead of firing on every check.
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(harness.calls).toHaveLength(1);
  });

  it("does not put a secret that surfaced in an error message on the status endpoint", async () => {
    const leaky = "x".repeat(20);
    const harness = start({}, {
      run: async (options) => ({
        ...reportFor(options, {}),
        status: "failed",
        targets: [{ name: "home", status: "failed", warnings: [], error: `could not read config: botToken: xoxb-${leaky}` }],
      }),
    });

    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect(getBackupStatus().targets.home!.error).not.toContain(leaky);
    expect(harness.calls).toEqual([]);
  });

  it("goes back to unknown once the scheduler has stopped", async () => {
    const harness = start();
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    harness.scheduler.stop();

    expect(getBackupStatus()).toEqual({ level: "unknown", directory: null, targets: {} });
  });
});

describe("startBackupScheduler as the gateway calls it", () => {
  // server.ts passes the registry connection and the boot config, nothing
  // else: the home, the config reader and the run are the real ones. The home
  // is the throwaway one vitest resolves for this worker.
  const seeded = [CONFIG_PATH, path.join(JINN_HOME, "AGENTS.md"), path.join(JINN_HOME, "backups")];

  afterEach(() => {
    for (const target of seeded) fs.rmSync(target, { recursive: true, force: true });
  });

  it("backs up the home this process resolved, reading its settings from config.yaml", async () => {
    vi.useRealTimers();
    expect(JINN_HOME.startsWith(fs.realpathSync(os.tmpdir())) || JINN_HOME.startsWith(os.tmpdir())).toBe(true);
    fs.mkdirSync(JINN_HOME, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, "gateway:\n  port: 7901\nbackup:\n  retention: 3\n");
    fs.writeFileSync(path.join(JINN_HOME, "AGENTS.md"), "# Agents\n");
    const database = new Database(":memory:");
    databases.push(database);
    database.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO sessions (label) VALUES ('live')");

    const scheduler = startBackupScheduler({ database, config: {} });
    schedulers.push(scheduler);
    await scheduler.check();

    const directory = path.join(JINN_HOME, "backups");
    const items = listBackups(directory);
    expect(items.map((item) => item.kind).sort()).toEqual(["home", "sessions"]);
    const archive = await inspectHomeArchive(items.find((item) => item.kind === "home")!.file);
    expect(archive.ok).toBe(true);
    expect(archive.manifest!.entries.map((entry) => entry.path).sort()).toEqual(["AGENTS.md", "config.yaml"]);
    expect(getBackupStatus()).toMatchObject({ level: "ok", directory });
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });
});

describe("startBackupScheduler with real backups", () => {
  it("writes an archive and the registry copy for the running home", async () => {
    vi.useRealTimers();
    const home = makeHome(tempDir(), "home", { workflowRows: 2 });
    const database = new Database(":memory:");
    databases.push(database);
    database.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, label TEXT); INSERT INTO sessions (label) VALUES ('live')");
    const scheduler = startBackupScheduler({
      database, config: {}, home, loadConfig: () => ({}),
      run: (options) => runBackup({ ...options, diskSpace: () => ROOMY }),
    });
    schedulers.push(scheduler);

    await scheduler.check();

    const items = listBackups(path.join(home, "backups"));
    expect(items.map((item) => item.kind).sort()).toEqual(["home", "sessions", "workflows"]);
    expect(rowCount(items.find((item) => item.kind === "sessions")!.file, "sessions")).toBe(1);
    expect(getBackupStatus().level).toBe("ok");
    expect(Object.keys(readBackupState(path.join(home, "backups")).targets).sort()).toEqual(["home", "sessions", "workflows"]);
  });
});
