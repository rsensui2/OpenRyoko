import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { errorMessage, formatBytes } from "./format.js";
import { ArchiveTooLargeError, manifestByteLimit, pathByteLimit, type ArchiveLimits } from "./limits.js";
import { findManifestEntry, parseManifest, serializeManifest, type BackupManifest, type ManifestEntry } from "./manifest.js";
import { DEFAULT_ARCHIVE_LIMITS } from "./settings.js";
import { readTar, type TarEntry, type TarEntrySink } from "./tar.js";
import { MANIFEST_ENTRY_PATH, unsafePathReason } from "./targets.js";

const MAX_REPORTED_PROBLEMS = 50;

export interface ArchiveInspection {
  ok: boolean;
  problems: string[];
  /** Present whenever the archive could be read far enough to find one. */
  manifest?: BackupManifest;
}

export interface InspectOptions {
  /** What the archive may hold. Default: the limits an instance uses when its config says nothing. */
  limits?: ArchiveLimits;
  /**
   * The manifest this archive was just written with. Given, the archive is
   * checked against it in a single pass and the copy inside is only compared,
   * never loaded; that is the read-back the gateway does after every backup.
   */
  expected?: BackupManifest;
}

/** What is wrong with an archive, kept to a length somebody can read. The count goes on past it. */
class ProblemList {
  private readonly kept: string[] = [];
  private dropped = 0;

  add(problem: string): void {
    if (this.kept.length < MAX_REPORTED_PROBLEMS) this.kept.push(problem);
    else this.dropped += 1;
  }

  get isEmpty(): boolean {
    return this.kept.length === 0;
  }

  list(): string[] {
    return this.dropped === 0 ? this.kept : [...this.kept, `... and ${this.dropped} more`];
  }
}

/** The archive could be read; it is its manifest that is missing, repeated or not one this version understands. */
class ManifestProblem extends Error {}

const isManifestEntry = (entry: TarEntry): boolean => entry.path === MANIFEST_ENTRY_PATH && entry.type === "file";

/**
 * Decompresses an archive and hands its entries to `onEntry`, in order, giving
 * up the moment it holds more than `limits` allow. The limits are judged from
 * each header as it arrives - before any of the data it announces is read - so
 * an archive that promises a terabyte, or a million empty directories in a
 * megabyte of gzip, costs neither the time nor the memory it was built to take.
 */
