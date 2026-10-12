import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ARCHIVE_RETENTION, DEFAULT_MAX_ARCHIVE_MB, resolveBackupSettings } from "../settings.js";

const HOME = path.join(path.sep, "srv", "instances", "ryoko");
const MIB = 1024 * 1024;

describe("resolveBackupSettings", () => {
  it("is on by default, inside the home, with fourteen generations", () => {
    for (const absent of [undefined, {}]) {
      expect(resolveBackupSettings(absent, HOME)).toEqual({
        enabled: true,
        directory: path.join(HOME, "backups"),
        defaultDirectory: true,
        retention: DEFAULT_ARCHIVE_RETENTION,
        maxArchiveBytes: DEFAULT_MAX_ARCHIVE_MB * MIB,
        warnings: [],
      });
    }
    expect(DEFAULT_ARCHIVE_RETENTION).toBe(14);
  });

  it("takes every value the config sets", () => {
    const outside = path.join(path.sep, "mnt", "backups", "ryoko");

    expect(resolveBackupSettings({ enabled: false, directory: outside, retention: 3, maxArchiveMb: 64 }, HOME)).toEqual({
      enabled: false, directory: outside, defaultDirectory: false, retention: 3, maxArchiveBytes: 64 * MIB, warnings: [],
    });
  });

  it("resolves a relative directory against the home and expands a leading tilde", () => {
    expect(resolveBackupSettings({ directory: "archive/daily" }, HOME).directory).toBe(path.join(HOME, "archive", "daily"));
    expect(resolveBackupSettings({ directory: "~/Backups/ryoko" }, HOME).directory).toBe(path.join(os.homedir(), "Backups", "ryoko"));
    expect(resolveBackupSettings({ directory: path.join(HOME, "backups") }, HOME).defaultDirectory).toBe(true);
  });

  it.each([
    ["the home itself", HOME],
    ["a parent of the home", path.dirname(HOME)],
    ["the filesystem root", path.parse(HOME).root],
    ["an empty string", ""],
    ["something that is not a string", 42],
  ])("falls back to the default directory when given %s", (_label, directory) => {
    const settings = resolveBackupSettings({ directory: directory as string }, HOME);

    expect(settings.directory).toBe(path.join(HOME, "backups"));
    expect(settings.defaultDirectory).toBe(true);
    expect(settings.warnings).toHaveLength(1);
    expect(settings.warnings[0]).toMatch(/backup\.directory/);
  });

  it.each([0, -1, 2.5, "7", null, Number.NaN])("falls back to the default retention when given %s", (retention) => {
    const settings = resolveBackupSettings({ retention: retention as number }, HOME);

    expect(settings.retention).toBe(DEFAULT_ARCHIVE_RETENTION);
    expect(settings.warnings).toEqual([expect.stringMatching(/backup\.retention/)]);
  });

  it.each([0, -5, "big", Number.POSITIVE_INFINITY])("falls back to the default size cap when given %s", (maxArchiveMb) => {
    const settings = resolveBackupSettings({ maxArchiveMb: maxArchiveMb as number }, HOME);

    expect(settings.maxArchiveBytes).toBe(DEFAULT_MAX_ARCHIVE_MB * MIB);
    expect(settings.warnings).toEqual([expect.stringMatching(/backup\.maxArchiveMb/)]);
  });

  it("stays on, and says so, when enabled is not a boolean", () => {
    // YAML 1.2 reads `off` and `no` as strings, so `enabled: off` does not disable anything.
    const settings = resolveBackupSettings({ enabled: "off" as unknown as boolean }, HOME);

    expect(settings.enabled).toBe(true);
    expect(settings.warnings).toEqual([expect.stringMatching(/backup\.enabled/)]);
  });

  it("never throws on a backup section that is not a mapping", () => {
    for (const garbage of ["yes", [], 3, null]) {
      const settings = resolveBackupSettings(garbage as unknown as undefined, HOME);
      expect(settings.enabled).toBe(true);
      expect(settings.directory).toBe(path.join(HOME, "backups"));
    }
  });
});
