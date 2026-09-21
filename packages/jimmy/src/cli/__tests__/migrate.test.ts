import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("../bundled-skills.js", () => ({
  stageMissingBundledSkills: vi.fn(() => []),
}));

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { stageMissingBundledSkills } from "../bundled-skills.js";
import { compareSemver, getPendingMigrations } from "../../shared/version.js";
import { CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR } from "../../shared/paths.js";
import path from "node:path";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockRmSync = vi.mocked(fs.rmSync);

describe("migrate: AI session launcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all paths exist
    mockExistsSync.mockReturnValue(true);
    // Empty directories (no files to copy)
    mockReaddirSync.mockReturnValue([]);
    vi.mocked(fs.readFileSync).mockReset();
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
    expect(stageMissingBundledSkills).toHaveBeenCalledOnce();
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("adds newly bundled skills even without versioned migration scripts", async () => {
    vi.mocked(getPendingMigrations).mockReturnValueOnce([]);
    vi.mocked(fs.readFileSync).mockReturnValue("jinn:\n  version: 1.0.0\n");
    const { runMigrate } = await import("../migrate.js");
    await runMigrate({ auto: true });
    expect(stageMissingBundledSkills).toHaveBeenCalledOnce();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("keeps --check from installing bundled skills", async () => {
    const { runMigrate } = await import("../migrate.js");
    await runMigrate({ check: true });
    expect(stageMissingBundledSkills).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it("makes newly installed skills discoverable to Claude Code and Codex", async () => {
    vi.mocked(compareSemver).mockReturnValueOnce(0);
    vi.mocked(stageMissingBundledSkills).mockReturnValueOnce(["openryoko-config"]);
    const links = [CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR].map((directory) => path.join(directory, "openryoko-config"));
    mockExistsSync.mockImplementation((file) => !links.includes(String(file)));
    const { runMigrate } = await import("../migrate.js");
    await runMigrate({ auto: true });
    for (const link of links) {
      expect(fs.symlinkSync).toHaveBeenCalledWith(path.join("..", "..", "skills", "openryoko-config"), link);
    }
  });
});
