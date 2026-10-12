// Shared by the migrate suites. Each suite declares its own vi.mock() calls (they are
// hoisted per test file); what is imported here resolves to those mocks.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { updateConfigDocument } from "../../shared/config-file.js";
import { placeTree, removePlacedTree } from "../home-copy.js";
import { syncInstanceBundledSkills } from "../../skills-sync/instance.js";
import type { BundledSkillSync } from "../../skills-sync/types.js";

export const mockExecFileSync = vi.mocked(execFileSync);
export const mockExistsSync = vi.mocked(fs.existsSync);
export const mockReaddirSync = vi.mocked(fs.readdirSync);
export const mockWriteFileSync = vi.mocked(fs.writeFileSync);
export const mockRmSync = vi.mocked(fs.rmSync);
export const mockSync = vi.mocked(syncInstanceBundledSkills);
export const mockLstatSync = vi.mocked(fs.lstatSync);
export const mockPlaceTree = vi.mocked(placeTree);
export const mockRemovePlacedTree = vi.mocked(removePlacedTree);
export const mockUpdateConfigDocument = vi.mocked(updateConfigDocument);

export const missing = (file: unknown) => Object.assign(new Error(`ENOENT: no such file or directory, lstat '${String(file)}'`), { code: "ENOENT" });
export const stat = (kind: "file" | "symlink") => ({ isFile: () => kind === "file", isDirectory: () => false, isSymbolicLink: () => kind === "symlink" }) as fs.Stats;

/** Whatever existsSync reports as present is an ordinary entry; the rest is absent. */
export function lstatLikeExists(): void {
  mockLstatSync.mockImplementation(((file: fs.PathLike) => {
    if (fs.existsSync(file)) return stat("file");
    throw missing(file);
  }) as typeof fs.lstatSync);
}

/** What the bundled skill sync reports: nothing done, unless a test says otherwise. */
export function synced(overrides: Partial<BundledSkillSync> = {}): BundledSkillSync {
  return { added: [], updated: [], adopted: [], retired: [], kept: [], notices: [], inSync: [], failed: [], backupDir: null, ...overrides };
}

/** A directory entry, as fs.readdirSync({ withFileTypes: true }) returns it. */
export const dirent = (name: string, directory: boolean) => ({
  name,
  isDirectory: () => directory,
  isFile: () => !directory,
  isSymbolicLink: () => false,
});

/** Everything the command printed to stdout, one line per call, exactly as printed. */
export const rawOutput = () => vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join("\n");

/** The same without the colour codes, so a pattern can span a coloured tag and its text. */
export const output = () => rawOutput().replace(/\u001b\[\d+m/g, "");

/** Where package trees were placed in the home: the destination of each copy. */
export const placed = (): string[] => mockPlaceTree.mock.calls.map(([, base, ...segments]) => path.join(base, ...segments));

/** Every path the command created or wrote, by any of the ways it has. */
export const createdInHome = (): string[] => [
  ...vi.mocked(fs.mkdirSync).mock.calls.map((call) => String(call[0])),
  ...mockWriteFileSync.mock.calls.map((call) => String(call[0])),
  ...vi.mocked(fs.copyFileSync).mock.calls.map((call) => String(call[1])),
  ...placed(),
];

/**
 * The versions recorded in config.yaml, in order. The stamp goes through the shared
 * config writer: each one is an update of the config document, and what it sets
 * jinn.version to is read off by running it on a document that has another.
 */
export const stampedVersions = (): (string | undefined)[] => mockUpdateConfigDocument.mock.calls
  .map(([change]) => (change({ jinn: { version: "0.0.0" } }) as { jinn?: { version?: string } }).jinn?.version);

/** Every path exists, every directory is empty, the sync did nothing, and stdout is captured. */
export function resetMigrateMocks(): void {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  mockReaddirSync.mockReturnValue([]);
  vi.mocked(fs.readFileSync).mockReset();
  mockSync.mockReset();
  mockSync.mockReturnValue(synced());
  mockPlaceTree.mockReset();
  lstatLikeExists();
  vi.spyOn(console, "log").mockImplementation(() => {});
}
