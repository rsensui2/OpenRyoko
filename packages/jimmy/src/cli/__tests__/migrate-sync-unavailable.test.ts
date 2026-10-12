import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

// Mock fs to control filesystem responses
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      lstatSync: vi.fn(),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      copyFileSync: vi.fn(),
      symlinkSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      rmSync: vi.fn(),
    },
  };
});

// Mock shared modules
vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({
    engines: {
      default: "claude",
      claude: { bin: "/usr/local/bin/claude" },
    },
  })),
}));

vi.mock("../../shared/version.js", () => ({
  compareSemver: vi.fn(() => -1), // instance behind package
  getPackageVersion: vi.fn(() => "1.1.0"),
  getInstanceVersion: vi.fn(() => "1.0.0"),
  getPendingMigrations: vi.fn(() => ["1.1.0"]),
}));

// Gateway start and `ryoko migrate` share one bundled-skill sync; its own suite
// covers what it does to a home. Here it only has to be called and reported.
vi.mock("../../skills-sync/instance.js", () => ({
  syncInstanceBundledSkills: vi.fn(),
}));

// The copy of package files into the home has its own suite, on a real filesystem.
// Here it only has to be asked for the right tree in the right place.
vi.mock("../home-copy.js", () => ({
  placeTree: vi.fn(),
}));

// config.yaml is read and written through the shared config writer, not
// through fs directly — the version stamp shows up as updateConfigDocument.
vi.mock("../../shared/config-file.js", () => ({
  readConfigSnapshot: vi.fn(() => ({ raw: null, bytes: null, mode: null, document: {}, revision: "" })),
  writeConfigDocument: vi.fn(() => "revision"),
  updateConfigDocument: vi.fn(() => "revision"),
}));

// The add-only installer that releases before the sync ran from `ryoko migrate`. Its own
// suite covers what it writes; here it only has to be called.
vi.mock("../bundled-skills.js", () => ({
  stageMissingBundledSkills: vi.fn(() => []),
}));

import fs from "node:fs";
import path from "node:path";
import { stageMissingBundledSkills } from "../bundled-skills.js";
import { compareSemver } from "../../shared/version.js";
import { CLAUDE_SKILLS_DIR, JINN_HOME, MIGRATIONS_DIR, TEMPLATE_DIR } from "../../shared/paths.js";
import { buildTemplateReplacements } from "../../shared/templateReplacements.js";
import {
  createdInHome, dirent, mockExecFileSync, mockExistsSync, mockPlaceTree, mockReaddirSync, mockSync, mockWriteFileSync, output, resetMigrateMocks, stampedVersions, synced,
} from "./migrate-harness.js";

const mockStage = vi.mocked(stageMissingBundledSkills);
const skillsDir = path.join(JINN_HOME, "skills");
const CONFIG = "jinn:\n  version: 1.0.0\nportal:\n  portalName: Hanako\n";

/** Everything created under skills/, by any of the three ways migrate writes. */
const createdUnderSkills = () => createdInHome().filter((file) => file === skillsDir || file.startsWith(skillsDir + path.sep));

/** Migration 1.1.0 ships these files, each a path under files/. `gone` is what the home
 *  lacks, relative to the home; everything else exists. */
function shipInMigration(shipped: string[], gone: string[]): void {
  const files = path.join(MIGRATIONS_DIR, "1.1.0", "files");
  const tree: Record<string, ReturnType<typeof dirent>[]> = {};
  for (const relative of shipped) {
    const parts = relative.split("/");
    parts.forEach((part, depth) => {
      const parent = path.join(files, ...parts.slice(0, depth));
      tree[parent] ??= [];
      if (!tree[parent].some((entry) => entry.name === part)) tree[parent].push(dirent(part, depth < parts.length - 1));
    });
  }
  mockReaddirSync.mockImplementation(((dir: string) => tree[dir] ?? []) as never);
  vi.mocked(fs.readFileSync).mockReturnValue(CONFIG);
  const absent = gone.map((relative) => path.join(JINN_HOME, ...relative.split("/")));
  mockExistsSync.mockImplementation((file) => !absent.some((path_) => String(file) === path_ || String(file).startsWith(path_ + path.sep)));
}

const prompt = () => (mockExecFileSync.mock.calls[0][1] as string[]).at(-1)!;
const errors = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n").replace(/\u001b\[\d+m/g, "");

