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

import fs from "node:fs";
import path from "node:path";
import type { BundledSkillSync } from "../../skills-sync/types.js";
import { compareSemver } from "../../shared/version.js";
import { JINN_HOME, MIGRATIONS_DIR, TEMPLATE_DIR } from "../../shared/paths.js";
import {
  dirent, mockExecFileSync, mockExistsSync, mockReaddirSync, mockRmSync, mockSync, mockWriteFileSync, output, rawOutput, resetMigrateMocks, stampedVersions, synced,
} from "./migrate-harness.js";

describe("migrate: bundled skill sync", () => {
  /** Migration 1.1.0 ships one file: a newer skills/migrate/SKILL.md. */
  function shipMigrateSkillInMigration(): void {
    const files = path.join(MIGRATIONS_DIR, "1.1.0", "files");
    const tree: Record<string, ReturnType<typeof dirent>[]> = {
      [files]: [dirent("skills", true)],
      [path.join(files, "skills")]: [dirent("migrate", true)],
      [path.join(files, "skills", "migrate")]: [dirent("SKILL.md", false)],
    };
    mockReaddirSync.mockImplementation(((dir: string) => tree[dir] ?? []) as never);
    vi.mocked(fs.readFileSync).mockReturnValue("jinn:\n  version: 1.0.0\n");
  }

  beforeEach(resetMigrateMocks);

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
  });

  it("reports what the sync replaced, retired and left alone, and where the previous copies are", async () => {
    vi.mocked(compareSemver).mockReturnValueOnce(0);
    const backupDir = path.join(JINN_HOME, ".migration-backups", "1.1.0-2026-10-12T03-04-05-678Z");
    mockSync.mockReturnValueOnce(synced({
      updated: ["onboarding"],
      retired: ["old-skill"],
      kept: [
        { name: "migrate", reason: "modified" },
        { name: "new", reason: "deleted" },
        { name: "status", reason: "symlink" },
        { name: "self-heal", reason: "customized" },
      ],
      backupDir,
    }));
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    const text = output();
    expect(text).toMatch(/\[updated skill\].*onboarding/);
    expect(text).toMatch(/\[retired skill\].*old-skill/);
    expect(text).toContain(backupDir);
    expect(text).toMatch(/\[skill kept\].*migrate/);
    // A skill the operator deleted is left out, with the one way to get it back.
    expect(text).toMatch(/\[skill kept\].* new \(.*ryoko migrate --restore-deleted-skills new\)/);
    // A symlink or an edit with no shipped update pending needs nothing from the user.
    expect(text).not.toMatch(/status|self-heal/);
    expect(fs.symlinkSync).not.toHaveBeenCalled();
  });

  it("names a skill the sync could not read or found too large, and what it cleared away", async () => {
    vi.mocked(compareSemver).mockReturnValueOnce(0);
    mockSync.mockReturnValueOnce(synced({
      kept: [{ name: "locked", reason: "unreadable" }, { name: "huge", reason: "too-large" }],
      clearedStaging: [".bundled-skill-Ab3xYz"],
    }));
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(output()).toMatch(/\[skill kept\] locked \(.*読めない/);
    expect(output()).toMatch(/\[skill kept\] huge \(.*上限を超え/);
    expect(output()).toMatch(/\[skills\] .*中断.*\.bundled-skill-Ab3xYz/);
  });

  it.each([{}, { auto: true }, { fix: true }])("leaves skills the operator deleted out, like a gateway start (%j)", async (opts) => {
    // --auto finishes by stamping the version, so there has to be a config to stamp.
    vi.mocked(fs.readFileSync).mockReturnValue("jinn:\n  version: 1.0.0\n");
    const { runMigrate } = await import("../migrate.js");

    await runMigrate(opts);

    // `ryoko update` runs `migrate --auto`: an update must not undo a deletion either.
    expect(mockSync).toHaveBeenCalledExactlyOnceWith({ restoreDeleted: false });
  });

  it.each([{}, { auto: true }, { fix: true }])("puts deleted skills back only with --restore-deleted-skills (%j)", async (opts) => {
    vi.mocked(fs.readFileSync).mockReturnValue("jinn:\n  version: 1.0.0\n");
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ ...opts, restoreDeletedSkills: true });

    expect(mockSync).toHaveBeenCalledExactlyOnceWith({ restoreDeleted: true });
  });

  it("passes on the names given to --restore-deleted-skills, so only those come back", async () => {
    vi.mocked(compareSemver).mockReturnValueOnce(0);
    mockSync.mockReturnValue(synced({ added: ["status"] }));
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ restoreDeletedSkills: ["status", "no-such-skill"] });

    expect(mockSync).toHaveBeenCalledExactlyOnceWith({ restoreDeleted: ["status", "no-such-skill"] });
    // A name that restored nothing is said out loud rather than silently ignored.
    expect(output()).toMatch(/no-such-skill.*削除済みの同梱スキルではない/);
    expect(output()).not.toMatch(/status.*削除済みの同梱スキルではない/);
  });

  it("stays read-only under --check even when asked to restore", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ check: true, restoreDeletedSkills: true });

    expect(mockSync).not.toHaveBeenCalled();
  });

  describe("when the operator deleted the migrate skill and a migration ships it", () => {
    const deletedSkill = path.join(JINN_HOME, "skills", "migrate");
    const touched = (mock: { mock: { calls: unknown[][] } }) => mock.mock.calls.map((call) => String(call[0])).filter((file) => file.startsWith(deletedSkill));
    const prompt = () => (mockExecFileSync.mock.calls[0][1] as string[]).at(-1)!;

    beforeEach(() => {
      shipMigrateSkillInMigration();
      mockExistsSync.mockImplementation((file) => !String(file).startsWith(deletedSkill));
      mockSync.mockReturnValue(synced({ kept: [{ name: "migrate", reason: "deleted" }, { name: "status", reason: "deleted" }] }));
    });

    it("--auto does not recreate it from the migration's files, and has nothing left to merge", async () => {
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({ auto: true });

      expect(touched(vi.mocked(fs.mkdirSync))).toEqual([]);
      expect(touched(vi.mocked(fs.copyFileSync))).toEqual([]);
      expect(touched(mockWriteFileSync)).toEqual([]);
      expect(fs.symlinkSync).not.toHaveBeenCalled();
      expect(output()).not.toMatch(/needs AI merge|\[new\]|\[staged\] migrate/);
      // Nothing was skipped for the AI, so the update is complete.
      expect(stampedVersions()).toEqual(["1.1.0"]);
    });

    it("the AI run reads the packaged migrate skill instead of putting the deleted one back", async () => {
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({});

      expect(touched(vi.mocked(fs.mkdirSync))).toEqual([]);
      expect(touched(vi.mocked(fs.copyFileSync))).toEqual([]);
      expect(output()).not.toMatch(/\[staged\] migrate/);
      expect(mockExecFileSync).toHaveBeenCalledOnce();
      expect(prompt()).toContain(path.join(TEMPLATE_DIR, "skills", "migrate", "SKILL.md"));
      expect(prompt()).not.toContain(path.join(deletedSkill, "SKILL.md"));
    });

    it("the AI is told which skills the operator deleted, so it does not copy them back", async () => {
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({});

      // The instance may still hold an older migrate skill that predates tombstones.
      expect(prompt()).toMatch(/deleted.*: migrate, status\b/);
      expect(prompt()).toMatch(/do not recreate/i);
    });
  });

  describe("when a migration ships files for a skill the sync manages", () => {
    const skillsDir = path.join(JINN_HOME, "skills");
    /** Everything written under skills/, by any of the three ways migrate writes. */
    const created = () => [
      ...vi.mocked(fs.mkdirSync).mock.calls.map((call) => String(call[0])),
      ...mockWriteFileSync.mock.calls.map((call) => String(call[0])),
      ...vi.mocked(fs.copyFileSync).mock.calls.map((call) => String(call[1])),
    ].filter((file) => file.startsWith(skillsDir));

    /** Migration 1.1.0 ships these files; none of the listed paths exist in the home yet. */
    function shipInMigration(skill: string, fileNames: string[], missingInHome: string[]): void {
      const files = path.join(MIGRATIONS_DIR, "1.1.0", "files");
      const tree: Record<string, ReturnType<typeof dirent>[]> = {
        [files]: [dirent("skills", true)],
        [path.join(files, "skills")]: [dirent(skill, true)],
        [path.join(files, "skills", skill)]: fileNames.map((name) => dirent(name, false)),
      };
      mockReaddirSync.mockImplementation(((dir: string) => tree[dir] ?? []) as never);
      vi.mocked(fs.readFileSync).mockReturnValue("jinn:\n  version: 1.0.0\n");
      const missing = missingInHome.map((relative) => path.join(skillsDir, relative));
      mockExistsSync.mockImplementation((file) => !missing.includes(String(file)));
    }

    it("--auto adds nothing to a skill that is in sync, not even a file the shipped version no longer has", async () => {
      // The migration predates the current skill: it still carries a file since dropped.
      // Copied in as "new", it would make the skill look edited and stop its updates for good.
      shipInMigration("migrate", ["SKILL.md", "dropped-since.md"], ["migrate/dropped-since.md"]);
      mockSync.mockReturnValue(synced({ inSync: ["migrate"] }));
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({ auto: true });

      expect(created()).toEqual([]);
      expect(output()).not.toMatch(/\[new\]|needs AI merge/);
      expect(stampedVersions()).toEqual(["1.1.0"]);
    });

    it("--auto does not rebuild a skill the sync has just retired", async () => {
      shipInMigration("old-skill", ["SKILL.md"], ["old-skill", "old-skill/SKILL.md"]);
      mockSync.mockReturnValue(synced({ retired: ["old-skill"] }));
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({ auto: true });

      expect(created()).toEqual([]);
      expect(fs.symlinkSync).not.toHaveBeenCalled();
      expect(output()).not.toMatch(/\[new\]|needs AI merge/);
      expect(stampedVersions()).toEqual(["1.1.0"]);
    });

    it("the AI is told which skills were retired, so it does not rebuild them either", async () => {
      shipInMigration("old-skill", ["SKILL.md"], ["old-skill", "old-skill/SKILL.md"]);
      mockSync.mockReturnValue(synced({ retired: ["old-skill", "older-skill"] }));
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({});

      const prompt = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1)!;
      expect(prompt).toMatch(/retired.*: old-skill, older-skill\b/);
      expect(prompt).toMatch(/do not recreate/i);
    });
  });

  it("says so when the receipt could not be saved, and still honours what the sync found", async () => {
    shipMigrateSkillInMigration();
    mockExistsSync.mockImplementation((file) => !String(file).startsWith(path.join(JINN_HOME, "skills", "migrate")));
    mockSync.mockReturnValue(synced({ kept: [{ name: "migrate", reason: "deleted" }], receiptError: "EROFS: read-only file system" }));
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(output()).toMatch(/受領証.*保存できません.*EROFS/);
    // The deletion is still known, so the deleted skill is still not recreated.
    expect(vi.mocked(fs.mkdirSync).mock.calls.map((call) => String(call[0])).filter((dir) => dir.startsWith(path.join(JINN_HOME, "skills", "migrate")))).toEqual([]);
    expect(stampedVersions()).toEqual(["1.1.0"]);
  });

  it("points the AI at the instance's own migrate skill and mentions no deletions when there are none", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    const prompt = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1)!;
    expect(prompt).toContain(path.join(JINN_HOME, "skills", "migrate", "SKILL.md"));
    expect(prompt).not.toMatch(/deleted|retired|left untouched|up to date/i);
  });

  describe("what the AI is told about bundled skills", () => {
    // The AI runs after the sync and never sees this command's output, and the migrate
    // skill in the home may predate the sync. What it must know travels in the prompt.
    const promptFor = async (result: Partial<BundledSkillSync>) => {
      mockSync.mockReturnValue(synced(result));
      const { runMigrate } = await import("../migrate.js");
      await runMigrate({});
      return (mockExecFileSync.mock.calls[0][1] as string[]).at(-1)!;
    };

    it("says that the sync ran even with nothing to list, so silence only ever means it was not asked", async () => {
      // The migrate skill treats a prompt that says nothing about the sync as "started
      // from chat": this command must never leave that impression.
      const prompt = await promptFor({});

      expect(prompt).toMatch(/Bundled skills were synced before this session started/);
    });

    it("names the skills that are already up to date, so it applies nothing to them", async () => {
      const prompt = await promptFor({ added: ["sync"], updated: ["status"], inSync: ["cron-manager", "status", "sync"] });

      expect(prompt).toMatch(/synced before/i);
      expect(prompt).toMatch(/up to date.*: cron-manager, status, sync\b/);
      expect(prompt).toMatch(/files\/skills\//);
    });

    it("names each skill the sync left alone with the reason, and what to do about it", async () => {
      const prompt = await promptFor({
        inSync: ["sync"],
        kept: [
          { name: "migrate", reason: "modified" },
          { name: "onboarding", reason: "unmanaged" },
          { name: "self-heal", reason: "customized" },
          { name: "status", reason: "symlink" },
        ],
      });

      expect(prompt).toMatch(/^- migrate: .*edited.*newer version.*keep/m);
      expect(prompt).toMatch(/^- self-heal: .*edited.*[Ll]eave/m);
      expect(prompt).toMatch(/^- status: .*symlink.*[Dd]o not touch/m);
      // An unrecorded skill is not presumed customized: with no additions of the
      // user's it simply takes the migration's copy.
      expect(prompt).toMatch(/^- onboarding: .*nothing records.*as is.*otherwise merge/m);
    });

    it("lists a deleted skill once, under the deleted ones", async () => {
      const prompt = await promptFor({ kept: [{ name: "new", reason: "deleted" }, { name: "migrate", reason: "modified" }] });

      expect(prompt.match(/\bnew\b/g)).toHaveLength(1);
      expect(prompt).toMatch(/deleted.*: new\b/);
      expect(prompt).toMatch(/^- migrate: /m);
    });
  });

  it("prints nothing from the home that could redraw the terminal or pass for a line of its own", async () => {
    vi.mocked(compareSemver).mockReturnValueOnce(0);
    mockSync.mockReturnValue(synced({
      failed: [{ name: "migrate", error: "EACCES: open 'a\n[done] everything is fine\u001b[2K\u001b[1A'" }],
      receiptError: "EROFS\r\nforged",
    }));
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    const skillLines = rawOutput().split("\n").filter((line) => line.includes("skill"));
    expect(skillLines.join(" ")).toContain("everything is fine");
    // Only the colour codes this command itself adds, never one from the data.
    for (const line of skillLines) expect(line.replace(/\u001b\[\d+m/g, "")).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(output().split("\n").filter((line) => line.includes("forged") && !line.includes("EROFS"))).toEqual([]);
  });

  it("--auto counts a migration's files for an in-sync bundled skill as applied and completes", async () => {
    shipMigrateSkillInMigration();
    mockSync.mockReturnValueOnce(synced({ updated: ["migrate"], inSync: ["migrate", "status"] }));
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(output()).not.toMatch(/needs AI merge/);
    expect(stampedVersions()).toEqual(["1.1.0"]);
    expect(mockRmSync).toHaveBeenCalledWith(MIGRATIONS_DIR, { recursive: true, force: true });
  });

  it("--auto still leaves a customized skill's migration files to the AI merge", async () => {
    shipMigrateSkillInMigration();
    mockSync.mockReturnValueOnce(synced({ kept: [{ name: "migrate", reason: "modified" }], inSync: ["status"] }));
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(output()).toMatch(/\[skip\].*skills.migrate.SKILL\.md.*needs AI merge/);
    expect(stampedVersions()).toEqual([]);
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("--auto never mistakes a file outside skills/<name>/ for a synced skill file", async () => {
    const files = path.join(MIGRATIONS_DIR, "1.1.0", "files");
    const tree: Record<string, ReturnType<typeof dirent>[]> = {
      [files]: [dirent("docs", true), dirent("migrate", false)],
      [path.join(files, "docs")]: [dirent("migrate", true)],
      [path.join(files, "docs", "migrate")]: [dirent("SKILL.md", false)],
    };
    mockReaddirSync.mockImplementation(((dir: string) => tree[dir] ?? []) as never);
    mockSync.mockReturnValueOnce(synced({ inSync: ["migrate", "docs", "skills"] }));
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    const skipped = output().split("\n").filter((line) => line.includes("needs AI merge"));
    expect(skipped).toHaveLength(2);
    expect(stampedVersions()).toEqual([]);
  });
});
