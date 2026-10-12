import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  engineHealthForStatus,
  exhaustedRecordFor,
  isUsableFallbackTarget,
  noteEngineTurnOutcome,
  setEngineInstallProbe,
  usageLimitReason,
} from "../engine-health-gate.js";
import { readEngineHealth, recordEngineUnavailable } from "../../shared/engine-health.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineResult, JinnConfig } from "../../shared/types.js";

const STATE_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const NOW = new Date("2026-10-12T03:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const secondsAt = (minutes: number) => at(minutes).getTime() / 1000;

const limited = (rateLimit: EngineResult["rateLimit"] = { status: "rejected" }): EngineResult =>
  ({ sessionId: "s", result: "", error: "Interactive turn failed: rate_limit", numTurns: 1, rateLimit });
const answered = (result = "Done."): EngineResult => ({ sessionId: "s", result });

const config = { engines: { default: "claude", claude: { bin: "claude-bin", model: "claude-opus-5" },
  codex: { bin: "codex-bin", model: "gpt-5.6-sol" } }, connectors: {} } as unknown as JinnConfig;

beforeEach(() => fs.rmSync(STATE_PATH, { force: true }));
afterEach(() => setEngineInstallProbe(undefined));

describe("noteEngineTurnOutcome — a turn that hit a usage limit", () => {
  it("records the engine as out until the reset it stated, with the window that bound it", () => {
    noteEngineTurnOutcome("claude", limited({ status: "rejected", resetsAt: secondsAt(30), window: "5h" }), "claude-opus-5", NOW);

    expect(readEngineHealth(NOW).claude).toEqual({
      state: "exhausted", until: at(30).toISOString(), recheckAt: at(30).toISOString(),
      window: "5h", reason: "claude usage limit", observedAt: NOW.toISOString(),
    });
    expect(exhaustedRecordFor("claude", "claude-opus-5", NOW)).toMatchObject({ state: "exhausted" });
  });

  it("re-probes a multi-day reset after twelve hours while still showing the true reset", () => {
    noteEngineTurnOutcome("claude", limited({ status: "rejected", resetsAt: secondsAt(3 * 24 * 60), window: "7d" }), "claude-opus-5", NOW);

    expect(readEngineHealth(NOW).claude).toMatchObject({ until: at(3 * 24 * 60).toISOString(), recheckAt: at(12 * 60).toISOString() });
    expect(exhaustedRecordFor("claude", "claude-opus-5", at(12 * 60 - 1))).toBeDefined();
    expect(exhaustedRecordFor("claude", "claude-opus-5", at(12 * 60))).toBeUndefined();
  });

  it("does not treat a limit that named no reset as a known outage", () => {
    noteEngineTurnOutcome("codex", { sessionId: "s", result: "", error: "Usage limit reached" }, "gpt-5.6-sol", NOW);

    expect(readEngineHealth(NOW).codex?.state).toBe("degraded");
    expect(exhaustedRecordFor("codex", "gpt-5.6-sol", NOW)).toBeUndefined();
  });

  it("does not take a routine window reading for the reset of a failure that only reads like a limit", () => {
    // `claude -p` attaches the current window to every result. An error whose
    // text happens to match is not the engine declaring its allowance spent.
    noteEngineTurnOutcome("claude", { sessionId: "s", result: "", error: "Request exceeded the context limit",
      rateLimit: { status: "allowed", resetsAt: secondsAt(240) } }, "claude-opus-5", NOW);

    expect(readEngineHealth(NOW).claude?.state).toBe("degraded");
    expect(exhaustedRecordFor("claude", "claude-opus-5", NOW)).toBeUndefined();
  });

  it("tells a limit the engine declared apart from one it only read off the error text", () => {
    noteEngineTurnOutcome("claude", limited({ status: "rejected" }), "claude-opus-5", NOW);
    noteEngineTurnOutcome("codex", { sessionId: "s", result: "", error: "429 Too Many Requests" }, "gpt-5.6-sol", NOW);

    expect(readEngineHealth(NOW).claude?.reason).toBe(usageLimitReason("claude"));
    expect(readEngineHealth(NOW).codex?.reason).not.toBe(usageLimitReason("codex"));
  });

  it("does not believe a reset that is already behind us", () => {
    noteEngineTurnOutcome("claude", limited({ status: "rejected", resetsAt: secondsAt(-5) }), "claude-opus-5", NOW);

    expect(exhaustedRecordFor("claude", "claude-opus-5", NOW)).toBeUndefined();
  });

  it("holds a model-scoped window against that model family only", () => {
    noteEngineTurnOutcome("claude", limited({ status: "rejected", resetsAt: secondsAt(600), window: "7d Fable" }), "claude-fable-5-1", NOW);

    expect(exhaustedRecordFor("claude", "claude-fable-5-1", NOW)).toMatchObject({ window: "7d Fable" });
    expect(exhaustedRecordFor("claude", "claude-opus-5", NOW)).toBeUndefined();
  });
});

describe("noteEngineTurnOutcome — a turn that was served", () => {
  it("forgets the record, because the engine just proved it can serve", () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsAt(90), NOW, "5h");

    noteEngineTurnOutcome("claude", answered(), "claude-opus-5", NOW);

    expect(readEngineHealth(NOW).claude).toBeUndefined();
  });

  it("keeps a scoped record when a different model family answered", () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsAt(600), NOW, "7d Fable");

    noteEngineTurnOutcome("claude", answered(), "claude-opus-5", NOW);

    expect(exhaustedRecordFor("claude", "claude-fable-5-1", NOW)).toBeDefined();
  });

  it.each([
    ["an empty answer", { sessionId: "s", result: "  " }],
    ["a native command that owes no answer", { sessionId: "s", result: "", responseExpected: false as const }],
    ["an unrelated failure", { sessionId: "s", result: "", error: "Engine response timeout" }],
    ["an interrupted turn", { sessionId: "s", result: "", error: "Interrupted: stopped", retryable: false as const }],
  ])("leaves the record alone after %s", (_label, result) => {
    recordEngineUnavailable("claude", "claude usage limit", secondsAt(90), NOW, "5h");

    noteEngineTurnOutcome("claude", result, "claude-opus-5", NOW);

    expect(exhaustedRecordFor("claude", "claude-opus-5", NOW)).toBeDefined();
  });
});

