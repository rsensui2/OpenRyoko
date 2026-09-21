import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageMissingBundledSkills } from "../bundled-skills.js";
import { TEMPLATE_DIR } from "../../shared/paths.js";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openryoko-bundled-skills-"));
  roots.push(root);
  const template = path.join(root, "template");
  const home = path.join(root, "instance");
  fs.mkdirSync(home);
  const write = (name: string, content: string | Buffer) => {
    const file = path.join(template, "skills", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  return { root, home, template, write };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bundled skills on upgrade", () => {
  it("installs the shipped configuration skill with all supporting references", () => {
    const { home } = fixture();
    expect(stageMissingBundledSkills(TEMPLATE_DIR, home, {})).toContain("openryoko-config");
    const source = path.join(TEMPLATE_DIR, "skills", "openryoko-config");
    const installed = path.join(home, "skills", "openryoko-config");
    for (const file of ["SKILL.md", "references/platform.md", "references/engine-fallback.md", "references/jev.md"]) {
      expect(fs.readFileSync(path.join(installed, file))).toEqual(fs.readFileSync(path.join(source, file)));
    }
    expect(stageMissingBundledSkills(TEMPLATE_DIR, home, {})).toEqual([]);
  });

  it("preserves entire customized skills, regular files, and dangling user symlinks", () => {
    const { home, template, write } = fixture();
    for (const name of ["custom", "linked", "file"]) write(`${name}/SKILL.md`, "shipped");
    write("custom/references/new.md", "do not mix into a customized skill");
    const skills = path.join(home, "skills");
    fs.mkdirSync(path.join(skills, "custom"), { recursive: true });
    fs.writeFileSync(path.join(skills, "custom", "SKILL.md"), "user instructions");
    fs.symlinkSync("missing-user-source", path.join(skills, "linked"));
    fs.writeFileSync(path.join(skills, "file"), "reserved by user");
    expect(stageMissingBundledSkills(template, home, {})).toEqual([]);
    expect(fs.readFileSync(path.join(skills, "custom", "SKILL.md"), "utf8")).toBe("user instructions");
    expect(fs.existsSync(path.join(skills, "custom", "references"))).toBe(false);
    expect(fs.readlinkSync(path.join(skills, "linked"))).toBe("missing-user-source");
    expect(fs.readFileSync(path.join(skills, "file"), "utf8")).toBe("reserved by user");
  });

  it("renders nested templates, retains binary resources, and ignores non-skills", () => {
    const { home, template, write } = fixture();
    const binary = Buffer.from([0, 255, 11, 22]);
    write("example/SKILL.md", "Hello {{portalName}}");
    write("example/references/config.yaml", "name: {{portalName}}");
    write("example/assets/blob.bin", binary);
    write("unfinished/notes.md", "not a skill");
    expect(stageMissingBundledSkills(template, home, { "{{portalName}}": "Momo" })).toEqual(["example"]);
    const installed = path.join(home, "skills", "example");
    expect(fs.readFileSync(path.join(installed, "SKILL.md"), "utf8")).toBe("Hello Momo");
    expect(fs.readFileSync(path.join(installed, "references/config.yaml"), "utf8")).toBe("name: Momo");
    expect(fs.readFileSync(path.join(installed, "assets/blob.bin"))).toEqual(binary);
  });

  it("leaves no partial discoverable skill or staging tree when copying fails", () => {
    const { home, template, write } = fixture();
    write("example/SKILL.md", "content");
    vi.spyOn(fs, "cpSync").mockImplementation(() => { throw new Error("copy failed"); });
    expect(() => stageMissingBundledSkills(template, home, {})).toThrow("copy failed");
    expect(fs.existsSync(path.join(home, "skills", "example"))).toBe(false);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});
