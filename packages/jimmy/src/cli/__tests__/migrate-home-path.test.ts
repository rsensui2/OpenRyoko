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

// The home exactly as the environment gave it. RYOKO_HOME=/path/ ends in a slash and
// nothing normalises it; every path joined from it is normalised, the home itself is not.
const given = vi.hoisted(() => ({ suffix: "/" }));
vi.mock("../../shared/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/paths.js")>("../../shared/paths.js");
  return { ...actual, get JINN_HOME() { return `${actual.JINN_HOME}${given.suffix}`; } };
});

import fs from "node:fs";
import path from "node:path";
import { JINN_HOME, MIGRATIONS_DIR } from "../../shared/paths.js";
import {
  dirent, missing, mockExistsSync, mockLstatSync, mockReaddirSync, mockWriteFileSync, output, resetMigrateMocks, stampedVersions, stat,
} from "./migrate-harness.js";

describe.each(["/", "//", "/."])("migrate: a home given as <home>%s", (suffix) => {
  beforeEach(() => {
    given.suffix = suffix;
    resetMigrateMocks();
  });

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
    given.suffix = "/";
  });

  /** Migration 1.1.0 ships docs/guides/a.md, and docs/guides in the home is a link whose target is gone. */
  function shipBehindDanglingLink(): string {
    const dangling = path.join(path.resolve(JINN_HOME), "docs", "guides");
    const files = path.join(MIGRATIONS_DIR, "1.1.0", "files");
    const tree: Record<string, ReturnType<typeof dirent>[]> = {
      [files]: [dirent("docs", true)],
      [path.join(files, "docs")]: [dirent("guides", true)],
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
    return dangling;
  }

  it("is the home the test means: not normalised, as the environment gave it", () => {
    expect(JINN_HOME.endsWith(suffix)).toBe(true);
    expect(path.resolve(JINN_HOME)).not.toBe(JINN_HOME);
  });

  it("--auto still sees a link that leads nowhere on the way to a migration's file", async () => {
    const dangling = shipBehindDanglingLink();
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    // Unseen, the link is created through: mkdir -p on such a path fails, and the
    // command dies half-way with the version not recorded and no word of why.
    const written = [
      ...vi.mocked(fs.mkdirSync).mock.calls.map((call) => String(call[0])),
      ...mockWriteFileSync.mock.calls.map((call) => String(call[0])),
      ...vi.mocked(fs.copyFileSync).mock.calls.map((call) => String(call[1])),
    ].filter((file) => file.startsWith(dangling));
    expect(written).toEqual([]);
    expect(output()).toMatch(/\[skip\] docs.guides.a\.md \(a link that leads nowhere is in the way/);
    expect(stampedVersions()).toEqual([]);
  });

  it("--auto writes a migration's new file where the home really is", async () => {
    const dangling = shipBehindDanglingLink();
    // Nothing dangling this time: docs/guides simply is not there yet.
    mockLstatSync.mockImplementation(((file: fs.PathLike) => {
      if (fs.existsSync(file)) return stat("file");
      throw missing(file);
    }) as typeof fs.lstatSync);
    const { runMigrate } = await import("../migrate.js");

    await runMigrate({ auto: true });

    expect(mockWriteFileSync.mock.calls.map((call) => String(call[0]))).toContain(path.join(dangling, "a.md"));
    expect(stampedVersions()).toEqual(["1.1.0"]);
  });
});
