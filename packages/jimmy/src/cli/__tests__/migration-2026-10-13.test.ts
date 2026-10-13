import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ARCHIVE_RETENTION, DEFAULT_MAX_ARCHIVE_MB, DEFAULT_MAX_ENTRIES, resolveBackupSettings } from "../../backup/settings.js";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import { applyTemplateReplacements, buildTemplateReplacements } from "../../shared/templateReplacements.js";
import { isHousekeepingFile } from "../../skills-sync/names.js";
import { migrationNeedsSession } from "../migration-declarations.js";

const VERSION = "2026.10.13";
const MIGRATION = `migrations/${VERSION}`;
const read = (rel: string) => fs.readFileSync(path.join(TEMPLATE_DIR, rel), "utf-8");

/**
 * What to do when a template file and the migration's copy of it differ. The copy follows the template,
 * also after this release: a home that comes to this migration later should get the text as it is now.
 */
const copyIt = (file: string) => `template/${file} changed: copy it to template/${MIGRATION}/files/${file} as well`;

/** Every file under a directory of the template, as paths relative to that directory. */
function filesUnder(rel: string): string[] {
  const walk = (dir: string): string[] => fs.readdirSync(path.join(TEMPLATE_DIR, dir), { withFileTypes: true })
    .filter((entry) => !isHousekeepingFile(entry.name)) // a .DS_Store in a checkout is not a file the package ships
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  return walk(rel).map((file) => path.relative(rel, file)).sort();
}

