import { MAX_TRAILING_PADDING_BYTES, TAR_BLOCK_BYTES } from "./tar.js";

/**
 * What one archive may hold. Applied when an archive is written and again when
 * one is read, because both happen where running out of memory is an outage:
 * the daily backup runs inside the gateway, and `verify` and `restore` read
 * whatever file is sitting in the backup directory.
 *
 * A cap on bytes alone is not a cap. Directories, symlinks and empty files
 * weigh nothing, and every one of them is still an object held in memory while
 * the home is listed and a line in the manifest. A hundred thousand of them fit
 * in a megabyte of gzip.
 */
export interface ArchiveLimits {
  /** Files, directories and symlinks together. */
  maxEntries: number;
  /** Uncompressed bytes of file content. */
  maxBytes: number;
  /** Longest home-relative path carried. Past it an entry is left out and reported. Default: {@link MAX_ENTRY_PATH_BYTES}. */
  maxPathBytes?: number;
}

/**
 * Far longer than anything a home holds, and short enough that the entry limit
 * bounds memory: without it, fifty thousand paths of four kilobytes each are
 * two hundred megabytes of names.
 */
export const MAX_ENTRY_PATH_BYTES = 1024;

/** What one entry may cost in the manifest on average, name included. */
const MANIFEST_BYTES_PER_ENTRY = 640;

/** How much of what was skipped or found wrong is kept, by item. The total is always counted. */
export const MAX_RECORDED_ITEMS = 100;

/**
 * The largest manifest an archive under these limits may carry. The manifest
 * names every entry, so this is what bounds the memory a reader needs - and a
 * writer too: a home of few entries with enormous names is refused here.
 */
export function manifestByteLimit(limits: ArchiveLimits): number {
  return limits.maxEntries * MANIFEST_BYTES_PER_ENTRY;
}

export function pathByteLimit(limits: ArchiveLimits): number {
  return limits.maxPathBytes ?? MAX_ENTRY_PATH_BYTES;
}

/**
 * What one entry can add to an archive besides its content: its header, the
 * padding after its data, and - for a path or a link target too long for the
 * header - a pax header with both spelled out.
 */
function tarOverheadPerEntry(limits: ArchiveLimits): number {
  const paxRecords = Math.ceil((2 * (pathByteLimit(limits) + 32)) / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  return 3 * TAR_BLOCK_BYTES + paxRecords;
}

/**
 * The most an archive under these limits can unpack to: its content, its
 * manifest, what tar adds around every entry, and its closing. A reader stops
 * when the stream goes past this.
 *
 * The other limits are judged from what the headers announce, so they say
 * nothing about bytes that are announced by no entry at all - pax records with
 * nothing behind them, or whatever else a file is padded out with. Without
 * this, such a file is read to its end however long that is.
 */
export function unpackedByteLimit(limits: ArchiveLimits): number {
  return limits.maxBytes
    + manifestByteLimit(limits)
    + (limits.maxEntries + 1) * tarOverheadPerEntry(limits)
    + 2 * TAR_BLOCK_BYTES + MAX_TRAILING_PADDING_BYTES;
}

/**
 * The home, or an archive, holds more than one archive is allowed to. Trying
 * again changes nothing until the operator raises a limit or moves the bulk
 * out, so the scheduler leaves this for the next daily run.
 */
export class ArchiveTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveTooLargeError";
  }
}
