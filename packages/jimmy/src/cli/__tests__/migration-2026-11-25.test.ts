import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import { isHousekeepingFile } from "../../skills-sync/names.js";
import { migrationNeedsSession } from "../migration-declarations.js";

const VERSION = "2026.11.25";
const MIGRATION = `migrations/${VERSION}`;
const read = (rel: string) => fs.readFileSync(path.join(TEMPLATE_DIR, rel), "utf-8");

describe("migration 2026.11.25", () => {
  const instructions = read(`${MIGRATION}/MIGRATION.md`);

  it("ships the memory doc to existing instances exactly as the package has it, and nothing else", () => {
    // Docs are never synced: a migration's files/docs/ is the only way one reaches a home that already exists.
    const shipped = fs.readdirSync(path.join(TEMPLATE_DIR, MIGRATION, "files/docs")).filter((name) => !isHousekeepingFile(name));
    expect(shipped).toEqual(["memory.md"]);
    expect(
      read(`${MIGRATION}/files/docs/memory.md`),
      `template/docs/memory.md changed: copy it to template/${MIGRATION}/files/docs/memory.md as well`,
    ).toBe(read("docs/memory.md"));
    expect(fs.readdirSync(path.join(TEMPLATE_DIR, MIGRATION, "files")).filter((name) => !isHousekeepingFile(name))).toEqual(["docs"]);
    expect(instructions).toContain("`files/docs/memory.md`");
  });

  it("places the doc without substitution, so the doc must hold no setup-time placeholder", () => {
    expect(read("docs/memory.md")).not.toContain("{{");
    expect(instructions).not.toContain("{{");
  });

  it("is held back from --auto, which would place nothing and tell the owner nothing", () => {
    expect(migrationNeedsSession(VERSION)).toBe(true);
  });

  it("leaves config.yaml alone but for the version, and memory and instructions alone altogether", () => {
    expect(instructions).toContain("The only permitted configuration edit is the final `jinn.version` update to `2026.11.25`");
    expect(instructions).toMatch(/Do not edit `MEMORY\.md`, `knowledge\/`, `AGENTS\.md`/);
    expect(instructions).toContain("After reporting, update only `jinn.version`.");
  });

  it("does not depend on the skill sync, since it changes no bundled skill", () => {
    // The migrate skill proceeds without sync information when a migration touches no skill;
    // an instruction here to stop would contradict it.
    expect(instructions).toContain("There are no bundled skill changes in this release.");
    expect(instructions).not.toContain("do not apply this migration");
    expect(fs.existsSync(path.join(TEMPLATE_DIR, MIGRATION, "files/skills"))).toBe(false);
  });

  it("replaces the reference document whole, as the migrate skill does for docs", () => {
    expect(instructions).toContain("Reference documents are replaced whole.");
    expect(instructions).not.toContain("an earlier version shipped");
  });

  it("has the owner told what the configuration means, platform by platform", () => {
    for (const phrase of [
      "**No ID-based trust.**",
      "**Otherwise the first three items apply, platform by platform.**",
      // The two states the audience check tells apart, and the one it does not count.
      "A number written without quotes is configured but unusable",
      "An operator key with an empty value or `null` counts as not set",
    ]) {
      expect(instructions).toContain(phrase);
    }
    // What the owner has to do to keep a colleague's words recorded, and what that also opens.
    expect(instructions).toContain("That also loads `MEMORY.md` into one-to-one direct messages with that person.");
  });

  it("names the settings as the code reads them", () => {
    // The same strings the engines and the audience check use; a rename there must reach the owner's notice too.
    for (const name of [
      "portal.trustedSpeakers", "portal.operatorSlackId", "portal.operatorDiscordId",
      "memories.use_memories=false", "memories.generate_memories=false", "engines.claude.autoMemory",
      "scope=conversations", "source=slack,web",
    ]) {
      expect(instructions, name).toContain(name);
    }
  });
});
