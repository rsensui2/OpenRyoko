import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearEngineHealth,
  isEngineExhausted,
  onEngineHealthChange,
  readEngineHealth,
  recordEngineUnavailable,
} from "../engine-health.js";
import { JINN_HOME } from "../paths.js";

// vitest.setup.ts gives every test file its own home, so this file is the only
// reader and writer of the store it clears here.
const STATE_PATH = path.join(JINN_HOME, "tmp", "engine-health.json");
const NOW = new Date("2026-10-12T03:00:00.000Z");
const secondsAt = (minutes: number) => (NOW.getTime() + minutes * 60_000) / 1000;

beforeEach(() => fs.rmSync(STATE_PATH, { force: true }));

describe("clearEngineHealth", () => {
  it("forgets the named engine and leaves every other record alone", () => {
    recordEngineUnavailable("claude", "claude usage limit", secondsAt(90), NOW);
    recordEngineUnavailable("codex", "codex usage limit", secondsAt(30), NOW);

    expect(clearEngineHealth("claude")).toBe(true);

    const health = readEngineHealth(NOW);
    expect(health.claude).toBeUndefined();
    expect(isEngineExhausted(health, "claude", NOW)).toBe(false);
    expect(isEngineExhausted(health, "codex", NOW)).toBe(true);
  });

  it("writes nothing when there is no record to forget", () => {
    expect(clearEngineHealth("claude")).toBe(false);
    expect(fs.existsSync(STATE_PATH)).toBe(false);
  });
});

describe("onEngineHealthChange", () => {
  it("tells a listener about every record and every clear, until it unsubscribes", () => {
    const listener = vi.fn();
    const unsubscribe = onEngineHealthChange(listener);

    recordEngineUnavailable("claude", "claude usage limit", secondsAt(90), NOW);
    expect(listener).toHaveBeenCalledTimes(1);
    clearEngineHealth("claude");
    expect(listener).toHaveBeenCalledTimes(2);
    clearEngineHealth("claude"); // nothing left: no write, no notification
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    recordEngineUnavailable("claude", "claude usage limit", secondsAt(90), NOW);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps recording when a listener throws", () => {
    const unsubscribe = onEngineHealthChange(() => { throw new Error("listener blew up"); });
    try {
      expect(() => recordEngineUnavailable("claude", "claude usage limit", secondsAt(90), NOW)).not.toThrow();
      expect(isEngineExhausted(readEngineHealth(NOW), "claude", NOW)).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});
