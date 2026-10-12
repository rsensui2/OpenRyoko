import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TEMPLATE_DIR } from "../../shared/paths.js";

// The skills and docs that ship with every instance tell agents and operators
// which commands to run. Nothing generates them from the CLI, and two of them
// still named commands of the project this one was forked from. These hold every
// command they mention to the ones the CLI really has.

const read = (relative: string): string => fs.readFileSync(path.join(TEMPLATE_DIR, ...relative.split("/")), "utf-8");

/** Every Markdown and YAML file under the shipped docs and skills, plus the instruction files. */
function shippedTexts(): { file: string; text: string }[] {
  const found: string[] = ["AGENTS.md", "CLAUDE.md", "BOOTSTRAP.md", "config.default.yaml"];
  const walk = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(TEMPLATE_DIR, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.(md|ya?ml)$/.test(entry.name)) found.push(child);
    }
  };
  walk("docs");
  walk("skills");
  return found.map((file) => ({ file, text: read(file) }));
}

/** The top-level commands of the CLI, read from where they are declared. */
function cliCommands(): Set<string> {
  const source = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "bin", "jimmy.ts"), "utf-8");
  return new Set([...source.matchAll(/\bprogram\s*\.command\("([a-z-]+)/g)].map((match) => match[1]));
}

describe("commands named in the shipped skills and docs", () => {
  it("are all commands the CLI has", () => {
    const commands = cliCommands();
    // A sanity check on the reader above: these exist, whatever else does.
    for (const known of ["start", "stop", "setup", "migrate", "update", "backup", "api"]) expect(commands, known).toContain(known);

    const unknown = shippedTexts().flatMap(({ file, text }) =>
      [...text.matchAll(/\bryoko (?:-i <name> )?([a-z][a-z-]*)\b/g)]
        .map((match) => match[1])
        .filter((name) => !commands.has(name))
        .map((name) => `${file}: ryoko ${name}`));

    expect(unknown).toEqual([]);
  });

  it("name no command or home of the project this one was forked from", () => {
    const stale = shippedTexts().flatMap(({ file, text }) =>
      [...text.matchAll(/\b(?:jinn|jimmy) (?:start|stop|init|setup|migrate|status|update|skills|api)\b/g)].map((match) => `${file}: ${match[0]}`));

    expect(stale).toEqual([]);
  });
});

describe("skills/management — what a promoted manager is told about delegation", () => {
  it("does not tell the manager to poll a child session, which the delegation protocol forbids", () => {
    const text = read("skills/management/SKILL.md");

    expect(text).not.toMatch(/Poll status/);
    expect(text).toMatch(/never poll or wait inside a turn/);
  });

  it("lists the model as optional, as docs/org.md does", () => {
    const required = read("skills/management/SKILL.md").split("\n").find((line) => line.startsWith("- `model` —")) ?? "";

    expect(required).toContain("(optional)");
    expect(read("docs/org.md")).toMatch(/\| `model` \| string \| no \|/);
  });
});

describe("skills/onboarding — a persona file that went missing", () => {
  it("is restored from a backup before it is created again from the template", () => {
    const rule = read("skills/onboarding/SKILL.md").split("\n").find((line) => line.includes("誤って削除された可能性")) ?? "";

    expect(rule).toMatch(/まずバックアップから戻す/);
    expect(rule).toContain("ryoko backup restore <id> --only persona,memory --dry-run");
    expect(rule).toMatch(/バックアップに無ければ、`ryoko setup`/);
  });
});
