export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_FORMAT = "openryoko-home-archive";

export interface ManifestEntry {
  /** Home-relative, slash-separated. */
  path: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  /** Files only. */
  size?: number;
  /** Files only. */
  sha256?: string;
  /** Symlinks only: the link text, exactly as it was read. */
  target?: string;
}

export interface SkippedEntry {
  path: string;
  reason: string;
}

/**
 * Travels inside the archive as its last entry: the hashes are only known once
 * every file has been streamed past, and one pass is what keeps a file that
 * changes during the backup from disagreeing with its own record.
 */
export interface BackupManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  format: typeof MANIFEST_FORMAT;
  id: string;
  createdAt: string;
  /** The home this was taken from. Informational: restore never trusts it as a destination. */
  home: string;
  /** Uncompressed bytes of every archived file. */
  contentBytes: number;
  entries: ManifestEntry[];
  /** What the walk met and deliberately left out (unreadable, not a regular file). */
  skipped: SkippedEntry[];
}

export function serializeManifest(manifest: BackupManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown, index: number): ManifestEntry {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.mode !== "number") {
    throw new Error(`manifest entry ${index} is malformed`);
  }
  const base = { path: value.path, mode: value.mode };
  if (value.type === "directory") return { ...base, type: "directory" };
  if (value.type === "symlink" && typeof value.target === "string") return { ...base, type: "symlink", target: value.target };
  if (
    value.type === "file"
    && typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0
    && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    return { ...base, type: "file", size: value.size, sha256: value.sha256 };
  }
  throw new Error(`manifest entry ${index} (${value.path}) is malformed`);
}

/** Reads a manifest, refusing one this version does not understand or that is not shaped like one. */
export function parseManifest(bytes: Buffer): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("manifest is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.format !== MANIFEST_FORMAT) throw new Error("manifest is not a home archive manifest");
  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(`unsupported manifest version ${String(parsed.schemaVersion)}`);
  }
  if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "string" || !Array.isArray(parsed.entries)) {
    throw new Error("manifest is missing required fields");
  }
  const skipped = Array.isArray(parsed.skipped)
    ? parsed.skipped.filter(isRecord).map((item) => ({ path: String(item.path), reason: String(item.reason) }))
    : [];
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    format: MANIFEST_FORMAT,
    id: parsed.id,
    createdAt: parsed.createdAt,
    home: typeof parsed.home === "string" ? parsed.home : "",
    contentBytes: typeof parsed.contentBytes === "number" ? parsed.contentBytes : 0,
    entries: parsed.entries.map(parseEntry),
    skipped,
  };
}
