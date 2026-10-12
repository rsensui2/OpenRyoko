import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeUsageProbe, engineBinaryInstalled, startEngineHealth, startEngineHealthMonitor, type EngineHealthMonitor, type EngineHealthProbe, type EngineHealthProbeVerdict } from "../engine-health-monitor.js";
import { exhaustedRecordFor, isUsableFallbackTarget } from "../../sessions/engine-health-gate.js";
import type { ClaudeUsageResponse, ClaudeUsageWindow } from "../../shared/claude-usage.js";
import { clearEngineHealth, readEngineHealth, recordEngineUnavailable, type EngineHealth } from "../../shared/engine-health.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { JinnConfig } from "../../shared/types.js";

const STATE_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const START = new Date("2026-10-12T03:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const secondsFromStart = (ms: number) => Math.floor((START.getTime() + ms) / 1000);
const isoFromStart = (ms: number) => new Date(START.getTime() + ms).toISOString();

let monitor: EngineHealthMonitor | undefined;
const verdicts: EngineHealthProbeVerdict[] = [];
/** Minutes after START at which the default probe was asked. */
const askedAtMinute: number[] = [];
const probe = vi.fn<EngineHealthProbe>();
const start = () => { monitor = startEngineHealthMonitor({ probes: { claude: probe } }); };

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  fs.rmSync(STATE_PATH, { force: true });
  verdicts.length = 0;
  askedAtMinute.length = 0;
  probe.mockReset();
  // Answers with the queued verdicts, then "cannot tell".
  probe.mockImplementation(async () => {
    askedAtMinute.push(Math.round((Date.now() - START.getTime()) / MINUTE));
    return verdicts.shift() ?? { kind: "unknown" };
  });
});
afterEach(() => {
  monitor?.stop();
  monitor = undefined;
  vi.useRealTimers();
});

describe("the engine health re-check timer", () => {
  it("arms nothing, and asks nothing, while every engine is healthy", async () => {
    start();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(48 * HOUR);
    expect(probe).not.toHaveBeenCalled();
  });

  it("asks about a stated outage on a doubling backoff, and once more at its re-probe point", async () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsFromStart(3 * 24 * HOUR), new Date(), "7d");
    start();

    await vi.advanceTimersByTimeAsync(13 * HOUR);

    // One minute, doubling to a half-hour cap, twelve times — then the 12h re-probe.
    expect(askedAtMinute).toEqual([1, 3, 7, 15, 31, 61, 91, 121, 151, 181, 211, 241, 720]);
    expect(probe.mock.calls[0][0]).toMatchObject({ state: "exhausted", window: "7d" });
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(probe).toHaveBeenCalledTimes(13);
  });

  it("lets go as soon as the provider shows the allowance open again, long before the window would lapse", async () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsFromStart(3 * 24 * HOUR), new Date(), "7d");
    verdicts.push({ kind: "unknown" }, { kind: "available" });
    start();

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(exhaustedRecordFor("claude", "claude-opus-5")).toBeDefined();

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(askedAtMinute).toEqual([1, 3]);
    expect(readEngineHealth().claude).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  // A usage reading cannot see everything a real turn can (extra usage switched
  // on since, for one), so it may end an outage and never stretch one: past the
  // re-probe point a real turn decides, whatever the reading says.
  it("never stretches an outage on a reading alone", async () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsFromStart(3 * 24 * HOUR), new Date(), "7d");
    probe.mockImplementation(async () => ({ kind: "exhausted", resetsAt: secondsFromStart(5 * 24 * HOUR), window: "7d" }));
    start();

    await vi.advanceTimersByTimeAsync(12 * HOUR - MINUTE);
    expect(exhaustedRecordFor("claude", "claude-opus-5")).toBeDefined();

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(readEngineHealth().claude).toMatchObject({
      state: "exhausted", until: isoFromStart(3 * 24 * HOUR), recheckAt: isoFromStart(12 * HOUR), window: "7d",
    });
    expect(exhaustedRecordFor("claude", "claude-opus-5")).toBeUndefined(); // a real turn may try now
  });

  it("stops asking when a short window lapses on its own", async () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsFromStart(5 * HOUR), new Date(), "5h");
    start();

    await vi.advanceTimersByTimeAsync(8 * HOUR);

    expect(askedAtMinute).toEqual([1, 3, 7, 15, 31, 61, 91, 121, 151, 181, 211, 241]);
    expect(readEngineHealth().claude?.state).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start over when sessions keep failing against the same outage", async () => {
    const reset = secondsFromStart(3 * 24 * HOUR);
    recordEngineUnavailable("claude", "claude usage limit", reset, new Date(), "7d");
    start();

    for (let minute = 1; minute <= 40; minute++) {
      await vi.advanceTimersByTimeAsync(MINUTE);
      if (minute % 5 === 0) recordEngineUnavailable("claude", "claude usage limit", reset, new Date(), "7d");
    }

    expect(askedAtMinute).toEqual([1, 3, 7, 15, 31]);
  });

  it("follows a limit recorded after it started, and drops the re-check when the record is forgotten", async () => {
    start();
    recordEngineUnavailable("claude", "claude usage limit", secondsFromStart(3 * 24 * HOUR), new Date(), "7d");
    expect(vi.getTimerCount()).toBe(1);

    clearEngineHealth("claude");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(probe).not.toHaveBeenCalled();
  });

  it("re-checks at once a record it finds overdue when the gateway comes back up", async () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsFromStart(3 * 24 * HOUR), new Date(), "7d");
    vi.setSystemTime(START.getTime() + 13 * HOUR);
    verdicts.push({ kind: "available" });
    start();

    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(readEngineHealth().claude).toBeUndefined();
  });

  it("ignores an engine it has no way to ask", async () => {
    recordEngineUnavailable("codex", "codex usage limit", secondsFromStart(3 * 24 * HOUR));
    start();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(probe).not.toHaveBeenCalled();
  });

  it("treats a probe that throws as one that could not tell", async () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsFromStart(3 * 24 * HOUR), new Date(), "7d");
    probe.mockRejectedValueOnce(new Error("probe exploded"));
    start();

    await vi.advanceTimersByTimeAsync(4 * MINUTE);

    expect(probe).toHaveBeenCalledTimes(2); // minute 1 threw; minute 3 was still asked
    expect(readEngineHealth().claude).toMatchObject({ state: "exhausted", until: isoFromStart(3 * 24 * HOUR) });
  });
});

