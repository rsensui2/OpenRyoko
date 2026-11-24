import { describe, it, expect } from "vitest";
import { ANTIGRAVITY_DEFAULTS, engineConfigFor } from "../engine-config.js";
import type { JinnConfig } from "../types.js";

const base = {
  engines: { default: "claude", claude: { bin: "claude", model: "claude-opus-5-5" }, codex: { bin: "codex", model: "gpt-6-sol" } },
} as unknown as JinnConfig;

describe("engineConfigFor", () => {
  it("runs Antigravity with agy and its default model when config.yaml has no block for it", () => {
    expect(engineConfigFor(base, "antigravity")).toEqual(ANTIGRAVITY_DEFAULTS);
    expect(ANTIGRAVITY_DEFAULTS.bin).toBe("agy");
  });

  it("uses the configured block when there is one", () => {
    const config = { ...base, engines: { ...base.engines, antigravity: { bin: "/opt/agy", model: "gemini-3.8-flash-high" } } } as JinnConfig;
    expect(engineConfigFor(config, "antigravity")).toEqual({ bin: "/opt/agy", model: "gemini-3.8-flash-high" });
  });

  it("fills keys a partial block leaves out from the defaults, so agy is still found", () => {
    const config = { ...base, engines: { ...base.engines, antigravity: { model: "gemini-3.8-flash-high", fallback: ["codex"] } } } as unknown as JinnConfig;
    expect(engineConfigFor(config, "antigravity")).toMatchObject({ bin: "agy", model: "gemini-3.8-flash-high" });
  });

  it("keeps the earlier fallbacks for the other engines", () => {
    expect(engineConfigFor(base, "codex").bin).toBe("codex");
    expect(engineConfigFor(base, "gemini").bin).toBe("claude");
    expect(engineConfigFor(base, undefined).bin).toBe("claude");
  });
});