describe("isUsableFallbackTarget", () => {
  it("accepts an engine nothing is known about", () => {
    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", NOW)).toBe(true);
  });

  it("refuses an engine known to be out of allowance, until its window reopens", () => {
    recordEngineUnavailable("codex", "codex usage limit", secondsAt(60), NOW);

    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", NOW)).toBe(false);
    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", at(61))).toBe(true);
  });

  it("refuses an engine whose binary is known to be missing", () => {
    setEngineInstallProbe((bin) => bin !== "codex-bin");

    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", NOW)).toBe(false);
    expect(isUsableFallbackTarget(config, "claude", "claude-opus-5", NOW)).toBe(true);
  });

  it("never refuses on installation while nobody has wired a probe, or when the probe fails", () => {
    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", NOW)).toBe(true);
    setEngineInstallProbe(() => { throw new Error("PATH unreadable"); });
    expect(isUsableFallbackTarget(config, "codex", "gpt-5.6-sol", NOW)).toBe(true);
  });
});

describe("engineHealthForStatus", () => {
  it("reports ok for an engine nothing has been observed on", () => {
    expect(engineHealthForStatus(NOW)("claude")).toEqual({ state: "ok" });
  });

  it("reports the state, the stated reset and the next re-check, and nothing else", () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsAt(3 * 24 * 60), NOW, "7d");

    expect(engineHealthForStatus(NOW)("claude")).toEqual({
      state: "exhausted", until: at(3 * 24 * 60).toISOString(), recheckAt: at(12 * 60).toISOString(),
    });
  });

  it("reads a record whose window has passed back as ok", () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsAt(30), NOW, "5h");

    expect(engineHealthForStatus(at(31))("claude")).toEqual({ state: "ok" });
  });
});
