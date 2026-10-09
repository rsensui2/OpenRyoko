import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { logger } from "../logger.js";
import {
  claudeAutoMemoryCandidates,
  claudeAutoMemoryEnv,
  claudeAutoMemoryEnvFor,
  claudeProjectKey,
  configureClaudeAutoMemory,
  findGitRoot,
  hasLegacyAutoMemory,
  legacyAutoMemoryDir,
  resetClaudeAutoMemoryForTests,
  resolveClaudeAutoMemoryEnabled,
} from "../claude-auto-memory.js";

describe("Claude auto memory", () => {
  let root: string;
  let configDir: string;
  let instance: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    // realpath: on macOS os.tmpdir() is a symlink, and Claude Code keys projects by real path.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-auto-memory-")));
    configDir = path.join(root, "claude-config");
    instance = path.join(root, "home", ".ryoko");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(instance, { recursive: true });
    env = { CLAUDE_CONFIG_DIR: configDir };
    resetClaudeAutoMemoryForTests();
    vi.mocked(logger.warn).mockClear();
  });

  afterEach(() => {
    resetClaudeAutoMemoryForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const memoryDirFor = (projectDir: string) => path.join(configDir, "projects", claudeProjectKey(projectDir), "memory");

  function writeNote(dir: string, name = "feedback_lesson.md"): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), "lesson\n");
  }

  it("derives the project key the way Claude Code does (every non-alphanumeric becomes a dash)", () => {
    expect(claudeProjectKey("/root/.ryoko")).toBe("-root--ryoko");
    expect(claudeProjectKey("/Users/My User/.ryoko")).toBe("-Users-My-User--ryoko");
  });

  it("looks under CLAUDE_CONFIG_DIR, falling back to ~/.claude", () => {
    expect(claudeAutoMemoryCandidates(instance, env)).toEqual([memoryDirFor(instance)]);
    expect(claudeAutoMemoryCandidates("/nonexistent/.ryoko", {})).toEqual([
      path.join(os.homedir(), ".claude", "projects", "-nonexistent--ryoko", "memory"),
    ]);
  });

  it("keys a symlinked instance directory by its real path", () => {
    const link = path.join(root, "link-to-instance");
    fs.symlinkSync(instance, link);
    expect(claudeAutoMemoryCandidates(link, env)).toEqual([memoryDirFor(instance)]);
  });

  describe("git roots (Claude Code keys a project by its repository root, not the cwd)", () => {
    it("finds the repository that contains the directory", () => {
      fs.mkdirSync(path.join(root, "home", ".git"));
      expect(findGitRoot(instance)).toBe(path.join(root, "home"));
    });

    it("resolves a worktree to the main repository", () => {
      const main = path.join(root, "main");
      const worktree = path.join(root, "wt");
      fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
      fs.mkdirSync(worktree);
      fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
      expect(findGitRoot(worktree)).toBe(main);
    });

    it("returns undefined outside any repository", () => {
      expect(findGitRoot(instance)).toBeUndefined();
    });

    it("detects notes stored under the repository root's key (regression: a git-managed home hid them)", () => {
      fs.mkdirSync(path.join(root, "home", ".git"));
      writeNote(memoryDirFor(path.join(root, "home")));
      expect(claudeAutoMemoryCandidates(instance, env)).toContain(memoryDirFor(path.join(root, "home")));
      expect(legacyAutoMemoryDir(instance, env)).toBe(memoryDirFor(path.join(root, "home")));
    });
  });

  it("follows autoMemoryDirectory from the user's Claude settings", () => {
    const custom = path.join(root, "custom-memory");
    fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({ autoMemoryDirectory: custom }));
    writeNote(custom);
    expect(legacyAutoMemoryDir(instance, env)).toBe(custom);
  });

  it("ignores a broken Claude settings file instead of failing the spawn", () => {
    fs.writeFileSync(path.join(configDir, "settings.json"), "{ not json");
    expect(legacyAutoMemoryDir(instance, env)).toBeUndefined();
  });

  it("reports no legacy memory when the directory is missing or holds no notes", () => {
    const dir = memoryDirFor(instance);
    expect(hasLegacyAutoMemory(dir)).toBe(false);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a memory file");
    expect(hasLegacyAutoMemory(dir)).toBe(false);
  });

  it("reports legacy memory once a Markdown note exists", () => {
    writeNote(memoryDirFor(instance), "MEMORY.md");
    expect(hasLegacyAutoMemory(memoryDirFor(instance))).toBe(true);
  });

  it("treats a symlinked memory directory as already migrated", () => {
    const migrated = path.join(instance, "knowledge", "notes");
    writeNote(migrated);
    fs.mkdirSync(path.dirname(memoryDirFor(instance)), { recursive: true });
    fs.symlinkSync(migrated, memoryDirFor(instance));
    expect(hasLegacyAutoMemory(memoryDirFor(instance))).toBe(false);
  });

  it("lets an explicit setting win in both directions, and otherwise follows the legacy notes", () => {
    expect(resolveClaudeAutoMemoryEnabled(undefined, false)).toBe(false);
    expect(resolveClaudeAutoMemoryEnabled(undefined, true)).toBe(true);
    expect(resolveClaudeAutoMemoryEnabled(true, false)).toBe(true);
    expect(resolveClaudeAutoMemoryEnabled(false, true)).toBe(false);
  });

  it("emits the disable flag only when auto memory is off", () => {
    expect(claudeAutoMemoryEnv(false)).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    expect(claudeAutoMemoryEnv(true)).toEqual({});
  });

  describe("claudeAutoMemoryEnvFor", () => {
    it("disables auto memory for an instance that never used it, without warning", () => {
      expect(claudeAutoMemoryEnvFor(instance, env)).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("keeps it on while un-migrated notes exist and says so once per directory", () => {
      writeNote(memoryDirFor(instance));
      expect(claudeAutoMemoryEnvFor(instance, env)).toEqual({});
      expect(claudeAutoMemoryEnvFor(instance, env)).toEqual({});
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain(memoryDirFor(instance));
    });

    it("warns as soon as notes appear after boot (regression: an unflagged Claude run could re-enable it silently)", () => {
      expect(claudeAutoMemoryEnvFor(instance, env)).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
      writeNote(memoryDirFor(instance));
      expect(claudeAutoMemoryEnvFor(instance, env)).toEqual({});
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("follows an explicit setting without warning about legacy notes", () => {
      writeNote(memoryDirFor(instance));
      configureClaudeAutoMemory(false);
      expect(claudeAutoMemoryEnvFor(instance, env)).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("rejects a non-boolean setting loudly and falls back to automatic", () => {
      configureClaudeAutoMemory("false" as unknown as boolean);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(claudeAutoMemoryEnvFor(instance, env)).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    });
  });
});
