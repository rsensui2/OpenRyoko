import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { errorMessage, formatBytes } from "./format.js";
import {
  MANIFEST_FORMAT,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  serializeManifest,
  type BackupManifest,
  type ManifestEntry,
  type SkippedEntry,
} from "./manifest.js";
import { encodeTarEntry, readTar, tarPadding, TAR_TRAILER, type TarEntry, type TarEntrySink } from "./tar.js";
import { MANIFEST_ENTRY_PATH, unsafePathReason } from "./targets.js";
import { collectHomeEntries, type HomeEntry } from "./walk.js";

const READ_CHUNK_BYTES = 64 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
const MAX_REPORTED_PROBLEMS = 50;

/** The home holds more than one archive is allowed to carry. */
export class ArchiveTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveTooLargeError";
  }
}

/** The home has no file under any archive target: a fresh or emptied one. */
export class NothingToArchiveError extends Error {
  constructor(home: string) {
    super(`nothing to archive in ${home}`);
    this.name = "NothingToArchiveError";
  }
}

export interface ArchiveInspection {
  ok: boolean;
  problems: string[];
  /** Present whenever the archive could be read far enough to find one. */
  manifest?: BackupManifest;
}

export interface CreateHomeArchiveOptions {
  home: string;
  /** Final path of the archive. Its directory is created owner-only when missing. */
  destination: string;
  id: string;
  createdAt: Date;
  /** Cap on the uncompressed bytes of archived files. Unset means no cap. */
  maxBytes?: number;
  /** Absolute directories the walk must not enter - the backup directory, when it sits inside a target. */
  excludePaths?: string[];
  /** Overrides the read-back check. The seam that lets a test produce an archive that fails it. */
  inspect?: (file: string) => Promise<ArchiveInspection>;
}

export interface HomeArchiveResult {
  id: string;
  file: string;
  /** Size of the archive on disk. */
  bytes: number;
  /** Uncompressed bytes of the files inside it. */
  contentBytes: number;
  files: number;
  skipped: SkippedEntry[];
  warnings: string[];
}

interface WriteState {
  entries: ManifestEntry[];
  skipped: SkippedEntry[];
  contentBytes: number;
  maxBytes: number | undefined;
}

function tooLarge(bytes: number, maxBytes: number, entries: HomeEntry[]): ArchiveTooLargeError {
  const byTarget = new Map<string, number>();
  for (const entry of entries) {
    const target = entry.path.split("/")[0]!;
    byTarget.set(target, (byTarget.get(target) ?? 0) + entry.size);
  }
  const largest = [...byTarget.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([target, size]) => `${target} ${formatBytes(size)}`)
    .join(", ");
  return new ArchiveTooLargeError(
    `the home holds ${formatBytes(bytes)} to archive, over the ${formatBytes(maxBytes)} limit (backup.maxArchiveMb); `
    + `nothing was written. Largest: ${largest}`,
  );
}

/**
 * Streams one file into the archive and records the hash of exactly the bytes
 * that went in. A file that cannot be opened is left out and reported; a file
 * that turns out shorter than its header promised fails the archive, because
 * the alternative is padding a backup with zeros and calling it good.
 */
