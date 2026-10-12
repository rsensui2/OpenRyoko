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

  it("leaves no staging directory behind when a skill cannot be moved into place, and deletes no tree to do it", () => {
    const { home, template, write } = fixture();
    write("demo/SKILL.md", "---\nname: demo\n---\nHello {{portalName}}\n");
    write("demo/references/a.md", "a\n");
    write("demo/assets/.gitkeep", "");
    const rename = fs.renameSync;
    // The user's skills directory is on another volume: the move cannot be a rename.
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path.join(home, "skills", "demo")) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      return rename(from, to);
    });
    const rm = vi.spyOn(fs, "rmSync");

    expect(() => stageMissingBundledSkills(template, home, { "{{portalName}}": "Momo" })).toThrow(/EXDEV/);

    expect(fs.readdirSync(home).filter((name) => name.startsWith(".bundled-skill-"))).toEqual([]);
    expect(fs.existsSync(path.join(home, "skills", "demo"))).toBe(false);
    expect(rm.mock.calls.filter(([, options]) => options?.recursive)).toEqual([]);
  });

  it("removes its staging directory once the skill is in place, without deleting a tree", () => {
    const { home, template, write } = fixture();
    write("demo/SKILL.md", "---\nname: demo\n---\n");
    const rm = vi.spyOn(fs, "rmSync");

    expect(stageMissingBundledSkills(template, home, {})).toEqual(["demo"]);

    expect(fs.readdirSync(home)).toEqual(["skills"]);
    expect(rm.mock.calls.filter(([, options]) => options?.recursive)).toEqual([]);
  });

  it("does not empty a directory linked in where its staged copy was", () => {
    const { root, home, template, write } = fixture();
    write("demo/SKILL.md", "---\nname: demo\n---\n");
    write("demo/references/a.md", "a\n");
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(outside, "references"), { recursive: true });
    fs.writeFileSync(path.join(outside, "SKILL.md"), "the user's own skill\n");
    fs.writeFileSync(path.join(outside, "references", "a.md"), "the user's own reference\n");
    const rename = fs.renameSync;
    // The move fails, and before the clean-up the staged copy is swapped for a link.
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) !== path.join(home, "skills", "demo")) return rename(from, to);
      rename(from, path.join(root, "real-staged"));
      fs.symlinkSync(outside, String(from));
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    });

    expect(() => stageMissingBundledSkills(template, home, {})).toThrow(/EXDEV/);

    expect(fs.readFileSync(path.join(outside, "SKILL.md"), "utf8")).toBe("the user's own skill\n");
    expect(fs.readFileSync(path.join(outside, "references", "a.md"), "utf8")).toBe("the user's own reference\n");
  });
});

