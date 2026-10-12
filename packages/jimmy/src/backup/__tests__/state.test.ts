import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expectPosixMode } from "../../shared/test-support/posix-mode.js";
import type { BackupRunReport } from "../run.js";
import {
  applyRunReport,
  BACKUP_INTERVAL_MS,
  BACKUP_STATE_FILE,
  dueTargets,
  mergeStates,
  readBackupState,
  RETRY_AFTER_FAILURE_MS,
  writeBackupState,
  type BackupState,
} from "../state.js";
import { removeTempDirs, tempDir } from "./fixture.js";

const NOW = new Date("2026-10-12T03:00:00.000Z");
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const HOUR_MS = 60 * 60 * 1000;

function report(statuses: Record<string, "ok" | "skipped" | "failed">, startedAt = NOW): BackupRunReport {
  const targets = Object.entries(statuses).map(([name, status]) => ({
    name: name as "home",
    status,
    warnings: [],
    ...(status === "failed" ? { error: `${name} broke` } : {}),
  }));
  return {
    directory: "/backups",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date(startedAt.getTime() + 2000).toISOString(),
    status: targets.some((target) => target.status === "failed") ? "failed" : "ok",
    targets,
    pruned: [],
  };
}

afterEach(removeTempDirs);

describe("dueTargets", () => {
  it("treats a target that has never succeeded as due", () => {
    expect(dueTargets({ version: 1, targets: {} }, NOW)).toEqual(["home", "sessions", "workflows"]);
  });

  it("waits a full day after a success, and not a moment longer", () => {
    const state = (elapsed: number): BackupState => ({
      version: 1,
      targets: {
        home: { lastAttemptAt: ago(elapsed), lastSuccessAt: ago(elapsed) },
        sessions: { lastAttemptAt: ago(elapsed), lastSuccessAt: ago(elapsed) },
        workflows: { lastAttemptAt: ago(elapsed), lastSuccessAt: ago(elapsed) },
      },
    });

    expect(dueTargets(state(BACKUP_INTERVAL_MS - 1), NOW)).toEqual([]);
    expect(dueTargets(state(BACKUP_INTERVAL_MS), NOW)).toEqual(["home", "sessions", "workflows"]);
    expect(BACKUP_INTERVAL_MS).toBe(24 * HOUR_MS);
  });

  it("judges each target by its own last success", () => {
    const state: BackupState = {
      version: 1,
      targets: {
        home: { lastAttemptAt: ago(HOUR_MS), lastSuccessAt: ago(HOUR_MS) },
        sessions: { lastAttemptAt: ago(30 * HOUR_MS), lastSuccessAt: ago(30 * HOUR_MS) },
      },
    };

    expect(dueTargets(state, NOW)).toEqual(["sessions", "workflows"]);
  });

  it("retries a failed target after an hour, not on every check", () => {
    const failedAt = (elapsed: number): BackupState => ({
      version: 1,
      targets: {
        home: { lastAttemptAt: ago(elapsed), lastSuccessAt: ago(elapsed) },
        sessions: { lastAttemptAt: ago(elapsed), lastSuccessAt: ago(elapsed) },
        workflows: { lastAttemptAt: ago(elapsed), lastSuccessAt: ago(40 * HOUR_MS), lastError: "disk full" },
      },
    });

    expect(dueTargets(failedAt(RETRY_AFTER_FAILURE_MS - 1), NOW)).toEqual([]);
    expect(dueTargets(failedAt(RETRY_AFTER_FAILURE_MS), NOW)).toEqual(["workflows"]);
    expect(RETRY_AFTER_FAILURE_MS).toBe(HOUR_MS);
  });

  it("does not let a timestamp from the future hold a backup off", () => {
    const tomorrow = new Date(NOW.getTime() + 24 * HOUR_MS).toISOString();
    const state: BackupState = {
      version: 1,
      targets: {
        home: { lastAttemptAt: tomorrow, lastSuccessAt: tomorrow },
        sessions: { lastAttemptAt: tomorrow, lastSuccessAt: ago(48 * HOUR_MS), lastError: "clock jumped" },
        workflows: { lastAttemptAt: "not a date", lastSuccessAt: "not a date" },
      },
    };

    expect(dueTargets(state, NOW)).toEqual(["home", "sessions", "workflows"]);
  });
});

