import { describe, it, expect } from "vitest";
import fs from "node:fs";
import yaml from "js-yaml";
import { CONFIG_TEMPLATE_PATH } from "../../cli/initial-config.js";
import { patchPortalSection } from "../portal-config.js";

const countCommentLines = (s: string) =>
  s.split("\n").filter((l) => l.trim().startsWith("#")).length;

describe("patchPortalSection", () => {
  it("updates the portal block in the shipped template WITHOUT touching its comments (regression: yaml.dump stripped all 50+ guidance comments)", () => {
    const raw = fs.readFileSync(CONFIG_TEMPLATE_PATH, "utf-8");
    const patched = patchPortalSection(raw, {
      portalName: "Momo",
      language: "Japanese",
      onboarded: true,
    });

    expect(countCommentLines(patched)).toBe(countCommentLines(raw));

    const parsed = yaml.load(patched) as any;
    expect(parsed.portal).toEqual({ portalName: "Momo", language: "Japanese", onboarded: true });
    // Everything outside portal is untouched
    expect(parsed.engines?.claude?.model).toBe("claude-opus-5");
    expect(parsed.mcp?.fetch?.enabled).toBe(true);
    expect(parsed.logging?.level).toBe("info");
  });

  it("replaces the inline `portal: {}` form", () => {
    const raw = "gateway:\n  port: 7777\nportal: {}\nlogging:\n  level: info\n";
    const parsed = yaml.load(patchPortalSection(raw, { portalName: "Momo" })) as any;
    expect(parsed.portal).toEqual({ portalName: "Momo" });
    expect(parsed.logging.level).toBe("info");
  });

  it("appends a portal block when none exists", () => {
    const raw = "gateway:\n  port: 7777\n";
    const parsed = yaml.load(patchPortalSection(raw, { onboarded: true })) as any;
    expect(parsed.portal).toEqual({ onboarded: true });
    expect(parsed.gateway.port).toBe(7777);
  });

  it("handles a portal block at end of file and quotes hostile values", () => {
    const raw = "gateway:\n  port: 7777\n\nportal:\n  portalName: Old\n";
    const patched = patchPortalSection(raw, { portalName: 'Ry"oko: yes' });
    const parsed = yaml.load(patched) as any;
    expect(parsed.portal.portalName).toBe('Ry"oko: yes');
  });

  it("drops undefined values instead of serializing them", () => {
    const raw = "portal: {}\n";
    const parsed = yaml.load(
      patchPortalSection(raw, { onboarded: true, portalName: undefined }),
    ) as any;
    expect(parsed.portal).toEqual({ onboarded: true });
  });
});