export async function readHomeArchive(
  file: string,
  onEntry: Parameters<typeof readTar>[1],
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<void> {
  const pathLimit = pathByteLimit(limits);
  let entries = 0;
  let declared = 0;
  const admit = (entry: TarEntry): void => {
    if (Buffer.byteLength(entry.path) > pathLimit || Buffer.byteLength(entry.linkTarget ?? "") > pathLimit) {
      throw new ArchiveTooLargeError(`the archive holds a path longer than ${pathLimit} bytes`);
    }
    if (isManifestEntry(entry)) {
      if (entry.size > manifestByteLimit(limits)) throw new ArchiveTooLargeError("the archive's manifest is larger than backup.maxEntries allows");
      return;
    }
    entries += 1;
    declared += entry.size;
    if (entries > limits.maxEntries) throw new ArchiveTooLargeError(`the archive holds more than ${limits.maxEntries} entries (backup.maxEntries)`);
    if (declared > limits.maxBytes) {
      throw new ArchiveTooLargeError(`the archive declares more than ${formatBytes(limits.maxBytes)} of content (backup.maxArchiveMb)`);
    }
  };
  await pipeline(fs.createReadStream(file), zlib.createGunzip(), async (source: AsyncIterable<Buffer>) => {
    await readTar(source, (entry) => {
      admit(entry);
      return onEntry(entry);
    });
  });
}

/**
 * Finds the manifest in an archive nobody vouches for, keeping nothing else. It
 * travels last, so this reads the archive through once to reach it; the entries
 * on the way are counted against the limits and let go.
 */
async function loadManifest(file: string, limits: ArchiveLimits): Promise<{ manifest: BackupManifest; digest: string }> {
  let bytes: Buffer | undefined;
  let copies = 0;
  await readHomeArchive(file, (entry) => {
    if (!isManifestEntry(entry)) return undefined;
    copies += 1;
    const chunks: Buffer[] = [];
    return {
      write: (chunk) => { chunks.push(Buffer.from(chunk)); },
      end: () => { bytes = Buffer.concat(chunks); },
    };
  }, limits);
  if (!bytes) throw new ManifestProblem("the archive carries no manifest");
  if (copies > 1) throw new ManifestProblem("the manifest appears more than once");
  try {
    return { manifest: parseManifest(bytes), digest: crypto.createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    throw new ManifestProblem(errorMessage(error));
  }
}

/**
 * An entry below something that is not a directory would be written through it:
 * `skills/link -> /etc` followed by `skills/link/passwd` is how an archive
 * leaves the home. Looked up in the manifest itself, which is in path order, so
 * no index of the archive has to be built to ask.
 */
function nonDirectoryAbove(entries: ManifestEntry[], entryPath: string): string | null {
  const segments = entryPath.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const ancestor = segments.slice(0, depth).join("/");
    const found = findManifestEntry(entries, ancestor);
    if (found && found.type !== "directory") return ancestor;
  }
  return null;
}

/**
 * Checks the manifest on its own terms: within the limits, every path in the
 * plain relative form, in strict path order (which also rules out a path listed
 * twice), nothing inside a non-directory. Returns false when it is not fit to
 * compare an archive against at all.
 */
function validateManifest(manifest: BackupManifest, limits: ArchiveLimits, problems: ProblemList): boolean {
  if (manifest.entries.length > limits.maxEntries) {
    problems.add(`the manifest lists more than ${limits.maxEntries} entries (backup.maxEntries)`);
    return false;
  }
  let previous: string | undefined;
  for (const entry of manifest.entries) {
    const reason = unsafePathReason(entry.path);
    if (reason) {
      problems.add(`unsafe path in the manifest (${reason}): ${JSON.stringify(entry.path)}`);
      return false;
    }
    if (previous !== undefined && entry.path <= previous) {
      problems.add(entry.path === previous ? `${entry.path}: listed more than once in the manifest` : "the manifest lists its entries out of order");
      return false;
    }
    previous = entry.path;
  }
  for (const entry of manifest.entries) {
    const blocker = nonDirectoryAbove(manifest.entries, entry.path);
    if (blocker) problems.add(`${entry.path}: is inside ${blocker}, which is not a directory`);
  }
  return true;
}

/** Holds one archive entry to the manifest entry of the same path. Files are hashed as they stream past. */
function checkEntry(entry: TarEntry, listed: ManifestEntry, problems: ProblemList): TarEntrySink | undefined {
  if (entry.type !== listed.type) {
    problems.add(`${listed.path}: is a ${entry.type} in the archive but a ${listed.type} in the manifest`);
    return undefined;
  }
  if (listed.type === "symlink" && (entry.linkTarget ?? "") !== listed.target) problems.add(`${listed.path}: symlink target does not match the manifest`);
  if (listed.type !== "file") return undefined;
  if (entry.size !== listed.size) {
    problems.add(`${listed.path}: expected ${listed.size} bytes, found ${entry.size}`);
    return undefined;
  }
  const hash = crypto.createHash("sha256");
  return {
    write: (chunk) => { hash.update(chunk); },
    end: () => { if (hash.digest("hex") !== listed.sha256) problems.add(`${listed.path}: sha256 does not match the manifest`); },
  };
}

/**
 * Walks the archive and the manifest side by side. Both are in path order, so
 * each archive entry is held to its manifest entry as it streams past and then
 * forgotten: what is in one and not the other falls out of the order itself,
 * and no table of everything seen is kept. Memory is the manifest, not the
 * archive - which is what lets the gateway read back what it wrote without
 * holding a second copy of the listing.
 */
async function compareWithManifest(
  file: string,
  manifest: BackupManifest,
  manifestDigest: string,
  limits: ArchiveLimits,
  problems: ProblemList,
): Promise<void> {
  const listed = manifest.entries;
  let next = 0;
  let previous: string | undefined;
  let manifestCopies = 0;
  await readHomeArchive(file, (entry) => {
    if (isManifestEntry(entry)) {
      manifestCopies += 1;
      const hash = crypto.createHash("sha256");
      return {
        write: (chunk) => { hash.update(chunk); },
        end: () => { if (hash.digest("hex") !== manifestDigest) problems.add("the manifest inside the archive is not the one it is being checked against"); },
      };
    }
    const reason = unsafePathReason(entry.path);
    if (reason) throw new Error(`unsafe path in the archive (${reason}): ${JSON.stringify(entry.path)}`);
    if (entry.path === previous) {
      problems.add(`${entry.path}: appears more than once`);
      return undefined;
    }
    if (previous !== undefined && entry.path < previous) throw new Error(`its entries are out of order at ${JSON.stringify(entry.path)}`);
    previous = entry.path;
    for (; next < listed.length && listed[next]!.path < entry.path; next += 1) {
      problems.add(`${listed[next]!.path}: listed in the manifest but missing from the archive`);
    }
    if (next >= listed.length || listed[next]!.path !== entry.path) {
      problems.add(`${entry.path}: not listed in the manifest`);
      return undefined;
    }
    next += 1;
    return checkEntry(entry, listed[next - 1]!, problems);
  }, limits);
  for (; next < listed.length; next += 1) problems.add(`${listed[next]!.path}: listed in the manifest but missing from the archive`);
  if (manifestCopies === 0) problems.add("the archive carries no manifest");
  if (manifestCopies > 1) problems.add("the manifest appears more than once");
}

/**
 * Reads an archive end to end and checks it against its manifest: every entry
 * hashed, every path in the plain relative form, nothing present that the
 * manifest does not vouch for and nothing promised that is absent, and no more
 * of anything than `limits` allow.
 *
 * Nothing is written. Defects in the archive come back as `problems` rather
 * than as a throw, so a caller can show them - up to a point: past fifty they
 * are only counted.
 */
export async function inspectHomeArchive(file: string, options: InspectOptions = {}): Promise<ArchiveInspection> {
  const limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS;
  let manifest: BackupManifest;
  let digest: string;
  try {
    if (options.expected) {
      manifest = options.expected;
      digest = crypto.createHash("sha256").update(serializeManifest(manifest)).digest("hex");
    } else {
      ({ manifest, digest } = await loadManifest(file, limits));
    }
  } catch (error) {
    const reason = errorMessage(error);
    return { ok: false, problems: [error instanceof ManifestProblem ? reason : `the archive could not be read: ${reason}`] };
  }
  const problems = new ProblemList();
  if (!validateManifest(manifest, limits, problems)) return { ok: false, problems: problems.list(), manifest };
  try {
    await compareWithManifest(file, manifest, digest, limits, problems);
  } catch (error) {
    return { ok: false, problems: [`the archive could not be read: ${errorMessage(error)}`], manifest };
  }
  return { ok: problems.isEmpty, problems: problems.list(), manifest };
}
