import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { errorMessage, formatBytes } from "./format.js";
import { inspectHomeArchive, type ArchiveInspection, type InspectOptions } from "./inspect.js";
import { ArchiveTooLargeError, manifestByteLimit, MAX_RECORDED_ITEMS, type ArchiveLimits } from "./limits.js";
import {
  MANIFEST_FORMAT,
  MANIFEST_SCHEMA_VERSION,
  serializeManifest,
  type BackupManifest,
  type ManifestEntry,
  type SkippedEntry,
} from "./manifest.js";
import { DEFAULT_ARCHIVE_LIMITS } from "./settings.js";
import { encodeTarEntry, tarPadding, TAR_TRAILER } from "./tar.js";
import { MANIFEST_ENTRY_PATH } from "./targets.js";
import { absolutePathOf, collectHomeEntries, type HomeEntry, type HomeWalk } from "./walk.js";

export { inspectHomeArchive, readHomeArchive, type ArchiveInspection, type InspectOptions } from "./inspect.js";
export { ArchiveTooLargeError } from "./limits.js";

const READ_CHUNK_BYTES = 64 * 1024;
/**
 * What an entry adds to the tar besides its content: a header block, padding to
 * the next block, its line in the manifest. Used to say how large an archive
 * could come out before compression, which it never exceeds by much.
 */
const UNCOMPRESSED_OVERHEAD_PER_ENTRY = 1024;
/** How many of the things left out are spelled out in the warnings. The rest are a count. */
const MAX_SKIPPED_WARNINGS = 10;

/** The home has no file under any archive target: a fresh or emptied one. */
export class NothingToArchiveError extends Error {
  constructor(home: string) {
    super(`nothing to archive in ${home}`);
    this.name = "NothingToArchiveError";
  }
}

export interface CreateHomeArchiveOptions {
  home: string;
  /** Final path of the archive. Its directory is created owner-only when missing. */
  destination: string;
  id: string;
  createdAt: Date;
  /** What the archive may hold, in entries and in bytes. Default: what an instance uses when its config says nothing. */
  limits?: ArchiveLimits;
  /** Absolute directories the walk must not enter - the backup directory, when it sits inside a target. */
  excludePaths?: string[];
  /**
   * Called once the home has been listed and before anything is written, with
   * how many bytes the archive may take at most. Throwing calls it off - the
   * place to check that there is room for it.
   */
  beforeWrite?: (estimate: { bytes: number }) => void;
  /** Overrides the read-back check. The seam that lets a test produce an archive that fails it. */
  inspect?: (file: string, context: InspectOptions) => Promise<ArchiveInspection>;
}

export interface HomeArchiveResult {
  id: string;
  file: string;
  /** Size of the archive on disk. */
  bytes: number;
  /** Uncompressed bytes of the files inside it. */
  contentBytes: number;
  files: number;
  /** The first of what was left out; `skippedCount` is how many there were. */
  skipped: SkippedEntry[];
  skippedCount: number;
  warnings: string[];
}

interface WriteState {
  home: string;
  limits: ArchiveLimits;
  entries: ManifestEntry[];
  skipped: SkippedEntry[];
  skippedCount: number;
  contentBytes: number;
}

function noteSkipped(state: WriteState, entryPath: string, reason: string): void {
  state.skippedCount += 1;
  if (state.skipped.length < MAX_RECORDED_ITEMS) state.skipped.push({ path: entryPath, reason });
}

/**
 * Streams one file into the archive and records the hash of exactly the bytes
 * that went in. A file that cannot be opened is left out and reported; a file
 * that turns out shorter than its header promised fails the archive, because
 * the alternative is padding a backup with zeros and calling it good.
 */
async function* fileBlocks(entry: HomeEntry, state: WriteState): AsyncGenerator<Buffer> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(absolutePathOf(state.home, entry.path), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    noteSkipped(state, entry.path, `could not be read (${(error as NodeJS.ErrnoException).code ?? errorMessage(error)})`);
    return;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      noteSkipped(state, entry.path, "not a regular file");
      return;
    }
    state.contentBytes += stat.size;
    if (state.contentBytes > state.limits.maxBytes) {
      // The walk let it through; it has grown since.
      throw new ArchiveTooLargeError(
        `the home holds at least ${formatBytes(state.contentBytes)} to archive, over the ${formatBytes(state.limits.maxBytes)} limit `
        + "(backup.maxArchiveMb); nothing was written",
      );
    }
    const mode = stat.mode & 0o7777;
    yield encodeTarEntry({
      path: entry.path, type: "file", mode, size: stat.size, mtimeSeconds: Math.max(0, Math.floor(stat.mtimeMs / 1000)),
    });
    const hash = crypto.createHash("sha256");
    for (let remaining = stat.size; remaining > 0;) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) throw new Error(`${entry.path} changed while it was being archived`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      remaining -= bytesRead;
      yield chunk;
    }
    yield tarPadding(stat.size);
    state.entries.push({ path: entry.path, type: "file", mode, size: stat.size, sha256: hash.digest("hex") });
  } finally {
    await handle.close();
  }
}

/**
 * The manifest, as the bytes that close the archive. It names every entry, so
 * it is refused when it outgrows what the entry limit allows: a home of few
 * entries with enormous names costs a reader what thousands of ordinary ones do.
 */
