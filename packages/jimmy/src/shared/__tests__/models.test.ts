import { describe, it, expect, beforeEach } from "vitest";
import type { JinnConfig } from "../types.js";
import { getModelRegistry, invalidateModelRegistry, synthesizeFromEngineConfig, effortLevelsForModel, contextWindowForModel } from "../models.js";

function cfg(partial: Partial<JinnConfig["engines"]>, models?: JinnConfig["models"]): JinnConfig {
  return {
    gateway: { port: 7777, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.3-codex" },
      ...partial,
    },
    models,
    connectors: {},
  } as JinnConfig;
}

beforeEach(() => invalidateModelRegistry());

describe("synthesizeFromEngineConfig (backward-compat fallback)", () => {
  it("builds an entry per engine from engines.<name>.model", () => {
    const reg = synthesizeFromEngineConfig(cfg({}));
    expect(reg.claude.models[0].id).toBe("opus");
    expect(reg.claude.defaultModel).toBe("opus");
    expect(reg.codex.models[0].id).toBe("gpt-5.3-codex");
    expect(reg.gemini.models[0].id).toBe("gemini-2.5-pro");
  });

  it("uses per-engine effort semantics: claude flag (low/med/high/xhigh), codex config (incl xhigh), gemini none", () => {
    const reg = synthesizeFromEngineConfig(cfg({}));
    expect(reg.claude.effortMechanism).toBe("claude-flag");
    expect(reg.claude.models[0].effortLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(reg.codex.effortMechanism).toBe("codex-config");
    expect(reg.codex.models[0].effortLevels).toContain("xhigh");
    expect(reg.gemini.effortMechanism).toBe("none");
    expect(reg.gemini.models[0].supportsEffort).toBe(false);
    expect(reg.gemini.models[0].effortLevels).toEqual([]);
  });

  it("grants xhigh only to xhigh-capable claude models", () => {
    const levelsFor = (model: string) =>
      synthesizeFromEngineConfig(cfg({ claude: { bin: "claude", model } })).claude.models[0].effortLevels;

    // aliases resolve to latest → xhigh
    expect(levelsFor("opus")).toContain("xhigh");
    expect(levelsFor("sonnet")).toContain("xhigh");
    // explicit capable ids
    expect(levelsFor("claude-opus-5")).toContain("xhigh");
    expect(levelsFor("claude-opus-4-8")).toContain("xhigh");
    expect(levelsFor("claude-opus-4-7")).toContain("xhigh");
    expect(levelsFor("claude-sonnet-5")).toContain("xhigh");

    // haiku and older pinned ids → no xhigh (clamped by resolveEffort)
    expect(levelsFor("haiku")).toEqual(["low", "medium", "high"]);
    expect(levelsFor("claude-haiku-4-5")).toEqual(["low", "medium", "high"]);
    expect(levelsFor("claude-opus-4-6")).toEqual(["low", "medium", "high"]);
    expect(levelsFor("claude-sonnet-4-6")).toEqual(["low", "medium", "high"]);
  });
});

describe("getModelRegistry with a models: block", () => {
  const models: JinnConfig["models"] = {
    claude: {
      default: "claude-opus-4-8",
      effortMechanism: "claude-flag",
      models: [
        { id: "claude-opus-4-8", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "claude-sonnet-4-6", label: "Sonnet 4.6", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
    codex: {
      default: "gpt-5.3-codex",
      models: [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] }],
    },
    gemini: {
      models: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", supportsEffort: false, effortLevels: [] }],
    },
  };

  it("honors the configured models, labels, and effort levels", () => {
    const reg = getModelRegistry(cfg({}, models));
    expect(reg.claude.models.map((m) => m.id)).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(reg.claude.models[0].label).toBe("Opus 4.8");
    expect(reg.codex.models[0].effortLevels).toContain("xhigh");
    expect(reg.gemini.models[0].supportsEffort).toBe(false);
  });

  it("resolves defaultModel from block.default, else the first model", () => {
    const reg = getModelRegistry(cfg({}, models));
    expect(reg.claude.defaultModel).toBe("claude-opus-4-8");
    expect(reg.gemini.defaultModel).toBe("gemini-2.5-pro"); // no default → first
  });
});

describe("effortLevelsForModel / contextWindowForModel (explicit modelId)", () => {
  const models: JinnConfig["models"] = {
    claude: {
      default: "opus",
      models: [
        { id: "opus", supportsEffort: true, effortLevels: ["low", "medium", "high"], contextWindow: 200000 },
        { id: "sonnet", supportsEffort: true, effortLevels: ["low", "medium"], contextWindow: 1000000 },
      ],
    },
  };

  it("selects the named model's levels, not the default", () => {
    expect(effortLevelsForModel(cfg({}, models), "claude", "sonnet")).toEqual(["low", "medium"]);
  });

  it("returns a fresh copy (caller cannot mutate the cached array)", () => {
    const a = effortLevelsForModel(cfg({}, models), "claude", "opus");
    a.push("ultra");
    expect(effortLevelsForModel(cfg({}, models), "claude", "opus")).toEqual(["low", "medium", "high"]);
  });

  it("reads the context window for a named model", () => {
    expect(contextWindowForModel(cfg({}, models), "claude", "sonnet")).toBe(1000000);
  });

  it("contextWindow is undefined when unknown (synthesized entry)", () => {
    expect(contextWindowForModel(cfg({}), "claude")).toBeUndefined();
  });
});

describe("cache + invalidate", () => {
  it("caches across calls and refreshes only after invalidate", () => {
    const a = getModelRegistry(cfg({}));
    const b = getModelRegistry(cfg({ claude: { bin: "claude", model: "CHANGED" } }));
    expect(b).toBe(a); // cached — ignores the new config until invalidated
    invalidateModelRegistry();
    const c = getModelRegistry(cfg({ claude: { bin: "claude", model: "CHANGED" } }));
    expect(c.claude.models[0].id).toBe("CHANGED");
  });
});
