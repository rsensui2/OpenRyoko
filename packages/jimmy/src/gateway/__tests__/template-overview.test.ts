import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kindOfPath } from "../../backup/targets.js";
import { TEMPLATE_DIR } from "../../shared/paths.js";

// docs/overview.md and docs/architecture.md are the first two documents an agent
// reads about the gateway it runs in. They still listed Discord as a future
// connector and the Codex engine as an SDK, and knew nothing of the directories
// the gateway now keeps for itself. These hold them to what is in the source tree.

const read = (relative: string): string => fs.readFileSync(path.join(TEMPLATE_DIR, ...relative.split("/")), "utf-8");
const SRC = path.join(import.meta.dirname, "..", "..");

/** The connectors a chat message can arrive through: one directory each, the
 *  cron connector (the scheduler's own) aside. */
const chatConnectors = fs.readdirSync(path.join(SRC, "connectors"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("__") && entry.name !== "cron")
  .map((entry) => entry.name);
/** The engines the gateway can run a turn on: one module each. */
const engines = ["claude", "codex", "gemini"].filter((name) => fs.existsSync(path.join(SRC, "engines", `${name}.ts`)));

describe("docs/overview.md", () => {
  it("lists every connector the gateway has as existing, none of them as a plan", () => {
    const line = read("docs/overview.md").split("\n").find((candidate) => candidate.startsWith("- **Connectors**")) ?? "";

    expect(chatConnectors.length).toBeGreaterThanOrEqual(4);
    for (const name of chatConnectors) expect(line.toLowerCase(), name).toContain(name);
    expect(line).not.toMatch(/future/i);
  });

  it("shows the directories the gateway keeps for itself, and says tmp/ is not a cache", () => {
    const text = read("docs/overview.md");

    expect(text).toMatch(/^ {2}backups\/ +# Daily backups the gateway writes/m);
    expect(text).toMatch(/^ {2}tmp\/ +# The gateway's working state — not a cache to clear/m);
  });
});

describe("docs/architecture.md and docs/overview.md — engines", () => {
  it("describe every engine as a CLI the gateway spawns", () => {
    const architecture = read("docs/architecture.md");

    expect(engines).toEqual(["claude", "codex", "gemini"]);
    for (const name of engines) expect(architecture, name).toMatch(new RegExp(`\\*\\*${name[0].toUpperCase()}${name.slice(1)} Engine\\*\\*[^\\n]*: Spawns`));
    for (const file of ["docs/architecture.md", "docs/overview.md"]) expect(read(file), file).not.toMatch(/Codex SDK|uses SDK/);
  });

  it("name the parts of the gateway this release added, with the document that describes each", () => {
    const architecture = read("docs/architecture.md");

    expect(architecture).toMatch(/### Backup Scheduler\n[^\n]*`backup\.md`/);
    expect(architecture).toMatch(/### Bundled Skill Sync\n[^\n]*`skills\.md`/);
    expect(architecture).toMatch(/### Process Safety Net\n[^\n]*`process` of `GET \/api\/status`/);
    for (const doc of ["backup.md", "skills.md"]) expect(fs.existsSync(path.join(TEMPLATE_DIR, "docs", doc)), doc).toBe(true);
  });
});

describe("docs/memory.md — where notes are set aside", () => {
  it("does not send a folder that is being kept safe into the directory the archive leaves out", () => {
    // backups/ is where the gateway writes its backups; nothing in it is part of an archive.
    expect(kindOfPath("backups/claude-auto-memory/feedback_note.md")).toBeNull();
    expect(read("docs/memory.md")).toMatch(/退避先は `~\/\.ryoko\/backups\/` 以外にする/);
    expect(read("docs/memory.md")).not.toMatch(/退避する（`~\/\.ryoko\/backups\/` など）/);
  });
});
