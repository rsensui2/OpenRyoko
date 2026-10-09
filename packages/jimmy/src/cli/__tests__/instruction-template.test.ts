import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TEMPLATE_DIR } from "../../shared/paths.js";

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

  it("tells the migrate skill not to append sections to an entry-point CLAUDE.md", () => {
    const migrate = read("skills/migrate/SKILL.md");
    expect(migrate).toContain("@AGENTS.md");
    expect(migrate).not.toContain("セクション全体を追記");
  });
});
