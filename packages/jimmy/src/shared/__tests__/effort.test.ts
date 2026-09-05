import { describe, it, expect, beforeEach } from "vitest";
import { resolveEffort } from "../effort.js";
import { effortLevelsForModel, invalidateModelRegistry } from "../models.js";
import type { JinnConfig } from "../types.js";

const CLAUDE = ["low", "medium", "high", "xhigh"];
const CODEX = ["low", "medium", "high", "xhigh"];

describe("resolveEffort (registry-driven validation)", () => {
  it("preserves Astra max effort for both engine defaults and child overrides", () => {
    const levels = ["low", "medium", "high", "xhigh", "max"];
    expect(resolveEffort({ effortLevel: "max" }, { parentSessionId: null, effortLevel: null }, null, levels)).toBe("max");
    expect(resolveEffort({}, { parentSessionId: "parent", effortLevel: "max" }, null, levels)).toBe("max");
  });

  it("passes through codex xhigh (the previously silently-dropped level)", () => {
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "xhigh" }, null, CODEX)).toBe("xhigh");
  });

  it("passes through claude xhigh (now supported on Opus 4.7+/Sonnet 5)", () => {
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "xhigh" }, null, CLAUDE)).toBe("xhigh");
  });

  it("rejects a level outside the valid set and falls back to medium", () => {
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "max" }, null, CLAUDE)).toBe("medium");
  });

  it("claude still accepts low/medium/high", () => {
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "low" }, null, CLAUDE)).toBe("low");
    expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "high" }, null, CLAUDE)).toBe("high");
  });

  it("drops an unknown level and defaults (graceful degradation, no throw)", () => {
    expect(resolveEffort({ effortLevel: "ultra" }, { parentSessionId: null, effortLevel: null }, null, CLAUDE)).toBe("medium");
  });

  it("returns medium without warning when the engine has no effort concept (empty levels)", () => {
    expect(resolveEffort({ effortLevel: "high" }, { parentSessionId: "p", effortLevel: "high" }, null, [])).toBe("medium");
  });

  describe("child-effort resolution chain", () => {
    it("childEffortOverride wins over everything", () => {
      expect(resolveEffort(
        { childEffortOverride: "low" },
        { parentSessionId: "p", effortLevel: "high" },
        { effortLevel: "medium" },
        CLAUDE,
      )).toBe("low");
    });
    it("session beats employee", () => {
      expect(resolveEffort({}, { parentSessionId: "p", effortLevel: "high" }, { effortLevel: "low" }, CLAUDE)).toBe("high");
    });
    it("employee default when no session level", () => {
      expect(resolveEffort({}, { parentSessionId: "p", effortLevel: null }, { effortLevel: "low" }, CLAUDE)).toBe("low");
    });
    it("skips an invalid override and continues down the chain", () => {
      expect(resolveEffort(
        { childEffortOverride: "ultra" },
        { parentSessionId: "p", effortLevel: "high" },
        null,
        CLAUDE,
      )).toBe("high");
    });
  });

  it("non-child sessions use the engine default directly", () => {
    expect(resolveEffort({ effortLevel: "high" }, { parentSessionId: null, effortLevel: "low" }, { effortLevel: "low" }, CLAUDE)).toBe("high");
  });
});

describe("effortLevelsForModel (registry lookup)", () => {
  function cfg(): JinnConfig {
    return {
      gateway: { port: 7777, host: "127.0.0.1" },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.4" },
        gemini: { bin: "gemini", model: "gemini-2.5-pro" },
      },
      models: {
        claude: { default: "opus", models: [{ id: "opus", supportsEffort: true, effortLevels: CLAUDE }] },
        codex: { default: "gpt-5.4", models: [{ id: "gpt-5.4", supportsEffort: true, effortLevels: CODEX }] },
        gemini: { models: [{ id: "gemini-2.5-pro", supportsEffort: false, effortLevels: [] }] },
      },
      connectors: {},
    } as unknown as JinnConfig;
  }
  beforeEach(() => invalidateModelRegistry());

  it("returns codex levels including xhigh", () => {
    expect(effortLevelsForModel(cfg(), "codex")).toContain("xhigh");
  });
  it("returns [] for gemini (no effort support)", () => {
    expect(effortLevelsForModel(cfg(), "gemini")).toEqual([]);
  });
  it("returns [] for an unknown engine", () => {
    expect(effortLevelsForModel(cfg(), "nope")).toEqual([]);
  });
  it("returns claude levels for its default model", () => {
    expect(effortLevelsForModel(cfg(), "claude")).toEqual(CLAUDE);
  });
});
