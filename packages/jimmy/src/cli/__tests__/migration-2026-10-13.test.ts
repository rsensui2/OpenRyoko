import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import { applyTemplateReplacements, buildTemplateReplacements } from "../../shared/templateReplacements.js";

const MIGRATION = "migrations/2026.10.13";
const read = (rel: string) => fs.readFileSync(path.join(TEMPLATE_DIR, rel), "utf-8");

/**
 * What to do when a template file and the migration's copy of it differ. The copy follows the template,
 * also after this release: a home that comes to this migration later should get the text as it is now.
 */
const copyIt = (file: string) => `template/${file} changed: copy it to template/${MIGRATION}/files/${file} as well`;

/** Every file under a directory of the template, as paths relative to that directory. */
function filesUnder(rel: string): string[] {
  const walk = (dir: string): string[] => fs.readdirSync(path.join(TEMPLATE_DIR, dir), { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  return walk(rel).map((file) => path.relative(rel, file)).sort();
}

describe("migration 2026.10.13", () => {
  const instructions = read(`${MIGRATION}/MIGRATION.md`);
  const docs = filesUnder("docs");

  it("ships every reference doc to existing instances exactly as the package has it", () => {
    // Docs are never synced: a migration's files/docs/ is the only way one reaches a home that already exists.
    expect(filesUnder(`${MIGRATION}/files/docs`)).toEqual(docs);
    for (const doc of docs) expect(read(`${MIGRATION}/files/docs/${doc}`), copyIt(`docs/${doc}`)).toBe(read(`docs/${doc}`));
    expect(instructions).toContain(`\`files/docs/\` の${docs.length}本`);
  });

  it("ships the bundled skills this release changed, whole, exactly as the package has them", () => {
    // Used for the copies the sync left alone. A copy made equal to these is recognised as shipped from then on,
    // which takes every file of the skill, the unchanged ones too.
    const skills = fs.readdirSync(path.join(TEMPLATE_DIR, MIGRATION, "files/skills")).sort();
    expect(skills).toEqual(["cron-manager", "management", "migrate", "onboarding", "openryoko-config", "self-heal"]);
    for (const skill of skills) {
      const files = filesUnder(`skills/${skill}`);
      expect(filesUnder(`${MIGRATION}/files/skills/${skill}`), skill).toEqual(files);
      for (const file of files) {
        expect(read(`${MIGRATION}/files/skills/${skill}/${file}`), copyIt(`skills/${skill}/${file}`)).toBe(read(`skills/${skill}/${file}`));
      }
      expect(instructions, skill).toContain(`\`${skill}\``);
    }
  });

  it("is held back from --auto, which would place the docs and tell the owner nothing", () => {
    expect(instructions).toMatch(/^---\n[\s\S]*?^auto: false$[\s\S]*?^---$/m);
  });

  it("tells the AI to fill the name placeholders, in words `ryoko setup` leaves as they are", () => {
    // The AI-driven migration copies files/ without substitution, and most of the docs carry a placeholder.
    expect(docs.some((doc) => read(`${MIGRATION}/files/docs/${doc}`).includes("{{portalName}}"))).toBe(true);
    expect(instructions).toMatch(/`\{\{` と `\}\}` で囲んだ `portalName`・`portalSlug`/);
    // `ryoko setup` substitutes placeholders under template/migrations/ too: one spelled out here would become the name.
    expect(applyTemplateReplacements(instructions, buildTemplateReplacements("Aiko Desk"))).toBe(instructions);
  });

  it("points only at docs and sections that ship", () => {
    const cited = [...instructions.matchAll(/`docs\/([a-z-]+\.md)`(?: の((?:「[^」]+」)+))?/g)];
    expect(cited.length).toBeGreaterThan(5);
    for (const [, doc, headings] of cited) {
      expect(docs, doc).toContain(doc);
      const headingLines = read(`docs/${doc}`).split("\n").filter((line) => /^#{1,4} /.test(line));
      for (const [, heading] of (headings ?? "").matchAll(/「([^」]+)」/g)) {
        expect(headingLines.some((line) => line.includes(heading)), `${doc}: ${heading}`).toBe(true);
      }
    }
  });

  it("lists the new settings with the defaults the shipped config states", () => {
    const config = read("config.default.yaml");
    for (const [key, value] of [
      ["resumeInterruptedOnBoot", "true"], ["resumeInterruptedMaxAgeMinutes", "120"], ["alertThrottleMinutes", "60"],
      ["maxAttachmentMb", "200"], ["retention", "14"], ["maxArchiveMb", "512"], ["maxEntries", "50000"],
    ]) {
      expect(config, key).toMatch(new RegExp(`^\\s*#\\s*${key}: ${value}\\b`, "m"));
      expect(instructions, key).toMatch(new RegExp(`${key}[^|\\n]*\\| \`${value}\``));
    }
  });
});
