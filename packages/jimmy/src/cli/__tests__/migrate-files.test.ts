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
import { JINN_HOME, MIGRATIONS_DIR, TEMPLATE_DIR } from "../../shared/paths.js";
import {
  createdInHome, dirent, missing, mockExecFileSync, mockExistsSync, mockLstatSync, mockPlaceTree, mockReaddirSync, mockSync, mockWriteFileSync, output, resetMigrateMocks, stampedVersions, stat, synced,
} from "./migrate-harness.js";

describe("migrate: where a migration's files may be written", () => {
  beforeEach(resetMigrateMocks);

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
    process.exitCode = undefined;
  });

  describe("staging the pending migrations in the home", () => {
    const prompt = () => (mockExecFileSync.mock.calls[0][1] as string[]).at(-1)!;

    it.each([{}, { auto: true }])("copies each one with the copy that follows no link in the home (%j)", async (opts) => {
      vi.mocked(fs.readFileSync).mockReturnValue("jinn:\n  version: 1.0.0\n");
      const { runMigrate } = await import("../migrate.js");

      await runMigrate(opts);

      expect(mockPlaceTree).toHaveBeenCalledWith(path.join(TEMPLATE_DIR, "migrations", "1.1.0"), JINN_HOME, "migrations", "1.1.0");
      // And by no other way: a plain copy writes over whatever a link at MIGRATION.md points to.
      expect(vi.mocked(fs.copyFileSync)).not.toHaveBeenCalled();
      expect(vi.mocked(fs.mkdirSync).mock.calls.map((call) => String(call[0])).filter((dir) => dir.startsWith(MIGRATIONS_DIR))).toEqual([]);
      expect(output()).toMatch(/\[staged\] 1\.1\.0/);
    });

    it.each([{}, { auto: true }])("stops when a migration cannot be staged: nothing is applied and the version is not recorded (%j)", async (opts) => {
      vi.mocked(fs.readFileSync).mockReturnValue("jinn:\n  version: 1.0.0\n");
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockPlaceTree.mockImplementation(() => { throw new Error(`${MIGRATIONS_DIR} is not a plain directory, so nothing was written into it\u001b[2K\nforged`); });
      const { runMigrate } = await import("../migrate.js");

      await expect(runMigrate(opts)).resolves.toBeUndefined();

      expect(process.exitCode).toBe(1);
      expect(mockExecFileSync).not.toHaveBeenCalled();
      expect(stampedVersions()).toEqual([]);
      expect(output()).not.toMatch(/\[staged\]|自動適用中/);
      const said = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
      const reason = said.find((line) => line.includes("is not a plain directory")) ?? "";
      expect(reason).toContain("forged");
      expect(reason.replace(/\u001b\[\d+m/g, "")).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(said.join("\n")).toMatch(/ryoko migrate を再実行/);
      vi.mocked(console.error).mockRestore();
    });

    it("stages the migrate skill under the home's own skills/, where nothing may be a link", async () => {
      const skill = path.join(JINN_HOME, "skills", "migrate");
      mockExistsSync.mockImplementation((file) => !String(file).startsWith(skill));
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({});

      expect(mockPlaceTree).toHaveBeenCalledWith(path.join(TEMPLATE_DIR, "skills", "migrate"), JINN_HOME, "skills", "migrate");
      expect(output()).toMatch(/\[staged\] migrate スキル/);
      expect(prompt()).toContain(path.join(skill, "SKILL.md"));
    });

    it("goes on with the packaged migrate skill when the instance's cannot be staged", async () => {
      const skill = path.join(JINN_HOME, "skills", "migrate");
      mockExistsSync.mockImplementation((file) => !String(file).startsWith(skill));
      mockPlaceTree.mockImplementation((_source, _base, ...segments) => {
        if (segments.includes("skills")) throw new Error("skills/migrate is not a plain directory\nforged");
      });
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({});

      expect(mockExecFileSync).toHaveBeenCalledOnce();
      expect(prompt()).toContain(path.join(TEMPLATE_DIR, "skills", "migrate", "SKILL.md"));
      expect(output()).not.toMatch(/\[staged\] migrate スキル/);
      expect(output()).toMatch(/migrate スキルを配置できませんでした.*is not a plain directory forged/);
      expect(fs.symlinkSync).not.toHaveBeenCalled();
    });
  });

  describe("--auto creating a migration's new file", () => {
    const docs = path.join(JINN_HOME, "docs");

    afterEach(() => {
      mockWriteFileSync.mockReset();
      vi.mocked(fs.copyFileSync).mockReset();
    });

    /** Migration 1.1.0 ships docs/new.md (a template) and docs/logo.png (copied as is); the home has neither. */
    function shipNewFiles(): void {
      const files = path.join(MIGRATIONS_DIR, "1.1.0", "files");
      const tree: Record<string, ReturnType<typeof dirent>[]> = {
        [files]: [dirent("docs", true)],
        [path.join(files, "docs")]: [dirent("logo.png", false), dirent("new.md", false)],
      };
      mockReaddirSync.mockImplementation(((dir: string) => tree[dir] ?? []) as never);
      vi.mocked(fs.readFileSync).mockReturnValue("jinn:\n  version: 1.0.0\n");
      mockExistsSync.mockImplementation((file) => !String(file).startsWith(docs + path.sep));
    }

    it("creates it exclusively, so a link put there after the look is not written through", async () => {
      shipNewFiles();
      const { runMigrate } = await import("../migrate.js");

      await runMigrate({ auto: true });

      const files = path.join(MIGRATIONS_DIR, "1.1.0", "files");
      expect(mockWriteFileSync).toHaveBeenCalledWith(path.join(docs, "new.md"), expect.any(String), expect.objectContaining({ flag: "wx" }));
      expect(fs.copyFileSync).toHaveBeenCalledWith(path.join(files, "docs", "logo.png"), path.join(docs, "logo.png"), fs.constants.COPYFILE_EXCL);
      expect(stampedVersions()).toEqual(["1.1.0"]);
    });

    it("leaves a file that turns out to be there after all to the AI merge, like any that exists", async () => {
      shipNewFiles();
      const taken = () => Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
      mockWriteFileSync.mockImplementation((file) => { if (String(file) === path.join(docs, "new.md")) throw taken(); });
      vi.mocked(fs.copyFileSync).mockImplementation(() => { throw taken(); });
      const { runMigrate } = await import("../migrate.js");

      await expect(runMigrate({ auto: true })).resolves.toBeUndefined();

      expect(output()).toMatch(/\[skip\] docs.new\.md \(exists — needs AI merge\)/);
      expect(output()).toMatch(/\[skip\] docs.logo\.png \(exists — needs AI merge\)/);
      expect(output()).not.toMatch(/\[new\] docs.(new\.md|logo\.png)/);
      expect(stampedVersions()).toEqual([]);
    });

    it("does not take any other failure to write for a file that exists", async () => {
      shipNewFiles();
      mockWriteFileSync.mockImplementation((file) => { if (String(file) === path.join(docs, "new.md")) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); });
      const { runMigrate } = await import("../migrate.js");

      await expect(runMigrate({ auto: true })).rejects.toThrow(/ENOSPC/);

      expect(stampedVersions()).toEqual([]);
    });
  });

  describe("when a link that leads nowhere sits where a migration's file would go", () => {
    const docs = path.join(JINN_HOME, "docs");
    const written = () => createdInHome().filter((file) => file.startsWith(docs));

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

      expect(createdInHome().filter((dir) => dir.startsWith(dangling))).toEqual([]);
      expect(output()).not.toMatch(/\[staged\] migrate/);
      // The AI is not pointed at a skill that is not there: it reads the packaged copy.
      const prompt = (mockExecFileSync.mock.calls[0][1] as string[]).at(-1)!;
      expect(prompt).toContain(path.join(TEMPLATE_DIR, "skills", "migrate", "SKILL.md"));
      expect(prompt).not.toContain(path.join(dangling, "SKILL.md"));
    });
  });
});
