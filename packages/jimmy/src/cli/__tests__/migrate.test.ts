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
    expect(text).toMatch(/\[skill kept\].* new \(.*ryoko migrate --restore-deleted-skills\)/);
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

  it("points the AI at the instance's own migrate skill and mentions no deletions when there are none", async () => {
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    const prompt = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1)!;
    expect(prompt).toContain(path.join(JINN_HOME, "skills", "migrate", "SKILL.md"));
    expect(prompt).not.toMatch(/deleted/i);
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
      [files]: [dirent("docs", true), dirent("skills", true), dirent("migrate", false)],
      [path.join(files, "docs")]: [dirent("migrate", true)],
      [path.join(files, "docs", "migrate")]: [dirent("SKILL.md", false)],
      [path.join(files, "skills")]: [dirent("migrate", false)],
    };
    mockReaddirSync.mockImplementation(((dir: string) => tree[dir] ?? []) as never);
    mockSync.mockReturnValueOnce(synced({ inSync: ["migrate", "docs", "skills"] }));
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    const skipped = output().split("\n").filter((line) => line.includes("needs AI merge"));
    expect(skipped).toHaveLength(3);
    expect(stampedVersions()).toEqual([]);
  });
});
