import { describe, it, expect } from "vitest";
import { parseAgyModels } from "../antigravity-discovery.js";

describe("parseAgyModels", () => {
  it("reads `agy models` as agy 1.5.14 prints it", () => {
    const output = [
      "Fetching available models...",
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
      "",
    ].join("\n");
    expect(parseAgyModels(output)).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", supportsEffort: false, effortLevels: [] },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", supportsEffort: false, effortLevels: [] },
      { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", supportsEffort: false, effortLevels: [] },
    ]);
  });

  it("finds nothing when agy is not signed in", () => {
    expect(parseAgyModels("Fetching available models...\nError: Please sign in to view available models.\n")).toEqual([]);
  });

  it("skips ids that are not plain model ids", () => {
    expect(parseAgyModels("bad id\tX\n$(rm)\tY\nok-1\t\n")).toEqual([
      { id: "ok-1", label: "ok-1", supportsEffort: false, effortLevels: [] },
    ]);
  });
});
