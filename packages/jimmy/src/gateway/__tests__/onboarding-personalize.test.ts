import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import {
  personalizeInstructionMd,
  personalizeIdentityMd,
  resolveEffectiveName,
} from "../onboarding-personalize.js";

function renderedTemplate(filename: string): string {
  const raw = fs.readFileSync(path.join(TEMPLATE_DIR, filename), "utf-8");
  return raw.replaceAll("{{portalName}}", "Ryoko").replaceAll("{{portalSlug}}", "ryoko");
}

describe("Web onboarding name personalization", () => {
  it("renames the identity line of the shipped Japanese CLAUDE.md (regression: regex only knew the English upstream form)", () => {
    const md = personalizeInstructionMd(renderedTemplate("CLAUDE.md"), "Momo");
    expect(md).toContain("あなたは **Momo**");
    expect(md).not.toContain("あなたは **Ryoko**");
    expect(md).toContain("# Momo — 運用指示書");
  });

  it("renames the shipped Japanese AGENTS.md the same way", () => {
    const md = personalizeInstructionMd(renderedTemplate("AGENTS.md"), "Momo");
    expect(md).toContain("あなたは **Momo**");
    expect(md).not.toContain("あなたは **Ryoko**");
  });

  it("still handles the upstream English forms", () => {
    const en = [
      "You are Jinn, the COO of the user's AI organization.",
      "",
      "Intro: You are **Jinn** — a personal AI assistant.",
    ].join("\n");
    const md = personalizeInstructionMd(en, "Momo");
    expect(md).toContain("You are Momo, the COO of the user's AI organization.");
    expect(md).toContain("You are **Momo**");
  });

  it("survives a name containing an em dash across repeated renames", () => {
    const once = personalizeInstructionMd(renderedTemplate("CLAUDE.md"), "Ryo — ko");
    expect(once).toContain("# Ryo — ko — 運用指示書");
    const twice = personalizeInstructionMd(once, "Neo");
    expect(twice).toContain("# Neo — 運用指示書");
    expect(twice).not.toContain("Ryo — ko — 運用指示書");
  });

  it("syncs the IDENTITY.md Name section", () => {
    const md = personalizeIdentityMd(renderedTemplate("IDENTITY.md"), "Momo");
    expect(md).toContain("# IDENTITY — Momo");
    expect(md).toMatch(/## Name\nMomo/);
  });

  it("handles an agent-reformatted IDENTITY.md with a blank line under ## Name", () => {
    const md = personalizeIdentityMd("# IDENTITY — Momo\n\n## Name\n\nMomo\n\n## Vibe\nゆるい\n", "Neo");
    expect(md).toContain("# IDENTITY — Neo");
    expect(md).toMatch(/## Name\n\nNeo/);
    expect(md).toContain("## Vibe\nゆるい");
  });

  it("does not eat the next heading when the Name section is empty", () => {
    const md = personalizeIdentityMd("## Name\n## Vibe\nゆるい\n", "Neo");
    expect(md).toContain("## Vibe\nゆるい");
  });

  it("does not mangle unrelated bold text or headings", () => {
    const md = personalizeInstructionMd("# 別の見出し\n**強調** はそのまま。", "Momo");
    expect(md).toBe("# 別の見出し\n**強調** はそのまま。");
  });
});

describe("resolveEffectiveName", () => {
  it("prefers the requested name", () => {
    expect(resolveEffectiveName("Momo", "Old")).toBe("Momo");
  });

  it("falls back to the configured name when the request omits it (regression: language-only update renamed back to Ryoko)", () => {
    expect(resolveEffectiveName(undefined, "Momo")).toBe("Momo");
    expect(resolveEffectiveName("", "Momo")).toBe("Momo");
    expect(resolveEffectiveName("   ", "Momo")).toBe("Momo");
  });

  it("defaults to Ryoko only when nothing is configured", () => {
    expect(resolveEffectiveName(undefined, undefined)).toBe("Ryoko");
    expect(resolveEffectiveName("", "")).toBe("Ryoko");
  });
});
