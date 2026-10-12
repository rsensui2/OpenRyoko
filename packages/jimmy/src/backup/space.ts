import fs from "node:fs";
import { evaluateDiskSpace, getDiskSpaceStatus, type DiskSpaceStatus } from "../shared/storage-health.js";
import { formatBytes } from "./format.js";

/** How much is free where something is about to be written. The gateway's own probe, replaceable in tests. */
export type DiskSpaceProbe = (directory: string) => DiskSpaceStatus;

/**
 * Why `bytes` more cannot be written under `directory`, or null when they fit.
 *
 * They fit when the disk would not be critically low once they are there - the
 * same judgement the gateway makes before every write to its own database, put
 * to the space that will be left rather than the space there is. Asking only
 * "is it low now" lets a 400 MB copy start with 300 MiB free: it passes, runs
 * out partway, and for as long as it runs the gateway refuses to create a
 * session or store a message.
 *
 * `alreadyWritten` is what this same run has put there since the probe last
 * looked. The probe caches for half a minute, so its answer does not know yet.
 */
export function insufficientSpace(
  directory: string,
  bytes: number,
  probe: DiskSpaceProbe = getDiskSpaceStatus,
  alreadyWritten = 0,
): string | null {
  const disk = probe(directory);
  // Unknown free space has never stopped a write here, and should not start to.
  if (disk.freeBytes === null || disk.totalBytes === null) return null;
  const free = Math.max(0, disk.freeBytes - alreadyWritten);
  const left = Math.max(0, free - bytes);
  if (evaluateDiskSpace({ bsize: 1, blocks: disk.totalBytes, bavail: left }).level !== "critical") return null;
  return `not enough free disk space: this needs about ${formatBytes(bytes)} and ${formatBytes(free)} is free in ${directory}, `
    + "which would leave the disk too low for the gateway to keep writing";
}

/** The bytes a file occupies, or 0 when it is not there. */
export function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** True when two paths are on the same filesystem, as far as can be told. Unknown counts as the same: the cautious answer. */
export function sameFilesystem(a: string, b: string): boolean {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return true;
  }
}
