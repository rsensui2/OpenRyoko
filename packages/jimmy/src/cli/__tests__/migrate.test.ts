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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncInstanceBundledSkills } from "../../skills-sync/instance.js";
import type { BundledSkillSync } from "../../skills-sync/types.js";
import { compareSemver, getPendingMigrations } from "../../shared/version.js";
import { CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR, CONFIG_PATH, JINN_HOME, MIGRATIONS_DIR, TEMPLATE_DIR } from "../../shared/paths.js";
import path from "node:path";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockRmSync = vi.mocked(fs.rmSync);
const mockSync = vi.mocked(syncInstanceBundledSkills);
const mockLstatSync = vi.mocked(fs.lstatSync);

const missing = (file: unknown) => Object.assign(new Error(`ENOENT: no such file or directory, lstat '${String(file)}'`), { code: "ENOENT" });
const stat = (kind: "file" | "symlink") => ({ isFile: () => kind === "file", isDirectory: () => false, isSymbolicLink: () => kind === "symlink" }) as fs.Stats;
/** Whatever existsSync reports as present is an ordinary entry; the rest is absent. */
function lstatLikeExists(): void {
  mockLstatSync.mockImplementation(((file: fs.PathLike) => {
    if (fs.existsSync(file)) return stat("file");
    throw missing(file);
  }) as typeof fs.lstatSync);
}

function synced(overrides: Partial<BundledSkillSync> = {}): BundledSkillSync {
  return { added: [], updated: [], adopted: [], retired: [], kept: [], notices: [], inSync: [], failed: [], backupDir: null, ...overrides };
}

