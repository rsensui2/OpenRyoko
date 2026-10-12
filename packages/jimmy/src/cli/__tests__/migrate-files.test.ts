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
import { JINN_HOME, MIGRATIONS_DIR } from "../../shared/paths.js";
import {
  dirent, missing, mockExistsSync, mockLstatSync, mockReaddirSync, mockSync, mockWriteFileSync, output, resetMigrateMocks, stampedVersions, stat, synced,
} from "./migrate-harness.js";

describe("migrate: where a migration's files may be written", () => {
  beforeEach(resetMigrateMocks);

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
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
});