describe("applyRunReport", () => {
  it("counts a written and a skipped target as done, from the moment the run started", () => {
    const next = applyRunReport({ version: 1, targets: {} }, report({ home: "ok", workflows: "skipped" }));

    expect(next.targets).toEqual({
      home: { lastAttemptAt: NOW.toISOString(), lastSuccessAt: NOW.toISOString() },
      workflows: { lastAttemptAt: NOW.toISOString(), lastSuccessAt: NOW.toISOString() },
    });
  });

  it("keeps the last success of a target that failed, and records why", () => {
    const before: BackupState = { version: 1, targets: { home: { lastAttemptAt: ago(30 * HOUR_MS), lastSuccessAt: ago(30 * HOUR_MS) } } };

    const next = applyRunReport(before, report({ home: "failed" }));

    expect(next.targets.home).toEqual({ lastAttemptAt: NOW.toISOString(), lastSuccessAt: ago(30 * HOUR_MS), lastError: "home broke" });
    expect(before.targets.home).toEqual({ lastAttemptAt: ago(30 * HOUR_MS), lastSuccessAt: ago(30 * HOUR_MS) });
  });

  it("clears the recorded error once the target succeeds again", () => {
    const before: BackupState = { version: 1, targets: { home: { lastAttemptAt: ago(HOUR_MS), lastError: "disk full" } } };

    expect(applyRunReport(before, report({ home: "ok" })).targets.home).toEqual({
      lastAttemptAt: NOW.toISOString(), lastSuccessAt: NOW.toISOString(),
    });
  });

  it("leaves targets the run did not touch as they were", () => {
    const before: BackupState = { version: 1, targets: { sessions: { lastAttemptAt: ago(HOUR_MS), lastSuccessAt: ago(HOUR_MS) } } };

    expect(applyRunReport(before, report({ home: "ok" })).targets.sessions).toEqual(before.targets.sessions);
  });
});

describe("mergeStates", () => {
  it("keeps, per target, whichever side attempted most recently", () => {
    const memory: BackupState = {
      version: 1,
      targets: {
        home: { lastAttemptAt: ago(HOUR_MS), lastError: "directory not writable" },
        sessions: { lastAttemptAt: ago(5 * HOUR_MS), lastSuccessAt: ago(5 * HOUR_MS) },
      },
    };
    const disk: BackupState = {
      version: 1,
      targets: {
        home: { lastAttemptAt: ago(3 * HOUR_MS), lastSuccessAt: ago(3 * HOUR_MS) },
        sessions: { lastAttemptAt: ago(2 * HOUR_MS), lastSuccessAt: ago(2 * HOUR_MS) },
        workflows: { lastAttemptAt: ago(2 * HOUR_MS), lastSuccessAt: ago(2 * HOUR_MS) },
      },
    };

    expect(mergeStates(memory, disk).targets).toEqual({
      home: memory.targets.home,
      sessions: disk.targets.sessions,
      workflows: disk.targets.workflows,
    });
  });
});

describe("backup state file", () => {
  it("round-trips through an owner-only file", () => {
    const directory = tempDir();
    const state = applyRunReport({ version: 1, targets: {} }, report({ home: "ok", sessions: "failed" }));

    writeBackupState(directory, state);

    expect(readBackupState(directory)).toEqual(state);
    expectPosixMode(path.join(directory, BACKUP_STATE_FILE), 0o600);
    expect(fs.readdirSync(directory)).toEqual([BACKUP_STATE_FILE]);
  });

  it("reads a missing, corrupt or foreign file as no history at all", () => {
    const directory = tempDir();
    expect(readBackupState(directory)).toEqual({ version: 1, targets: {} });
    expect(readBackupState(path.join(directory, "never-created"))).toEqual({ version: 1, targets: {} });

    for (const contents of ["{ not json", "[]", '{"version":2,"targets":{"home":{}}}', '{"version":1,"targets":"none"}']) {
      fs.writeFileSync(path.join(directory, BACKUP_STATE_FILE), contents);
      expect(readBackupState(directory), contents).toEqual({ version: 1, targets: {} });
    }
  });

  it("drops fields that are not what it wrote", () => {
    const directory = tempDir();
    fs.writeFileSync(path.join(directory, BACKUP_STATE_FILE), JSON.stringify({
      version: 1,
      targets: {
        home: { lastAttemptAt: NOW.toISOString(), lastSuccessAt: 12345, lastError: { nested: true } },
        registry: { lastAttemptAt: NOW.toISOString() },
      },
    }));

    expect(readBackupState(directory)).toEqual({ version: 1, targets: { home: { lastAttemptAt: NOW.toISOString() } } });
  });
});