async function* fileBlocks(entry: HomeEntry, state: WriteState, all: HomeEntry[]): AsyncGenerator<Buffer> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(entry.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? errorMessage(error);
    state.skipped.push({ path: entry.path, reason: `could not be read (${code})` });
    return;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      state.skipped.push({ path: entry.path, reason: "not a regular file" });
      return;
    }
    state.contentBytes += stat.size;
    if (state.maxBytes !== undefined && state.contentBytes > state.maxBytes) {
      throw tooLarge(state.contentBytes, state.maxBytes, all);
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

async function* archiveBlocks(
  entries: HomeEntry[],
  state: WriteState,
  manifest: () => BackupManifest,
  mtimeSeconds: number,
): AsyncGenerator<Buffer> {
  for (const entry of entries) {
    if (entry.type === "file") {
      yield* fileBlocks(entry, state, entries);
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
  const body = serializeManifest(manifest());
  yield encodeTarEntry({ path: MANIFEST_ENTRY_PATH, type: "file", mode: 0o600, size: body.length, mtimeSeconds });
  yield body;
  yield tarPadding(body.length);
  yield TAR_TRAILER;
}

async function writeArchive(temporary: string, entries: HomeEntry[], skipped: SkippedEntry[], options: CreateHomeArchiveOptions): Promise<BackupManifest> {
  const state: WriteState = { entries: [], skipped: [...skipped], contentBytes: 0, maxBytes: options.maxBytes };
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
    Readable.from(archiveBlocks(entries, state, manifest, Math.floor(options.createdAt.getTime() / 1000)), { objectMode: false }),
    zlib.createGzip(),
    fs.createWriteStream(temporary, { mode: 0o600, flags: "wx" }),
  );
  return manifest();
}

function summarizeProblems(problems: string[]): string {
  const shown = problems.slice(0, 5).join("; ");
  return problems.length > 5 ? `${shown}; and ${problems.length - 5} more` : shown;
}

/**
 * Writes a tar.gz of everything worth keeping in `home`.
 *
 * The archive is built under a temporary name, read back from disk and checked
 * entry by entry against the manifest it carries, and only then renamed into
 * place - so a file with the final name is always one that has been verified,
 * and a run that fails or dies halfway leaves nothing that looks like a backup.
 */
export async function createHomeArchive(options: CreateHomeArchiveOptions): Promise<HomeArchiveResult> {
  const walk = collectHomeEntries(options.home, { excludePaths: options.excludePaths });
  if (!walk.entries.some((entry) => entry.type !== "directory")) throw new NothingToArchiveError(options.home);
  const expected = walk.entries.reduce((total, entry) => total + entry.size, 0);
  if (options.maxBytes !== undefined && expected > options.maxBytes) throw tooLarge(expected, options.maxBytes, walk.entries);

  const directory = path.dirname(options.destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(options.destination)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  try {
    const manifest = await writeArchive(temporary, walk.entries, walk.skipped, options);
    const inspection = await (options.inspect ?? inspectHomeArchive)(temporary);
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
      warnings: [...walk.warnings, ...manifest.skipped.map((item) => `skipped ${item.path}: ${item.reason}`)],
    };
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** Decompresses an archive and hands its entries to `onEntry`, in order. */
export async function readHomeArchive(file: string, onEntry: Parameters<typeof readTar>[1]): Promise<void> {
  await pipeline(fs.createReadStream(file), zlib.createGunzip(), async (source: AsyncIterable<Buffer>) => {
    await readTar(source, onEntry);
  });
}

interface SeenEntry {
  type: TarEntry["type"];
  size?: number;
  sha256?: string;
  target?: string;
}

function collectManifest(entry: TarEntry, done: (bytes: Buffer) => void): TarEntrySink {
  if (entry.size > MANIFEST_MAX_BYTES) throw new Error("the archive's manifest is implausibly large");
  const chunks: Buffer[] = [];
  return {
    write: (chunk) => { chunks.push(Buffer.from(chunk)); },
    end: () => { done(Buffer.concat(chunks)); },
  };
}

function observe(entry: TarEntry, seen: Map<string, SeenEntry>): TarEntrySink | undefined {
  if (entry.type !== "file") {
    seen.set(entry.path, { type: entry.type, ...(entry.type === "symlink" ? { target: entry.linkTarget ?? "" } : {}) });
    return undefined;
  }
  const hash = crypto.createHash("sha256");
  return {
    write: (chunk) => { hash.update(chunk); },
    end: () => { seen.set(entry.path, { type: "file", size: entry.size, sha256: hash.digest("hex") }); },
  };
}

function mismatch(listed: ManifestEntry, found: SeenEntry | undefined): string | null {
  if (!found) return `${listed.path}: listed in the manifest but missing from the archive`;
  if (found.type !== listed.type) return `${listed.path}: is a ${found.type} in the archive but a ${listed.type} in the manifest`;
  if (listed.type === "symlink" && found.target !== listed.target) return `${listed.path}: symlink target does not match the manifest`;
  if (listed.type !== "file") return null;
  if (found.size !== listed.size) return `${listed.path}: expected ${listed.size} bytes, found ${found.size}`;
  return found.sha256 === listed.sha256 ? null : `${listed.path}: sha256 does not match the manifest`;
}

/**
 * An entry below something that is not a directory would be written through it:
 * `skills/link -> /etc` followed by `skills/link/passwd` is how an archive
 * leaves the home. Checked over the whole archive rather than in arrival order,
 * so listing the file before the link changes nothing.
 */
function throughNonDirectory(entryPath: string, seen: Map<string, SeenEntry>): string | null {
  const segments = entryPath.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth).join("/");
    const found = seen.get(ancestor);
    if (found && found.type !== "directory") return `${entryPath}: is inside ${ancestor}, which is not a directory`;
  }
  return null;
}

function compare(manifest: BackupManifest, seen: Map<string, SeenEntry>): string[] {
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const entry of manifest.entries) {
    if (listed.has(entry.path)) problems.push(`${entry.path}: listed more than once in the manifest`);
    listed.add(entry.path);
    const problem = mismatch(entry, seen.get(entry.path));
    if (problem) problems.push(problem);
  }
  for (const entryPath of seen.keys()) {
    if (!listed.has(entryPath)) problems.push(`${entryPath}: not listed in the manifest`);
    const escape = throughNonDirectory(entryPath, seen);
    if (escape) problems.push(escape);
  }
  return problems;
}

function capProblems(problems: string[]): string[] {
  if (problems.length <= MAX_REPORTED_PROBLEMS) return problems;
  return [...problems.slice(0, MAX_REPORTED_PROBLEMS), `... and ${problems.length - MAX_REPORTED_PROBLEMS} more`];
}

/**
 * Reads an archive end to end and checks it against the manifest inside it:
 * every entry hashed, every path in the plain relative form, nothing present
 * that the manifest does not vouch for and nothing promised that is absent.
 *
 * Nothing is written. Defects in the archive come back as `problems` rather
 * than as a throw, so a caller can show all of them.
 */
export async function inspectHomeArchive(file: string): Promise<ArchiveInspection> {
  const seen = new Map<string, SeenEntry>();
  const problems: string[] = [];
  let manifestBytes: Buffer | undefined;
  try {
    await readHomeArchive(file, (entry) => {
      if (entry.path === MANIFEST_ENTRY_PATH && entry.type === "file") {
        if (manifestBytes) problems.push("the manifest appears more than once");
        return collectManifest(entry, (bytes) => { manifestBytes = bytes; });
      }
      const reason = unsafePathReason(entry.path);
      if (reason) throw new Error(`unsafe path in the archive (${reason}): ${JSON.stringify(entry.path)}`);
      if (seen.has(entry.path)) {
        problems.push(`${entry.path}: appears more than once`);
        return undefined;
      }
      return observe(entry, seen);
    });
  } catch (error) {
    return { ok: false, problems: [`the archive could not be read: ${errorMessage(error)}`] };
  }
  if (!manifestBytes) return { ok: false, problems: ["the archive carries no manifest"] };

  let manifest: BackupManifest;
  try {
    manifest = parseManifest(manifestBytes);
  } catch (error) {
    return { ok: false, problems: [errorMessage(error)] };
  }
  const all = capProblems([...problems, ...compare(manifest, seen)]);
  return { ok: all.length === 0, problems: all, manifest };
}