function manifestBlocks(manifest: BackupManifest, limits: ArchiveLimits, mtimeSeconds: number): Buffer[] {
  const body = serializeManifest(manifest);
  const allowed = manifestByteLimit(limits);
  if (body.length > allowed) {
    throw new ArchiveTooLargeError(
      `the home's list of what it holds is too large to record: ${formatBytes(body.length)}, where backup.maxEntries = ${limits.maxEntries} `
      + `allows ${formatBytes(allowed)}; nothing was written`,
    );
  }
  return [
    encodeTarEntry({ path: MANIFEST_ENTRY_PATH, type: "file", mode: 0o600, size: body.length, mtimeSeconds }),
    body,
    tarPadding(body.length),
    TAR_TRAILER,
  ];
}

async function* archiveBlocks(
  entries: HomeEntry[],
  state: WriteState,
  manifest: () => BackupManifest,
  mtimeSeconds: number,
): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    if (entry.type === "file") {
      yield* fileBlocks(entry, state);
      continue;
    }
    yield encodeTarEntry({
      path: entry.path, type: entry.type, mode: entry.mode, size: 0, mtimeSeconds: entry.mtimeSeconds,
      ...(entry.type === "symlink" ? { linkTarget: entry.linkTarget ?? "" } : {}),
    });
    state.entries.push(entry.type === "symlink"
      ? { path: entry.path, type: "symlink", mode: entry.mode, target: entry.linkTarget ?? "" }
      : { path: entry.path, type: "directory", mode: entry.mode });
  }
  // Last, because it is only complete once every file has been hashed in passing.
  yield* manifestBlocks(manifest(), state.limits, mtimeSeconds);
}

async function writeArchive(temporary: string, walk: HomeWalk, options: CreateHomeArchiveOptions, limits: ArchiveLimits): Promise<{ manifest: BackupManifest; skippedCount: number }> {
  const state: WriteState = {
    home: options.home, limits, entries: [], skipped: [...walk.skipped], skippedCount: walk.skippedCount, contentBytes: 0,
  };
  const manifest = (): BackupManifest => ({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    format: MANIFEST_FORMAT,
    id: options.id,
    createdAt: options.createdAt.toISOString(),
    home: options.home,
    contentBytes: state.contentBytes,
    entries: state.entries,
    skipped: state.skipped,
  });
  await pipeline(
    Readable.from(archiveBlocks(walk.entries, state, manifest, Math.floor(options.createdAt.getTime() / 1000)), { objectMode: false }),
    zlib.createGzip(),
    fs.createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
  );
  return { manifest: manifest(), skippedCount: state.skippedCount };
}

function summarizeProblems(problems: string[]): string {
  const shown = problems.slice(0, 5).join("; ");
  return problems.length > 5 ? `${shown}; and ${problems.length - 5} more` : shown;
}

function warningsFor(walk: HomeWalk, skipped: SkippedEntry[], skippedCount: number): string[] {
  const shown = skipped.slice(0, MAX_SKIPPED_WARNINGS).map((item) => `skipped ${item.path}: ${item.reason}`);
  const summary = skippedCount > shown.length ? [`${skippedCount} entries were left out of this backup in all`] : [];
  return [...walk.warnings, ...shown, ...summary];
}

/**
 * Writes a tar.gz of everything worth keeping in `home`.
 *
 * The archive is built under a temporary name, read back from disk and checked
 * entry by entry against the manifest it carries, and only then renamed into
 * place - so a file with the final name is always one that has been verified,
 * and a run that fails or dies halfway leaves nothing that looks like a backup.
 *
 * It holds at most `limits` allow. A home past them is refused with
 * {@link ArchiveTooLargeError} while it is still being listed, not after: this
 * runs inside the gateway, and the listing is what would not fit.
 */
export async function createHomeArchive(options: CreateHomeArchiveOptions): Promise<HomeArchiveResult> {
  const limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS;
  const walk = await collectHomeEntries(options.home, { excludePaths: options.excludePaths, limits });
  if (!walk.entries.some((entry) => entry.type !== "directory")) throw new NothingToArchiveError(options.home);
  options.beforeWrite?.({ bytes: walk.bytes + walk.entries.length * UNCOMPRESSED_OVERHEAD_PER_ENTRY });

  const directory = path.dirname(options.destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(options.destination)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  try {
    const { manifest, skippedCount } = await writeArchive(temporary, walk, options, limits);
    // Against the manifest already in hand, in one pass: the copy inside the
    // archive is compared, not loaded, and no second listing is built.
    const inspection = await (options.inspect ?? inspectHomeArchive)(temporary, { expected: manifest, limits });
    if (!inspection.ok) throw new Error(`the archive did not read back - ${summarizeProblems(inspection.problems)}`);
    try { fs.chmodSync(temporary, 0o600); } catch { /* Windows has no POSIX modes */ }
    fs.renameSync(temporary, options.destination);
    return {
      id: options.id,
      file: options.destination,
      bytes: fs.statSync(options.destination).size,
      contentBytes: manifest.contentBytes,
      files: manifest.entries.filter((entry) => entry.type === "file").length,
      skipped: manifest.skipped,
      skippedCount,
      warnings: warningsFor(walk, manifest.skipped, skippedCount),
    };
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}
