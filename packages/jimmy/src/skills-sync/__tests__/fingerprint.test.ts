import { describe, expect, it } from "vitest";
import { buildTemplateReplacements, isTemplateFile } from "../../shared/templateReplacements.js";
import { fingerprintFile, isTemplatePath, matchesFingerprint, PLACEHOLDERS } from "../fingerprint.js";

const fill = (name: string) => (line: string) => line.replaceAll("{{portalName}}", name).replaceAll("{{portalSlug}}", name.toLowerCase());

describe("skill file fingerprints", () => {
  // fingerprint.ts cannot import the installer's helpers (the generator script loads it
  // without a build), so it repeats two facts about them. These keep the copies honest.
  it("knows exactly the placeholders the installer fills in", () => {
    expect([...PLACEHOLDERS].sort()).toEqual(Object.keys(buildTemplateReplacements("x")).sort());
  });

  it("treats the same files as templates as the installer does", () => {
    for (const name of ["SKILL.md", "a.MD", "config.yaml", "config.yml", "notes.txt", "run.sh", "data.json", "Makefile", ".md", "x.md.bak"]) {
      expect(isTemplatePath(name), name).toBe(isTemplateFile(name));
      expect(isTemplatePath(`references/${name}`), name).toBe(isTemplateFile(name));
    }
  });

  it("gives a file the installer copies as is one hash", () => {
    const binary = Buffer.from([0, 255, 1, 2]);
    expect(fingerprintFile("assets/blob.bin", binary)).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(fingerprintFile("SKILL.md", Buffer.from("no placeholders here\n"))).toEqual({ sha256: expect.any(String) });
    // Not a template extension: the installer leaves the braces alone, so they are just bytes.
    expect(fingerprintFile("notes.txt", Buffer.from("{{portalName}}"))).toEqual({ sha256: expect.any(String) });
  });

  it("keeps only the lines that carry a placeholder, by line number", () => {
    const fingerprint = fingerprintFile("SKILL.md", Buffer.from("title\nHello {{portalName}}\nbody\nrun {{portalSlug}} now\n"));
    expect(fingerprint).toEqual({
      lines: 5,
      masked: expect.stringMatching(/^[0-9a-f]{64}$/),
      slots: { 1: "Hello {{portalName}}", 3: "run {{portalSlug}} now" },
    });
    expect(JSON.stringify(fingerprint)).not.toContain("body");
  });

  it("matches the file under the name it was filled in with, and no other", () => {
    const template = Buffer.from("title\nHello {{portalName}}\nbody\nrun {{portalSlug}} now\n");
    const fingerprint = fingerprintFile("SKILL.md", template);
    const installed = Buffer.from("title\nHello Momo\nbody\nrun momo now\n");

    expect(matchesFingerprint(fingerprint, installed, fill("Momo"))).toBe(true);
    expect(matchesFingerprint(fingerprint, installed, fill("Ryoko"))).toBe(false);
    expect(matchesFingerprint(fingerprint, template, (line) => line)).toBe(true);
    expect(matchesFingerprint(fingerprint, installed, (line) => line)).toBe(false);
  });

  it("does not match once any other line differs", () => {
    const fingerprint = fingerprintFile("SKILL.md", Buffer.from("title\nHello {{portalName}}\nbody\n"));
    for (const changed of ["Title\nHello Momo\nbody\n", "title\nHello Momo\nbody\n\n", "title\nHello Momo\nbody", "title\n\nHello Momo\nbody\n", "title\r\nHello Momo\r\nbody\r\n"]) {
      expect(matchesFingerprint(fingerprint, Buffer.from(changed), fill("Momo")), JSON.stringify(changed)).toBe(false);
    }
  });

  it("is not fooled by a name that reaches across lines", () => {
    const fingerprint = fingerprintFile("SKILL.md", Buffer.from("Hello {{portalName}}\nbody\n"));
    // Filled in with "Momo\nbody", this would be the same bytes as an edited three-line file.
    expect(matchesFingerprint(fingerprint, Buffer.from("Hello Momo\nextra\nbody\n"), fill("Momo\nextra"))).toBe(false);
  });
});