describe("migrate: a home whose skills/ is the user's own symlink", () => {
  // The sync writes nothing into such a home. `ryoko migrate` treats its skills the way
  // every release before the sync did; otherwise a migration that ships a skill file
  // could never be finished there.
  beforeEach(() => {
    resetMigrateMocks();
    mockStage.mockReset();
    mockStage.mockReturnValue([]);
    mockSync.mockReturnValue(synced({ skipped: "skills-root-symlink" }));
    vi.mocked(fs.readFileSync).mockReturnValue(CONFIG);
  });

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
  });

  it("adds the bundled skills the home lacks, filled in with the configured name", async () => {
    vi.mocked(compareSemver).mockReturnValueOnce(0);
    mockStage.mockReturnValue(["status"]);
    const link = path.join(CLAUDE_SKILLS_DIR, "status");
    mockExistsSync.mockImplementation((file) => String(file) !== link);
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(mockStage).toHaveBeenCalledExactlyOnceWith(TEMPLATE_DIR, JINN_HOME, buildTemplateReplacements("Hanako"));
    expect(output()).toMatch(/\[new skill\] status/);
    expect(fs.symlinkSync).toHaveBeenCalledWith(path.join("..", "..", "skills", "status"), link);
  });

  it("says once why the sync is not in play", async () => {
    vi.mocked(compareSemver).mockReturnValueOnce(0);
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(output().split("\n").filter((line) => /symlink/.test(line))).toHaveLength(1);
  });

  it("--check adds nothing", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ check: true });

    expect(mockStage).not.toHaveBeenCalled();
  });

  it("reports a failure to add them and goes on to the migrations", async () => {
    // The user's skill store can be on another volume, where the final rename fails.
    mockStage.mockImplementation(() => { throw new Error("EXDEV: cross-device link not permitted\nforged line"); });
    const { runMigrate } = await import("../migrate.js");

    await expect(runMigrate({})).resolves.toBeUndefined();

    expect(output()).toMatch(/EXDEV: cross-device link not permitted forged line/);
    expect(mockExecFileSync).toHaveBeenCalledOnce();
  });

  it("--auto copies a migration's new skill file into skills/", async () => {
    shipInMigration(["skills/status/SKILL.md"], ["skills/status/SKILL.md"]);
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(createdUnderSkills()).toContain(path.join(skillsDir, "status", "SKILL.md"));
    expect(output()).toMatch(/\[new\] skills.status.SKILL\.md/);
    expect(stampedVersions()).toEqual(["1.1.0"]);
  });

  it("--auto leaves a skill file the home already has to the AI run, which can finish it", async () => {
    shipInMigration(["skills/status/SKILL.md"], []);
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(output()).toMatch(/\[skip\] skills.status.SKILL\.md \(exists — needs AI merge\)/);
    expect(stampedVersions()).toEqual([]);
    expect(output()).toMatch(/Run ryoko migrate \(without --auto\)/);
  });

  it("stages the migrate skill when the home has none", async () => {
    mockExistsSync.mockImplementation((file) => !String(file).startsWith(path.join(skillsDir, "migrate")));
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    // Into the user's own store, resolved once as theirs: nothing below it is followed.
    expect(mockPlaceTree).toHaveBeenCalledWith(path.join(TEMPLATE_DIR, "skills", "migrate"), skillsDir, "migrate");
    expect(output()).toMatch(/\[staged\] migrate スキル/);
    expect(prompt()).toContain(path.join(skillsDir, "migrate", "SKILL.md"));
  });

  it("the AI run is started and told to merge skills itself, not to leave them alone", async () => {
    shipInMigration(["skills/status/SKILL.md"], []);
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    expect(mockExecFileSync).toHaveBeenCalledOnce();
    expect(prompt()).toContain(path.join(skillsDir, "migrate", "SKILL.md"));
    expect(prompt()).toMatch(/symlink.*sync does not run/);
    expect(prompt()).toMatch(/files\/skills\//);
    // Told to keep out of skills/ and then to record the version, it would drop every
    // skill change the migration ships, for good.
    expect(prompt()).not.toMatch(/[Dd]o not (create|touch)|did not run|synced before/);
  });
});

