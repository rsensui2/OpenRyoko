import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import { isHousekeepingFile } from "../../skills-sync/names.js";
import { migrationNeedsSession } from "../migration-declarations.js";

const VERSION = "2026.11.20";
const MIGRATION = `migrations/${VERSION}`;
const read = (rel: string) => fs.readFileSync(path.join(TEMPLATE_DIR, rel), "utf-8");

/** Every file under a directory of the template, as paths relative to that directory. */
function filesUnder(rel: string): string[] {
  const walk = (dir: string): string[] => fs.readdirSync(path.join(TEMPLATE_DIR, dir), { withFileTypes: true })
    .filter((entry) => !isHousekeepingFile(entry.name))
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  return walk(rel).map((file) => path.relative(rel, file)).sort();
}

describe("migration 2026.11.20", () => {
  const instructions = read(`${MIGRATION}/MIGRATION.md`);

  it("ships the bundled skill this release changed, whole, exactly as the package has it", () => {
    const skills = fs.readdirSync(path.join(TEMPLATE_DIR, MIGRATION, "files/skills")).filter((name) => !isHousekeepingFile(name)).sort();
    expect(skills).toEqual(["openryoko-config"]);
    for (const skill of skills) {
      const files = filesUnder(`skills/${skill}`);
      expect(filesUnder(`${MIGRATION}/files/skills/${skill}`), skill).toEqual(files);
      for (const file of files) {
        expect(
          read(`${MIGRATION}/files/skills/${skill}/${file}`),
          `template/skills/${skill}/${file} changed: copy it to template/${MIGRATION}/files/skills/${skill}/${file} as well`,
        ).toBe(read(`skills/${skill}/${file}`));
      }
      expect(instructions, skill).toContain(`\`${skill}\``);
    }
  });

  it("ships no docs and no configuration patch", () => {
    expect(fs.existsSync(path.join(TEMPLATE_DIR, MIGRATION, "files/docs"))).toBe(false);
    expect(fs.readdirSync(path.join(TEMPLATE_DIR, MIGRATION)).filter((name) => !isHousekeepingFile(name)).sort()).toEqual(["MIGRATION.md", "files"]);
  });

  it("is held back from --auto, which would bump the version and tell the owner nothing", () => {
    expect(migrationNeedsSession(VERSION)).toBe(true);
  });

  it("allows no configuration edit but the version, and names the one-time session change", () => {
    expect(instructions).toContain("The only permitted configuration edit is the final `jinn.version` update to `2026.11.20`");
    expect(instructions).toContain("`connectors.instances`");
    expect(instructions).not.toMatch(/\{\{|\}\}/);
  });
});