describe("migrate: AI session launcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all paths exist
    mockExistsSync.mockReturnValue(true);
    // Empty directories (no files to copy)
    mockReaddirSync.mockReturnValue([]);
    vi.mocked(fs.readFileSync).mockReset();
    mockSync.mockReset();
    mockSync.mockReturnValue(synced());
    lstatLikeExists();
  });

  it("should NOT pass --cwd as a CLI argument to the engine binary", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    // execFileSync should have been called (AI session launched)
    expect(mockExecFileSync).toHaveBeenCalled();

    const [bin, args] = mockExecFileSync.mock.calls[0];

    // The args array must NOT contain "--cwd"
    expect(args).not.toContain("--cwd");
  });

  it("should set cwd via execFileSync options, not as a CLI flag", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    expect(mockExecFileSync).toHaveBeenCalled();

    const [_bin, _args, options] = mockExecFileSync.mock.calls[0];

    // The cwd should be set in the options object
    expect(options).toBeDefined();
    expect((options as any).cwd).toBeDefined();
    expect(typeof (options as any).cwd).toBe("string");
  });

  it("should pass -p flag with the migration prompt", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    expect(mockExecFileSync).toHaveBeenCalled();

    const [_bin, args] = mockExecFileSync.mock.calls[0];
    const argsArray = args as string[];

    expect(argsArray).toContain("-p");
  });

  it("does not stamp the target version when auto migration skips existing files", async () => {
    const { runMigrate } = await import("../migrate.js");
    const fileEntry = {
      name: "CLAUDE.md",
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false,
    };
    mockReaddirSync.mockReturnValue([fileEntry] as any);

    await runMigrate({ auto: true });

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("adds newly bundled skills even when the instance version is current", async () => {
    vi.mocked(compareSemver).mockReturnValueOnce(0);
    const { runMigrate } = await import("../migrate.js");
    await runMigrate({ auto: true });
    expect(syncInstanceBundledSkills).toHaveBeenCalledOnce();
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("adds newly bundled skills even without versioned migration scripts", async () => {
    vi.mocked(getPendingMigrations).mockReturnValueOnce([]);
    vi.mocked(fs.readFileSync).mockReturnValue("jinn:\n  version: 1.0.0\n");
    const { runMigrate } = await import("../migrate.js");
    await runMigrate({ auto: true });
    expect(syncInstanceBundledSkills).toHaveBeenCalledOnce();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("keeps --check from installing bundled skills", async () => {
    const { runMigrate } = await import("../migrate.js");
    await runMigrate({ check: true });
    expect(syncInstanceBundledSkills).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("makes newly installed skills discoverable to Claude Code and Codex", async () => {
    vi.mocked(compareSemver).mockReturnValueOnce(0);
    mockSync.mockReturnValueOnce(synced({ added: ["openryoko-config"], inSync: ["openryoko-config"] }));
    const links = [CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR].map((directory) => path.join(directory, "openryoko-config"));
    mockExistsSync.mockImplementation((file) => !links.includes(String(file)));
    const { runMigrate } = await import("../migrate.js");
    await runMigrate({ auto: true });
    for (const link of links) {
      expect(fs.symlinkSync).toHaveBeenCalledWith(path.join("..", "..", "skills", "openryoko-config"), link);
    }
  });
});

describe("migrate: bundled skill sync", () => {
  const dirent = (name: string, directory: boolean) => ({
    name,
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false,
  });

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

  const output = () => vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join("\n");
  const stampedVersions = () => mockWriteFileSync.mock.calls
    .filter(([file]) => file === CONFIG_PATH)
    .map(([, content]) => /version: (\S+)/.exec(String(content))?.[1]);

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    vi.mocked(fs.readFileSync).mockReset();
    mockSync.mockReset();
    mockSync.mockReturnValue(synced());
    lstatLikeExists();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

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

  describe.each([
    ["the sync fails", () => mockSync.mockImplementation(() => { throw new Error("receipt is unreadable"); })],
    ["skills/ is the user's own symlink", () => mockSync.mockReturnValue(synced({ skipped: "skills-root-symlink" }))],
    ["a newer OpenRyoko owns the home", () => mockSync.mockReturnValue(synced({ skipped: "newer-receipt" }))],
    ["the receipt is in a newer format", () => mockSync.mockReturnValue(synced({ skipped: "newer-format" }))],
  ])("when %s, migrate creates nothing under skills/", (_label, arrange) => {
    const skillsDir = path.join(JINN_HOME, "skills");
    const createdUnderSkills = () => [
      ...vi.mocked(fs.mkdirSync).mock.calls.map((call) => String(call[0])),
      ...mockWriteFileSync.mock.calls.map((call) => String(call[0])),
      ...vi.mocked(fs.copyFileSync).mock.calls.map((call) => String(call[1])),
    ].filter((file) => file === skillsDir || file.startsWith(skillsDir + path.sep));

    beforeEach(() => {
      // Migration 1.1.0 ships a skill file; the home has no skills/migrate at all.
      shipMigrateSkillInMigration();
      mockExistsSync.mockImplementation((file) => !String(file).startsWith(path.join(skillsDir, "migrate")));
      arrange();
    });

    it("--auto neither stages the migrate skill nor copies the migration's skill files, and does not call the update done", async () => {
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({ auto: true });

      // Without the sync's word on which skills were deleted or retired, any of these
      // files might put back something the operator removed.
      expect(createdUnderSkills()).toEqual([]);
      expect(fs.symlinkSync).not.toHaveBeenCalled();
      expect(output()).not.toMatch(/\[staged\] migrate|\[new\] skills/);
      expect(stampedVersions()).toEqual([]);
    });

    it("the AI run is told to leave skills/ alone and reads the packaged migrate skill", async () => {
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({});

      expect(createdUnderSkills()).toEqual([]);
      const prompt = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1)!;
      expect(prompt).toMatch(/did not run/i);
      expect(prompt).toMatch(/[Dd]o not create.* under skills\//);
      expect(prompt).toContain(path.join(TEMPLATE_DIR, "skills", "migrate", "SKILL.md"));
    });
  });

  it("uses the instance's migrate skill when the sync did not run but the skill is there", async () => {
    mockSync.mockImplementation(() => { throw new Error("receipt is unreadable"); });
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    const prompt = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1)!;
    expect(prompt).toContain(path.join(JINN_HOME, "skills", "migrate", "SKILL.md"));
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

  describe("when a link that leads nowhere sits where a migration's file would go", () => {
    const docs = path.join(JINN_HOME, "docs");
    const written = () => [
      ...vi.mocked(fs.mkdirSync).mock.calls.map((call) => String(call[0])),
      ...mockWriteFileSync.mock.calls.map((call) => String(call[0])),
      ...vi.mocked(fs.copyFileSync).mock.calls.map((call) => String(call[1])),
    ].filter((file) => file.startsWith(docs));

    /** Migration 1.1.0 ships docs/memory.md and docs/guides/a.md. `dangling` is a
     *  symlink whose target does not exist: existsSync says there is nothing there. */
    function shipDocs(dangling: string): void {
      const files = path.join(MIGRATIONS_DIR, "1.1.0", "files");
      const tree: Record<string, ReturnType<typeof dirent>[]> = {
        [files]: [dirent("docs", true)],
        [path.join(files, "docs")]: [dirent("guides", true), dirent("memory.md", false)],
        [path.join(files, "docs", "guides")]: [dirent("a.md", false)],
      };
      mockReaddirSync.mockImplementation(((dir: string) => tree[dir] ?? []) as never);
      vi.mocked(fs.readFileSync).mockReturnValue("jinn:\n  version: 1.0.0\n");
      mockExistsSync.mockImplementation((file) => String(file) !== dangling && !String(file).startsWith(dangling + path.sep));
      mockLstatSync.mockImplementation(((file: fs.PathLike) => {
        if (String(file) === dangling) return stat("symlink");
        if (fs.existsSync(file)) return stat("file");
        throw missing(file);
      }) as typeof fs.lstatSync);
    }

    it("--auto does not write the file through the link", async () => {
      shipDocs(path.join(docs, "memory.md"));
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({ auto: true });

      // Writing to that path would create the link's target, wherever it points.
      expect(written()).toEqual([]);
      expect(output()).toMatch(/\[skip\].*memory\.md.*needs AI merge/);
      expect(stampedVersions()).toEqual([]);
    });

    it("--auto does not create a directory through the link either", async () => {
      shipDocs(path.join(docs, "guides"));
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({ auto: true });

      expect(written().filter((file) => file.startsWith(path.join(docs, "guides")))).toEqual([]);
      expect(output()).not.toMatch(/\[new\] docs.guides/);
      // The file that belongs under it is left for a person or the AI, not dropped silently.
      expect(output()).toMatch(/\[skip\].*guides.a\.md.*needs AI merge/);
      expect(stampedVersions()).toEqual([]);
    });

    it("--auto does not call the migration applied when the only thing in the way is that link", async () => {
      const guides = path.join(docs, "guides");
      shipDocs(guides);
      // Everything else the migration ships is new and gets copied.
      mockExistsSync.mockImplementation((file) => !String(file).startsWith(docs + path.sep));
      mockLstatSync.mockImplementation(((file: fs.PathLike) => {
        if (String(file) === guides) return stat("symlink");
        if (fs.existsSync(file)) return stat("file");
        throw missing(file);
      }) as typeof fs.lstatSync);
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({ auto: true });

      expect(mockWriteFileSync.mock.calls.map((call) => String(call[0]))).toContain(path.join(docs, "memory.md"));
      expect(written().filter((file) => file.startsWith(guides))).toEqual([]);
      expect(stampedVersions()).toEqual([]);
    });

    it("--auto still uses a directory the user links somewhere that exists", async () => {
      shipDocs(path.join(docs, "nothing-dangling"));
      // docs/ is a symlink to a real directory: lstat says link, and it resolves.
      mockExistsSync.mockImplementation((file) => String(file) === docs || !String(file).startsWith(docs + path.sep));
      mockLstatSync.mockImplementation(((file: fs.PathLike) => {
        if (String(file) === docs) return stat("symlink");
        if (fs.existsSync(file)) return stat("file");
        throw missing(file);
      }) as typeof fs.lstatSync);
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({ auto: true });

      expect(mockWriteFileSync.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([path.join(docs, "memory.md"), path.join(docs, "guides", "a.md")]));
      expect(output()).not.toMatch(/needs AI merge/);
      expect(stampedVersions()).toEqual(["1.1.0"]);
    });

    it("--auto does not write where it cannot even look", async () => {
      const locked = path.join(docs, "memory.md");
      shipDocs(path.join(docs, "nothing-dangling"));
      mockExistsSync.mockImplementation((file) => !String(file).startsWith(docs + path.sep));
      mockLstatSync.mockImplementation(((file: fs.PathLike) => {
        if (String(file) === locked) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        if (fs.existsSync(file)) return stat("file");
        throw missing(file);
      }) as typeof fs.lstatSync);
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({ auto: true });

      expect(written().filter((file) => file === locked)).toEqual([]);
      expect(output()).toMatch(/\[skip\].*memory\.md.*needs AI merge/);
      expect(stampedVersions()).toEqual([]);
    });

    it("does not stage the migrate skill through a dangling skills/migrate", async () => {
      const dangling = path.join(JINN_HOME, "skills", "migrate");
      mockExistsSync.mockImplementation((file) => String(file) !== dangling && !String(file).startsWith(dangling + path.sep));
      mockLstatSync.mockImplementation(((file: fs.PathLike) => {
        if (String(file) === dangling) return stat("symlink");
        if (fs.existsSync(file)) return stat("file");
        throw missing(file);
      }) as typeof fs.lstatSync);
      mockSync.mockReturnValue(synced({ kept: [{ name: "migrate", reason: "symlink" }] }));
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({});

      expect(vi.mocked(fs.mkdirSync).mock.calls.map((call) => String(call[0])).filter((dir) => dir.startsWith(dangling))).toEqual([]);
      expect(output()).not.toMatch(/\[staged\] migrate/);
    });
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

    const skillLines = output().split("\n").filter((line) => line.includes("skill"));
    expect(skillLines.join(" ")).toContain("everything is fine");
    // Only the colour codes this command itself adds, never one from the data.
    for (const line of skillLines) expect(line.replace(/\u001b\[\d+m/g, "")).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(output().split("\n").filter((line) => line.includes("forged") && !line.includes("EROFS"))).toEqual([]);
  });

  it("carries on with the migrations when the sync cannot run", async () => {
    mockSync.mockImplementation(() => { throw new Error("receipt is unreadable"); });
    const { runMigrate } = await import("../migrate.js");

    await expect(runMigrate({})).resolves.toBeUndefined();

    expect(output()).toContain("receipt is unreadable");
    expect(mockExecFileSync).toHaveBeenCalledOnce();
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