describe.each([
  ["the sync fails", () => mockSync.mockImplementation(() => { throw new Error("receipt is unreadable"); }), /receipt is unreadable/],
  ["a newer OpenRyoko synced the home last", () => mockSync.mockReturnValue(synced({ skipped: "newer-receipt" })), /より新しい OpenRyoko/],
  ["the receipt is in a newer format", () => mockSync.mockReturnValue(synced({ skipped: "newer-format" })), /より新しい OpenRyoko/],
])("migrate: when %s", (_label, arrange, reason) => {
  // Nobody knows which skills were deleted, retired or edited. Nothing may be created
  // under skills/, and no migration may be recorded as applied.
  beforeEach(() => {
    resetMigrateMocks();
    mockStage.mockReset();
    mockStage.mockReturnValue([]);
    // Migration 1.1.0 ships a skill file; the home has no skills/migrate at all.
    shipInMigration(["skills/migrate/SKILL.md"], ["skills/migrate"]);
    arrange();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
    vi.mocked(console.error).mockRestore();
    process.exitCode = undefined;
  });

  it("--auto creates nothing under skills/ and does not call the update done", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    // Any of these files might put back something the operator removed.
    expect(createdUnderSkills()).toEqual([]);
    expect(mockStage).not.toHaveBeenCalled();
    expect(fs.symlinkSync).not.toHaveBeenCalled();
    expect(output()).not.toMatch(/\[staged\] migrate スキル|\[new\] skills/);
    expect(stampedVersions()).toEqual([]);
  });

  it("--auto does not send the operator to a `ryoko migrate` that would refuse", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    const guidance = output().slice(output().indexOf("Version was not updated"));
    expect(guidance).toMatch(/^Version was not updated/);
    expect(guidance).not.toMatch(/Run ryoko migrate \(without --auto\) to merge/);
    // It names what is in the way, and what to do about it before anything else can run.
    expect(guidance).toMatch(reason);
    expect(guidance).toMatch(/同梱スキルを同期でき/);
    expect(guidance).toMatch(/ryoko migrate を再実行/);
  });

  it("--auto says the same when what is left over has nothing to do with skills", async () => {
    shipInMigration(["docs/guide.md"], []);
    arrange();
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    const guidance = output().slice(output().indexOf("Version was not updated"));
    expect(guidance).not.toMatch(/Run ryoko migrate \(without --auto\) to merge/);
    expect(guidance).toMatch(reason);
  });

  it("--auto still completes a migration that ships nothing for skills", async () => {
    shipInMigration(["docs/guide.md"], ["docs/guide.md"]);
    arrange();
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(stampedVersions()).toEqual(["1.1.0"]);
  });

  it("`ryoko migrate` does not start the AI, which would record the version with the skills never merged", async () => {
    const { runMigrate } = await import("../migrate.js");

    await expect(runMigrate({})).resolves.toBeUndefined();

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(stampedVersions()).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(errors()).toMatch(reason);
    expect(errors()).toMatch(/ryoko migrate を再実行/);
  });

  it("`ryoko migrate` stages nothing either: the home is left as it was", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    expect(createdInHome()).toEqual([]);
    expect(output()).not.toMatch(/\[staged\]/);
  });

  it("ends normally when no migration is pending: the sync's failure is reported, not fatal", async () => {
    vi.mocked(compareSemver).mockReturnValueOnce(0);
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    expect(output()).toMatch(reason);
    expect(process.exitCode).toBeUndefined();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

describe("migrate: a sync error repeated in the guidance", () => {
  beforeEach(() => {
    resetMigrateMocks();
    shipInMigration(["skills/migrate/SKILL.md"], ["skills/migrate"]);
    mockSync.mockImplementation(() => { throw new Error("EACCES: open 'a\n[done] everything is fine\u001b[2K\u001b[1A'"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
    vi.mocked(console.error).mockRestore();
    process.exitCode = undefined;
  });

  it.each([{ auto: true }, {}])("carries nothing that could redraw the terminal or pass for a line of its own (%j)", async (opts) => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate(opts);

    const printed = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].map((call) => String(call[0]));
    const repeated = printed.filter((line) => line.includes("everything is fine"));
    // Once where the sync is reported, and once where the operator is told what to do.
    expect(repeated).toHaveLength(2);
    for (const line of repeated) expect(line.replace(/\u001b\[\d+m/g, "")).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});
