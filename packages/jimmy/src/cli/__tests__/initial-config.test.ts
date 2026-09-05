import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import yaml from "js-yaml";
import { CONFIG_TEMPLATE_PATH, buildInitialConfig } from "../initial-config.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("initial config generation", () => {
  it("finds the packaged template (regression: lookup used config.yaml, template ships config.default.yaml)", () => {
    expect(fs.existsSync(CONFIG_TEMPLATE_PATH)).toBe(true);
    expect(CONFIG_TEMPLATE_PATH.endsWith("config.default.yaml")).toBe(true);
  });

  it("uses the template so documented defaults (mcp.fetch etc.) actually apply", () => {
    const parsed = yaml.load(buildInitialConfig("claude", "Ryoko")) as any;
    expect(parsed.mcp?.fetch?.enabled).toBe(true);
    expect(parsed.mcp?.browser?.enabled).toBe(true);
    expect(parsed.mcp?.gateway?.enabled).toBe(true);
    expect(parsed.engines?.default).toBe("claude");
    expect(parsed.engines?.claude?.model).toBe("claude-opus-5");
  });

  it("stamps the real package version over the template placeholder", () => {
    const parsed = yaml.load(buildInitialConfig("claude", "Ryoko")) as any;
    expect(parsed.jinn?.version).not.toBe("0.3.0");
    expect(parsed.jinn?.version).toMatch(/^\d{4}\.\d+\.\d+/);
  });

  it("applies interactive choices (engine and portal name)", () => {
    const parsed = yaml.load(buildInitialConfig("codex", "Momo")) as any;
    expect(parsed.engines?.default).toBe("codex");
    expect(parsed.portal?.portalName).toBe("Momo");
  });

  it("keeps hostile names literal — quotes, backslashes, $-patterns must not corrupt the YAML", () => {
    for (const name of ['Ry"oko', "Back\\slash", "A$&B", "$'$`x"]) {
      const parsed = yaml.load(buildInitialConfig("claude", name)) as any;
      expect(parsed.portal?.portalName).toBe(name);
    }
  });

  it("fails loudly when the packaged template is missing (corrupt install)", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(() => buildInitialConfig("claude", "Ryoko")).toThrow(/再インストール/);
  });
});
