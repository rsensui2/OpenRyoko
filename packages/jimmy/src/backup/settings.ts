import os from "node:os";
import path from "node:path";
import type { JinnConfig } from "../shared/types.js";
import type { ArchiveLimits } from "./limits.js";

export const DEFAULT_ARCHIVE_RETENTION = 14;
/**
 * A home's own files are small; one that has grown past this is carrying bulk
 * (a dump in knowledge/, assets vendored into a skill) that fourteen daily
 * copies would turn into gigabytes. Past the cap the archive is refused and
 * reported rather than silently filling the disk it shares with the instance.
 */
export const DEFAULT_MAX_ARCHIVE_MB = 512;
/**
 * Files, directories and symlinks in one archive. An ordinary home holds a few
 * thousand; this leaves it an order of magnitude to grow into, and still bounds
 * what the gateway holds in memory while it archives one. Empty files and
 * directories weigh nothing, so the size cap above never sees them.
 */
export const DEFAULT_MAX_ENTRIES = 50_000;

const MIB = 1024 * 1024;

/** The limits an archive is held to when nobody says otherwise. */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = { maxEntries: DEFAULT_MAX_ENTRIES, maxBytes: DEFAULT_MAX_ARCHIVE_MB * MIB };

export interface BackupSettings {
  enabled: boolean;
  /** Absolute. */
  directory: string;
  /** True when `directory` is the instance's own `<home>/backups`. */
  defaultDirectory: boolean;
  /** Home archive generations to keep. */
  retention: number;
  maxArchiveBytes: number;
  maxEntries: number;
  /** Values in the config that were ignored, and why. */
  warnings: string[];
}

/** The pair of limits every archive this instance writes or reads is held to. */
export function archiveLimits(settings: Pick<BackupSettings, "maxEntries" | "maxArchiveBytes">): ArchiveLimits {
  return { maxEntries: settings.maxEntries, maxBytes: settings.maxArchiveBytes };
}

export function defaultBackupDirectory(home: string): string {
  return path.join(home, "backups");
}

function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") || value.startsWith(`~${path.sep}`) ? path.join(os.homedir(), value.slice(2)) : value;
}

/**
 * The directory the config names, or null with a reason when it cannot be used.
 * The home and its parents are refused: retention deletes by file name there,
 * and a directory that contains the home is not a place to keep its backups.
 */
function resolveDirectory(value: unknown, home: string): { directory: string | null; warning?: string } {
  if (value === undefined) return { directory: null };
  if (typeof value !== "string" || value.trim() === "") {
    return { directory: null, warning: "backup.directory must be a path; using the default" };
  }
  const resolvedHome = path.resolve(home);
  const directory = path.resolve(resolvedHome, expandTilde(value.trim()));
  const relative = path.relative(directory, resolvedHome);
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  const containsHome = relative === "" || !outside;
  if (containsHome) {
    return { directory: null, warning: `backup.directory must not be the instance home or a directory above it (${directory}); using the default` };
  }
  return { directory };
}

function positive(value: unknown, fallback: number, label: string, integer: boolean, warnings: string[]): number {
  if (value === undefined) return fallback;
  const valid = typeof value === "number" && Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value));
  if (valid) return value as number;
  warnings.push(`${label} must be a positive ${integer ? "whole number" : "number"}; using ${fallback}`);
  return fallback;
}

/**
 * Turns the optional `backup` section into concrete settings.
 *
 * Never throws. An instance arrives here with whatever its config.yaml already
 * says, and a value this cannot use falls back to the default with a warning
 * instead of stopping the gateway from booting.
 */
export function resolveBackupSettings(config: JinnConfig["backup"] | undefined, home: string): BackupSettings {
  const section: Record<string, unknown> = typeof config === "object" && config !== null && !Array.isArray(config) ? config : {};
  const warnings: string[] = [];

  if (section.enabled !== undefined && typeof section.enabled !== "boolean") {
    warnings.push("backup.enabled must be true or false; backups stay on");
  }
  const { directory, warning } = resolveDirectory(section.directory, home);
  if (warning) warnings.push(warning);
  const fallbackDirectory = defaultBackupDirectory(path.resolve(home));
  const resolvedDirectory = directory ?? fallbackDirectory;

  return {
    enabled: section.enabled !== false,
    directory: resolvedDirectory,
    defaultDirectory: resolvedDirectory === fallbackDirectory,
    retention: positive(section.retention, DEFAULT_ARCHIVE_RETENTION, "backup.retention", true, warnings),
    maxArchiveBytes: positive(section.maxArchiveMb, DEFAULT_MAX_ARCHIVE_MB, "backup.maxArchiveMb", false, warnings) * MIB,
    maxEntries: positive(section.maxEntries, DEFAULT_MAX_ENTRIES, "backup.maxEntries", true, warnings),
    warnings,
  };
}