describe("migration 2026.10.13", () => {
  const instructions = read(`${MIGRATION}/MIGRATION.md`);
  const docs = filesUnder("docs");
  /** The value the table of new settings gives for a key. */
  const stated = (key: string) => instructions.match(new RegExp(`^\\| \`${key.replaceAll(".", "\\.")}\`[^|]*\\| \`([^\`]+)\``, "m"))?.[1];

  it("ships every reference doc to existing instances exactly as the package has it", () => {
    // Docs are never synced: a migration's files/docs/ is the only way one reaches a home that already exists.
    expect(filesUnder(`${MIGRATION}/files/docs`)).toEqual(docs);
    for (const doc of docs) expect(read(`${MIGRATION}/files/docs/${doc}`), copyIt(`docs/${doc}`)).toBe(read(`docs/${doc}`));
    expect(instructions).toContain(`\`files/docs/\` の${docs.length}本`);
  });

  it("ships the bundled skills this release changed, whole, exactly as the package has them", () => {
    // Used for the copies the sync left alone. A copy made equal to these is recognised as shipped from then on,
    // which takes every file of the skill, the unchanged ones too.
    const skills = fs.readdirSync(path.join(TEMPLATE_DIR, MIGRATION, "files/skills")).filter((name) => !isHousekeepingFile(name)).sort();
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
    expect(migrationNeedsSession(VERSION)).toBe(true);
  });

  it("leaves config.yaml alone but for the version, though it lists settings the migrate skill would otherwise add", () => {
    // The migrate skill adds new config keys with their defaults, and the prompt asks for jinn.version to be written.
    expect(instructions).toMatch(/`config\.yaml` に書くのは、最後に行う `jinn\.version` の更新だけです/);
    expect(instructions).toMatch(/キーは、`config\.yaml` に書き足しません/);
  });

  it("goes by what the prompt says of the skill sync, which did not run in a home whose skills/ is a symlink", () => {
    // Said without the condition, "skills were synced" drops all six skill changes in such a home: nothing was synced there.
    expect(instructions).toContain('"Bundled skills were synced before this session started."');
    expect(instructions).toContain('"no bundled skill was synced"');
    // Such a home may hold a migrate skill from before the sync existed, so the one this migration ships is cited.
    expect(instructions).toContain("`files/skills/migrate/SKILL.md` の「同期が動かないホーム」");
    expect(read(`${MIGRATION}/files/skills/migrate/SKILL.md`)).toContain("**同期が動かないホーム**");
    expect(instructions).toMatch(/プロンプトに同期についての記載が無いとき.*何も適用せずに止め/);
    // And a skill the prompt says to leave is left, the rewritten self-heal included.
    expect(instructions).toMatch(/「触らない」「そのままにする」とされたスキル.*書き換えません/);
    expect(instructions).toMatch(/書き換えないコピー.*書き換えずに、残っていることを最後の報告で伝えます/);
  });

  it("tells the AI to fill the name placeholders, in words `ryoko setup` leaves as they are", () => {
    // The AI-driven migration copies files/ without substitution, and most of the docs carry a placeholder.
    expect(docs.some((doc) => read(`${MIGRATION}/files/docs/${doc}`).includes("{{portalName}}"))).toBe(true);
    expect(instructions).toMatch(/`\{\{` と `\}\}` で囲んだ `portalName`・`portalSlug` が残っていたら、置く前に埋めます/);
    // The rule itself, as buildTemplateReplacements has it.
    expect(buildTemplateReplacements("Aiko  Desk")).toEqual({ "{{portalName}}": "Aiko  Desk", "{{portalSlug}}": "aiko-desk" });
    expect(instructions).toMatch(/`portal\.portalName`（無ければ `Ryoko`）/);
    expect(instructions).toMatch(/小文字にして、空白の並びを `-` に替えたもの/);
    // `ryoko setup` substitutes placeholders under template/migrations/ too: one spelled out here would become the name.
    expect(applyTemplateReplacements(instructions, buildTemplateReplacements("Aiko Desk"))).toBe(instructions);
  });

  it("points only at docs and sections that ship", () => {
    const cited = [...instructions.matchAll(/`docs\/([a-z-]+\.md)`(?: の((?:「[^」]+」)+))?/g)];
    let headingsChecked = 0;
    for (const [, doc, headings] of cited) {
      expect(docs, doc).toContain(doc);
      const headingLines = read(`docs/${doc}`).split("\n").filter((line) => /^#{1,4} /.test(line));
      for (const [, heading] of (headings ?? "").matchAll(/「([^」]+)」/g)) {
        expect(headingLines.some((line) => line.includes(heading)), `${doc}: ${heading}`).toBe(true);
        headingsChecked++;
      }
    }
    // A citation written another way is one this test does not see: every `docs/x.md` in the text is in the form above.
    expect(cited.length).toBe(instructions.match(/docs\/[a-z-]+\.md/g)?.length);
    expect(headingsChecked).toBe(8);
  });

  it("lists the new settings with the defaults the code has", () => {
    const backup = resolveBackupSettings(undefined, "/home");
    expect(stated("backup.enabled")).toBe(String(backup.enabled));
    expect(stated("backup.retention")).toBe(String(DEFAULT_ARCHIVE_RETENTION));
    expect(stated("backup.maxArchiveMb")).toBe(String(DEFAULT_MAX_ARCHIVE_MB));
    expect(stated("backup.maxEntries")).toBe(String(DEFAULT_MAX_ENTRIES));
    expect(backup.directory).toBe(path.join("/home", "backups"));
    expect(instructions).toMatch(/^\| `backup\.directory` \| ホームの `backups\/` \|$/m);
    // On unless switched off, and off unless switched on: the defaults of these three are read where they are used.
    expect(stated("sessions.resumeInterruptedOnBoot")).toBe("true");
    expect(stated("skills.autoSync")).toBe("true");
    expect(stated("connectors.slack.providerAuth.enabled")).toBe("false");
    // The rest, as the shipped config states them.
    const config = read("config.default.yaml");
    for (const [key, value] of [["sessions.resumeInterruptedMaxAgeMinutes", "120"], ["cron.alertThrottleMinutes", "60"], ["maxAttachmentMb", "200"]]) {
      expect(stated(key), key).toBe(value);
      expect(config, key).toMatch(new RegExp(`^\\s*#\\s*${key.split(".").pop()}: ${value}\\b`, "m"));
    }
  });
});
