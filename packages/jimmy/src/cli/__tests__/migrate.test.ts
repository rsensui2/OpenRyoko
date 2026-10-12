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

import fs from "node:fs";
import path from "node:path";
import { updateConfigDocument } from "../../shared/config-file.js";
import { syncInstanceBundledSkills } from "../../skills-sync/instance.js";
import { compareSemver, getPendingMigrations } from "../../shared/version.js";
import { CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR, JINN_HOME, MIGRATIONS_DIR, TEMPLATE_DIR } from "../../shared/paths.js";
import {
  dirent, lstatLikeExists, mockExecFileSync, mockExistsSync, mockReaddirSync, mockRmSync, mockSync, mockWriteFileSync, output, resetMigrateMocks, stampedVersions, synced,
} from "./migrate-harness.js";

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
    expect(updateConfigDocument).not.toHaveBeenCalled();
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("adds newly bundled skills even when the instance version is current", async () => {
    vi.mocked(compareSemver).mockReturnValueOnce(0);
    const { runMigrate } = await import("../migrate.js");
    await runMigrate({ auto: true });
    expect(syncInstanceBundledSkills).toHaveBeenCalledOnce();
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(updateConfigDocument).not.toHaveBeenCalled();
  });

  it("adds newly bundled skills even without versioned migration scripts", async () => {
    vi.mocked(getPendingMigrations).mockReturnValueOnce([]);
    vi.mocked(fs.readFileSync).mockReturnValue("jinn:\n  version: 1.0.0\n");
    const { runMigrate } = await import("../migrate.js");
    await runMigrate({ auto: true });
    expect(syncInstanceBundledSkills).toHaveBeenCalledOnce();
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(updateConfigDocument).toHaveBeenCalledOnce(); // the version stamp
  });

  it("keeps --check from installing bundled skills", async () => {
    const { runMigrate } = await import("../migrate.js");
    await runMigrate({ check: true });
    expect(syncInstanceBundledSkills).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(updateConfigDocument).not.toHaveBeenCalled();
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

describe("migrate: migrations that need an AI session or the owner", () => {
  /** Migration 1.1.0, with this MIGRATION.md, shipping one new doc that conflicts with nothing. */
  function ship(migrationMd: string): void {
    const files = path.join(MIGRATIONS_DIR, "1.1.0", "files");
    const tree: Record<string, ReturnType<typeof dirent>[]> = {
      [files]: [dirent("docs", true)],
      [path.join(files, "docs")]: [dirent("new.md", false)],
    };
    mockReaddirSync.mockImplementation(((dir: string) => tree[dir] ?? []) as never);
    mockExistsSync.mockImplementation((file) => String(file) !== path.join(JINN_HOME, "docs", "new.md"));
    vi.mocked(fs.readFileSync).mockImplementation(((file: fs.PathOrFileDescriptor) =>
      (String(file).endsWith(path.join("1.1.0", "MIGRATION.md")) ? migrationMd : "jinn:\n  version: 1.0.0\n")) as typeof fs.readFileSync);
  }

  beforeEach(resetMigrateMocks);

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
  });

  it("--auto does not record a migration that declares auto: false, though none of its files conflict", async () => {
    ship("---\nauto: false\n---\n# 1.1.0\n\n## Confirm with the owner\n");
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    // Until now this was held back only when the migration happened to ship a file the
    // home already had. The owner's part must not depend on that accident.
    expect(stampedVersions()).toEqual([]);
    expect(mockRmSync).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(output()).toMatch(/1\.1\.0/);
    expect(output()).toMatch(/Version was not updated/);
    expect(output()).toMatch(/ryoko migrate.*\(without --auto\)/);
  });

  it("--auto still applies what it safely can from that migration", async () => {
    ship("---\nauto: false\n---\n# 1.1.0\n");
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(mockWriteFileSync.mock.calls.map((call) => String(call[0]))).toContain(path.join(JINN_HOME, "docs", "new.md"));
    expect(stampedVersions()).toEqual([]);
  });

  it("--auto records the same migration when it makes no such declaration", async () => {
    ship("# 1.1.0\n\nA new doc. Nothing to do by hand.\n");
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(stampedVersions()).toEqual(["1.1.0"]);
    expect(output()).not.toMatch(/need an AI session/);
  });

  it("--auto holds back when the declaration is unreadable rather than guess", async () => {
    ship("---\nauto: [\n---\n# 1.1.0\n");
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(stampedVersions()).toEqual([]);
  });

  it("takes the declaration from the package, which the home cannot edit", async () => {
    ship("---\nauto: false\n---\n# 1.1.0\n");
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    const reads = vi.mocked(fs.readFileSync).mock.calls.map((call) => String(call[0])).filter((file) => file.endsWith("MIGRATION.md"));
    expect(reads).toEqual([path.join(TEMPLATE_DIR, "migrations", "1.1.0", "MIGRATION.md")]);
  });

  it("the AI run is unaffected: applying such a migration is exactly its job", async () => {
    ship("---\nauto: false\n---\n# 1.1.0\n");
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({});

    expect(mockExecFileSync).toHaveBeenCalledOnce();
  });
});
