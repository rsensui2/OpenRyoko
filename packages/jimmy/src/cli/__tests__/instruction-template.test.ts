import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import { applyTemplateReplacements, buildTemplateReplacements } from "../../shared/templateReplacements.js";

const read = (rel: string) => fs.readFileSync(path.join(TEMPLATE_DIR, rel), "utf-8");
const bytes = (text: string) => Buffer.byteLength(text, "utf-8");

/** The always-loaded instruction file is read in full on every turn of every
 *  session, so its size is a product budget, not a style preference. */
const AGENTS_BUDGET_BYTES = 10_000;

describe("shipped instruction templates", () => {
  const agents = read("AGENTS.md");
  const claude = read("CLAUDE.md");

  it("ships CLAUDE.md as an entry point that imports the single source instead of duplicating it", () => {
    for (const name of ["AGENTS.md", "IDENTITY.md", "SOUL.md"]) {
      expect(claude).toMatch(new RegExp(`^@${name.replace(".", "\\.")}\\s*$`, "m"));
    }
    expect(bytes(claude)).toBeLessThan(1_000);
  });

  it("never imports MEMORY.md, which only the gateway's privacy gate may inject", () => {
    // Claude Code imports `@path` anywhere in a line, with or without ./ or ~/.
    expect(claude).not.toMatch(/@\S*MEMORY\.md/);
    expect(agents).not.toMatch(/@\S*MEMORY\.md/);
  });

  it("keeps AGENTS.md within the always-loaded budget", () => {
    expect(bytes(agents)).toBeLessThanOrEqual(AGENTS_BUDGET_BYTES);
  });

  it("tells runtimes without @-import to read the persona files themselves", () => {
    expect(agents).toContain("~/.ryoko/IDENTITY.md");
    expect(agents).toContain("~/.ryoko/SOUL.md");
    expect(agents).toContain("BOOTSTRAP.md");
  });

  it("keeps the MEMORY.md privacy rule in the always-loaded file", () => {
    expect(agents).toContain("portal.trustedSpeakers");
    expect(agents).toMatch(/MEMORY\.md.*Read\s*しない/);
  });

  it("leaves schemas and API examples to docs and skills", () => {
    expect(agents).not.toContain("```json");
    expect(agents).not.toContain("```yaml");
    expect(agents).not.toMatch(/POST \/api\//);
  });

  it("only routes to skills and docs that actually ship", () => {
    const skills = fs.readdirSync(path.join(TEMPLATE_DIR, "skills"));
    const docs = fs.readdirSync(path.join(TEMPLATE_DIR, "docs"));
    const routed = [
      ...[...agents.matchAll(/→[^\n]*/g)].flatMap((m) => [...m[0].matchAll(/`([a-z][a-z0-9-]+)`/g)].map((x) => x[1])),
      ...[...agents.matchAll(/`([a-z][a-z0-9-]+)` Skill/g)].map((m) => m[1]),
    ];
    expect(routed.length).toBeGreaterThan(5);
    for (const name of routed) expect(skills, `skill ${name}`).toContain(name);
    for (const m of agents.matchAll(/`docs\/([a-z-]+\.md)`/g)) expect(docs, `docs/${m[1]}`).toContain(m[1]);
  });

  it("explains where new rules go so the file does not grow back", () => {
    expect(agents).toContain("このファイルを太らせない");
  });

  it("ships the memory doc to existing instances byte-for-byte, free of setup-time placeholders", () => {
    const doc = read("docs/memory.md");
    expect(read("migrations/2026.10.9/files/docs/memory.md")).toBe(doc);
    // The AI-driven migration copies files/ without placeholder substitution.
    expect(doc).not.toContain("{{");
  });

  it("ships the revised migrate skill to existing instances, which never re-copy a skill they already have", () => {
    expect(read("migrations/2026.10.9/files/skills/migrate/SKILL.md")).toBe(read("skills/migrate/SKILL.md"));
  });

  it("tells whoever writes a migration how to keep --auto from recording it as done", () => {
    const migrate = read("skills/migrate/SKILL.md");
    expect(migrate).toMatch(/^auto: false$/m);
    expect(migrate).toMatch(/migration を書くとき/);
    // The migration that showed why: its owner-facing section must not ride on a file conflict.
    expect(read("migrations/2026.10.9/MIGRATION.md")).toMatch(/^---\n[\s\S]*?^auto: false$[\s\S]*?^---$/m);
  });

  it("has the migrate skill rely on the list in its prompt, not on command output it never sees", () => {
    const migrate = read("skills/migrate/SKILL.md");
    // `ryoko migrate` prints "[skill kept]" lines to the terminal; the AI it then starts does not get them.
    expect(migrate).not.toContain("[skill kept]");
    expect(migrate).toMatch(/プロンプト.*挙が/);
    // No receipt yet: an old copy is not automatically the user's customization.
    expect(migrate).toMatch(/追記が無ければ.*そのまま/);
  });

  it("tells the migrate skill what to do when its prompt says nothing about the sync", () => {
    const migrate = read("skills/migrate/SKILL.md");
    // Started from chat with /migrate there is no list. Guessing a skill's state could
    // bring back one the operator deleted, or mark an untouched one as edited.
    const rule = migrate.split("\n").find((line) => /プロンプトに.*記載が無い/.test(line)) ?? "";
    expect(rule).toMatch(/\/migrate/);
    expect(rule).toMatch(/推測しません/);
    expect(rule).toMatch(/何も適用せず.*ターミナルで `ryoko migrate`/);
  });

  it("tells the migrate skill how to treat skills in a home the sync does not run in", () => {
    const migrate = read("skills/migrate/SKILL.md");
    // `ryoko migrate` says so in the prompt and points here for the rules.
    expect(migrate).toMatch(/同期が動かないホーム.*symlink/);
    expect(migrate).toMatch(/無いスキルディレクトリ.*丸ごとコピー/);
  });

  it("tells the migrate skill not to append sections to an entry-point CLAUDE.md", () => {
    const migrate = read("skills/migrate/SKILL.md");
    expect(migrate).toContain("@AGENTS.md");
    expect(migrate).not.toContain("セクション全体を追記");
  });

  // `ryoko migrate --auto` fills the placeholders of a file it creates. The AI-driven
  // run copies files/ as they are, and most of the docs carry placeholders: without
  // this rule a replaced doc reads "{{portalName}} runs as a single Node.js process".
  it("tells the migrate skill to fill the placeholders a migration's files still carry, the way --auto does", () => {
    const migrate = read("skills/migrate/SKILL.md");
    const rule = migrate.split("\n").find((line) => line.startsWith("**プレースホルダ**")) ?? "";
    const filled = buildTemplateReplacements("My Portal");

    expect(Object.keys(filled).sort()).toEqual(["{{portalName}}", "{{portalSlug}}"]);
    for (const name of ["`portalName`", "`portalSlug`"]) expect(rule, name).toContain(name);
    expect(rule).toContain("`config.yaml` の `portal.portalName`");
    // The slug as the installer derives it: lower case, blanks to hyphens.
    expect(filled["{{portalSlug}}"]).toBe("my-portal");
    expect(rule).toContain("小文字にして空白を `-` に替えたもの");
    expect(rule).toMatch(/docs を丸ごと置き換えるときも同じ/);
  });

  it("does not spell a placeholder out where the instruction itself would be filled in", () => {
    // The skill is a template too: installed, every literal {{portalName}} in it has
    // become the assistant's name. A rule that names the placeholder that way reaches
    // the agent as "replace `Momo` with the portal name".
    const migrate = read("skills/migrate/SKILL.md");
    const body = migrate.slice(migrate.indexOf("\n---\n", 4));
    const installed = applyTemplateReplacements(body, buildTemplateReplacements("Momo"));

    expect(installed).toBe(body);
  });

  it("tells the migrate skill where a command it hands to the user has to be run", () => {
    const migrate = read("skills/migrate/SKILL.md");
    const rule = migrate.split("\n").find((line) => line.includes("gateway が動いている場所で実行するよう添える")) ?? "";

    expect(rule).toContain("コンテナの中");
    expect(rule).toMatch(/ホスト側の `ryoko` を、そのホームに向けない/);
  });
});
