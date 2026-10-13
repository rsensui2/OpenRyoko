import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetEngineFallbackConfigWarnings,
  engineFallbackConfigProblems,
  resolveFallbackEngine,
  warnEngineFallbackConfigProblems,
} from "../engine-fallback.js";
import type { JinnConfig } from "../types.js";

/** A config as `yaml.load` hands it over: whatever the file said, unchecked. */
function configWith(engines: Record<string, unknown>): JinnConfig {
  return { engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt" }, ...engines },
    connectors: {} } as unknown as JinnConfig;
}

beforeEach(() => _resetEngineFallbackConfigWarnings());

describe("engineFallbackConfigProblems", () => {
  it("finds nothing wrong with chains and maps that are well formed, or absent", () => {
    expect(engineFallbackConfigProblems(configWith({}))).toEqual([]);
    expect(engineFallbackConfigProblems(configWith({
      claude: { bin: "claude", model: "opus", fallback: ["codex"], fallbackModelMap: { opus: "gpt" } },
      codex: { bin: "codex", model: "gpt", fallback: [] },
    }))).toEqual([]);
  });

  it("names a chain that is not a list, names itself, or names an engine that does not exist", () => {
    const problems = engineFallbackConfigProblems(configWith({
      claude: { bin: "claude", model: "opus", fallback: "codex" },
      codex: { bin: "codex", model: "gpt", fallback: ["codex", "codexx"] },
    }));

    expect(problems).toEqual([
      "engines.claude.fallback must be a list of engine names (got string)",
      "engines.codex.fallback must not name codex itself",
      'engines.codex.fallback[1] "codexx" is not a known engine (claude, codex, gemini)',
    ]);
  });

  it("names a model map that is not a mapping, or maps to something that is not a model id", () => {
    const problems = engineFallbackConfigProblems(configWith({
      claude: { bin: "claude", model: "opus", fallbackModelMap: ["gpt"] },
      codex: { bin: "codex", model: "gpt", fallbackModelMap: { gpt: 5 } },
    }));

    expect(problems).toEqual([
      "engines.claude.fallbackModelMap must be a mapping of model id to model id (got array)",
      'engines.codex.fallbackModelMap["gpt"] must be a nonempty model id (got number)',
    ]);
  });

  it("answers with nothing, rather than throwing, for a config with no usable engines block", () => {
    expect(engineFallbackConfigProblems({ connectors: {} } as unknown as JinnConfig)).toEqual([]);
    expect(engineFallbackConfigProblems({ engines: null } as unknown as JinnConfig)).toEqual([]);
    expect(engineFallbackConfigProblems({ engines: "claude" } as unknown as JinnConfig)).toEqual([]);
  });
});

describe("warnEngineFallbackConfigProblems", () => {
  const broken = () => configWith({ claude: { bin: "claude", model: "opus", fallback: "codex" } });

  it("says each problem once, however often the same config is loaded", () => {
    const warn = vi.fn();

    warnEngineFallbackConfigProblems(broken(), warn);
    warnEngineFallbackConfigProblems(broken(), warn);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("engines.claude.fallback must be a list of engine names (got string)");
  });

  it("speaks up again for a problem it has not mentioned yet, and says nothing about a sound config", () => {
    const warn = vi.fn();
    warnEngineFallbackConfigProblems(configWith({}), warn);
    expect(warn).not.toHaveBeenCalled();

    warnEngineFallbackConfigProblems(broken(), warn);
    warnEngineFallbackConfigProblems(configWith({ codex: { bin: "codex", model: "gpt", fallback: ["codex"] } }), warn);

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("never throws, whatever the config or the logger does", () => {
    expect(() => warnEngineFallbackConfigProblems({ engines: 7 } as unknown as JinnConfig, vi.fn())).not.toThrow();
    expect(() => warnEngineFallbackConfigProblems(broken(), () => { throw new Error("logger down"); })).not.toThrow();
  });
});

describe("resolveFallbackEngine — a chain that is not a list", () => {
  it.each([["a string", "codex"], ["a number", 5], ["a mapping", { codex: true }], ["null", null]])(
    "treats %s as no chain at all instead of throwing mid-turn", (_label, fallback) => {
      const config = configWith({ claude: { bin: "claude", model: "opus", fallback } });

      expect(resolveFallbackEngine(config, "claude", () => true)).toBeNull();
    });

  it("still walks a well-formed chain", () => {
    expect(resolveFallbackEngine(configWith({ claude: { bin: "claude", model: "opus", fallback: ["codex"] } }), "claude", () => true)).toBe("codex");
  });
});