describe("a limit the engine declared without naming a reset", () => {
  /** A session fails against the same limit again, as it would every few minutes. */
  const failAgain = () => recordEngineUnavailable("claude", "claude usage limit", undefined);

  it("is asked about on the same backoff, capped at half an hour and at twelve attempts", async () => {
    failAgain();
    start();

    for (let minute = 1; minute <= 8 * 60; minute++) {
      await vi.advanceTimersByTimeAsync(MINUTE);
      if (minute % 10 === 0) failAgain();
    }

    expect(askedAtMinute).toEqual([1, 3, 7, 15, 31, 61, 91, 121, 151, 181, 211, 241]);
  });

  it("becomes a known outage as soon as the provider states the reset", async () => {
    failAgain();
    verdicts.push({ kind: "unknown" }, { kind: "exhausted", resetsAt: secondsFromStart(2 * HOUR), window: "5h" });
    start();
    expect(exhaustedRecordFor("claude", "claude-opus-5")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(3 * MINUTE);

    expect(askedAtMinute).toEqual([1, 3]);
    expect(readEngineHealth().claude).toMatchObject({ state: "exhausted", until: isoFromStart(2 * HOUR), window: "5h" });
    expect(exhaustedRecordFor("claude", "claude-opus-5")).toBeDefined();
  });

  it("stops being asked about once sessions stop failing against it", async () => {
    failAgain(); // never repeated: the note lapses fifteen minutes later
    start();

    await vi.advanceTimersByTimeAsync(4 * HOUR);

    expect(askedAtMinute).toEqual([1, 3, 7]); // gone before minute 15
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is not asked about again once the provider shows no spent window", async () => {
    failAgain();
    verdicts.push({ kind: "available" });
    start();

    for (let minute = 1; minute <= 120; minute++) {
      await vi.advanceTimersByTimeAsync(MINUTE);
      if (minute % 10 === 0) failAgain();
    }

    expect(askedAtMinute).toEqual([1]);
  });

  it.each([
    ["some other observer wrote", "provider outage"],
    ["only reads like a limit, without the engine declaring one", "claude rate limited"],
  ])("leaves a note that %s alone", async (_label, reason) => {
    recordEngineUnavailable("claude", reason, undefined);
    start();

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(probe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("stopping the timer", () => {
  it("cancels a pending re-check", async () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsFromStart(3 * 24 * HOUR), new Date(), "7d");
    start();
    expect(vi.getTimerCount()).toBe(1);

    monitor!.stop();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(probe).not.toHaveBeenCalled();
  });

  it("no longer follows the store, and ignores a probe that answers after the stop", async () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsFromStart(3 * 24 * HOUR), new Date(), "7d");
    let answer!: (verdict: EngineHealthProbeVerdict) => void;
    probe.mockImplementationOnce(() => new Promise<EngineHealthProbeVerdict>((resolve) => { answer = resolve; }));
    start();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(probe).toHaveBeenCalledTimes(1);

    monitor!.stop();
    answer({ kind: "available" });
    await vi.advanceTimersByTimeAsync(0);

    expect(readEngineHealth().claude).toMatchObject({ state: "exhausted" });
    recordEngineUnavailable("claude", "claude usage limit", secondsFromStart(4 * 24 * HOUR), new Date(), "7d");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("startEngineHealth — what the gateway owns for its lifetime", () => {
  const config = { engines: { default: "claude", claude: { bin: process.execPath, model: "m" },
    codex: { bin: "ryoko-no-such-engine-binary", model: "m" } }, connectors: {} } as unknown as JinnConfig;

  it("lets the session layer see which engine binaries are installed, until shutdown", () => {
    const stop = startEngineHealth();
    try {
      expect(isUsableFallbackTarget(config, "claude", "m")).toBe(true);
      expect(isUsableFallbackTarget(config, "codex", "m")).toBe(false);
    } finally {
      stop();
    }
    expect(isUsableFallbackTarget(config, "codex", "m")).toBe(true);
  });

  it("rules a binary out only when the lookup can actually know it is missing", () => {
    expect(engineBinaryInstalled(process.execPath)).toBe(true);
    expect(engineBinaryInstalled("ryoko-no-such-engine-binary")).toBe(false);
    expect(engineBinaryInstalled(path.join(JINN_HOME, "no-such-dir", "codex"))).toBe(false);
    // Resolved by the spawn against its own cwd, which this lookup cannot see.
    expect(engineBinaryInstalled("./node_modules/.bin/codex")).toBe(true);
  });

  it("runs no timer while every engine is healthy, and leaves none behind on shutdown", () => {
    const stop = startEngineHealth();
    expect(vi.getTimerCount()).toBe(0);
    recordEngineUnavailable("claude", "claude usage limit", secondsFromStart(3 * 24 * HOUR), new Date(), "7d");
    expect(vi.getTimerCount()).toBe(1);

    stop();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("claudeUsageProbe", () => {
  const window = (name: string, usedPercent: number, resetsAt?: number): ClaudeUsageWindow => ({ name, usedPercent, resetsAt });
  const usage = (windows: ClaudeUsageWindow[], available = true): ClaudeUsageResponse =>
    ({ available, source: "claude-oauth-usage", refreshedAt: START.toISOString(), windows });
  const record = (windowName?: string): EngineHealth =>
    ({ state: "exhausted", until: isoFromStart(3 * 24 * HOUR), ...(windowName ? { window: windowName } : {}) });
  const ask = (windows: ClaudeUsageWindow[], windowName?: string, available = true) =>
    claudeUsageProbe(async () => usage(windows, available))(record(windowName), START);

  it("cannot tell when the usage source is unavailable", async () => {
    await expect(ask([], "7d", false)).resolves.toEqual({ kind: "unknown" });
  });

  it("finds the engine available when no shared window is spent", async () => {
    await expect(ask([window("5h", 12, secondsFromStart(HOUR)), window("7d", 80, secondsFromStart(48 * HOUR))], "7d"))
      .resolves.toEqual({ kind: "available" });
  });

  it("states the reset of the window that is still spent", async () => {
    const reset = secondsFromStart(48 * HOUR);
    await expect(ask([window("5h", 12, secondsFromStart(HOUR)), window("7d", 100, reset)], "7d"))
      .resolves.toEqual({ kind: "exhausted", resetsAt: reset, window: "7d" });
  });

  it("cannot tell when a window is spent but states no reset still ahead", async () => {
    await expect(ask([window("5h", 100), window("7d", 30, secondsFromStart(48 * HOUR))], "5h")).resolves.toEqual({ kind: "unknown" });
    await expect(ask([window("7d", 100, secondsFromStart(-HOUR))], "7d")).resolves.toEqual({ kind: "unknown" });
  });

  it("answers for the scoped window the record names, and for no other model's", async () => {
    const reset = secondsFromStart(48 * HOUR);
    const windows = [window("7d", 40, reset), window("7d Fable", 100, reset), window("7d Opus", 100, reset)];
    await expect(ask(windows, "7d Fable")).resolves.toEqual({ kind: "exhausted", resetsAt: reset, window: "7d Fable" });
    await expect(ask([window("7d", 40, reset), window("7d Opus", 100, reset)], "7d Fable")).resolves.toEqual({ kind: "available" });
    await expect(ask(windows)).resolves.toEqual({ kind: "available" });
  });
});
