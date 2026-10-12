import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TEMPLATE_DIR } from "../../shared/paths.js";
import { HISTORY_FILE } from "../history.js";

// scripts/generate-bundled-skill-history.mjs builds the fingerprint table from the
// release tags of the repository it sits in. Each test gives it a small repository of
// its own, so that which tags there are is the test's to say.

const REPO = path.resolve(TEMPLATE_DIR, "..", "..", "..");
const SCRIPT = "scripts/generate-bundled-skill-history.mjs";
const FINGERPRINT = "packages/jimmy/src/skills-sync/fingerprint.ts";
const SKILLS = "packages/jimmy/template/skills";
const OUTPUT = path.join("packages", "jimmy", "template", HISTORY_FILE);

const [major, minor] = process.versions.node.split(".").map(Number);
/** The script imports a .ts file, which Node does unaided from 22.18 on. */
const canRun = major > 22 || (major === 22 && minor >= 18);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repository() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openryoko-history-generator-")));
  roots.push(root);
  // Nothing of the developer's own git set-up: no hooks, no signing, no templates.
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q", "-b", "main");
  for (const file of [SCRIPT, FINGERPRINT]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(path.join(REPO, file), path.join(root, file));
  }
  return {
    git,
    /** Commit these skills as everything the package ships, and tag the commit when it is a release. */
    ship(skills: Record<string, string>, release?: string): void {
      fs.rmSync(path.join(root, SKILLS), { recursive: true, force: true });
      for (const [name, text] of Object.entries(skills)) {
        fs.mkdirSync(path.join(root, SKILLS, name), { recursive: true });
        fs.writeFileSync(path.join(root, SKILLS, name, "SKILL.md"), text);
      }
      git("add", "--all", "--", SKILLS);
      git("commit", "-q", "-m", release ?? "work in progress");
      if (release) git("tag", release);
    },
    generate: (...args: string[]): void => { execFileSync(process.execPath, [SCRIPT, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] }); },
    text: (): string => fs.readFileSync(path.join(root, OUTPUT), "utf8"),
    table: (): { source: string; names: string[]; skills: Record<string, { since: string }[]> } => JSON.parse(fs.readFileSync(path.join(root, OUTPUT), "utf8")),
    spoil: (): void => fs.appendFileSync(path.join(root, OUTPUT), "\n"),
  };
}

/**
 * Two releases on the line being built and a commit on top of them. Beside that line,
 * tags it never went through: a release further along than the commit being built, and
 * the releases of another project with no history in common, numbered the same way.
 */
function withTagsFromElsewhere() {
  const r = repository();
  r.ship({ demo: "v1\n" }, "v1.0.0");
  r.ship({ demo: "v2\n" }, "v1.1.0");
  r.ship({ demo: "v3\n", later: "new\n" });
  r.git("checkout", "-q", "-b", "ahead");
  r.ship({ demo: "v4\n" }, "v1.2.0");
  r.git("checkout", "-q", "--orphan", "elsewhere");
  r.ship({ demo: "from another project\n", foreign: "theirs\n" }, "v1.0.5");
  r.git("checkout", "-q", "main");
  return r;
}

describe.skipIf(!canRun)("the generator of the bundled skill history", () => {
  it("takes the releases the commit being built descends from, and no other tag", () => {
    const r = withTagsFromElsewhere();

    r.generate();

    const table = r.table();
    expect(table.source).toBe("2 release tags, v1.0.0 to v1.1.0");
    expect(table.skills.demo.map((version) => version.since)).toEqual(["v1.0.0", "v1.1.0"]);
    // Nothing of the other project's, and nothing of a release this commit is not built on.
    expect(Object.keys(table.skills)).toEqual(["demo"]);
    expect(table.names).toEqual(["demo", "later"]);
  });

  it("writes the same table whatever other tags the clone happens to hold", () => {
    const r = withTagsFromElsewhere();
    r.generate();
    const withThem = r.text();
    r.generate("--check");

    // A clone that never fetched them.
    r.git("tag", "-d", "v1.0.5", "v1.2.0");
    r.generate("--check");
    r.generate();

    expect(r.text()).toBe(withThem);
  });

  it("counts a release from the moment the commit being built descends from it", () => {
    const r = withTagsFromElsewhere();
    r.git("merge", "-q", "--ff-only", "ahead");

    r.generate();

    expect(r.table().source).toBe("3 release tags, v1.0.0 to v1.2.0");
    expect(r.table().skills.demo.map((version) => version.since)).toEqual(["v1.0.0", "v1.1.0", "v1.2.0"]);
  });

  it("--check fails on a table that is not the one it would write", () => {
    const r = withTagsFromElsewhere();
    r.generate();
    r.spoil();

    expect(() => r.generate("--check")).toThrow(/out of date/);
  });
});
