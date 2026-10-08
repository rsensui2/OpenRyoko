import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { JINN_HOME } from "./paths.js";

const WARNING_BYTES = 1024 ** 3;
const CRITICAL_BYTES = 256 * 1024 ** 2;
const CACHE_MS = 30_000;

export interface DiskSpaceStatus {
  level: "ok" | "warning" | "critical" | "unknown";
  freeBytes: number | null;
  totalBytes: number | null;
  freePercent: number | null;
}

export function evaluateDiskSpace(stats: Pick<fs.StatsFs, "bavail" | "blocks" | "bsize">): DiskSpaceStatus {
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freePercent = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
  const level = freeBytes < CRITICAL_BYTES
    ? "critical"
    : freeBytes < WARNING_BYTES || freePercent < 5
      ? "warning"
      : "ok";
  return { level, freeBytes, totalBytes, freePercent };
}

let cached: { at: number; path: string; value: DiskSpaceStatus } | null = null;

export function getDiskSpaceStatus(target = JINN_HOME, now = Date.now()): DiskSpaceStatus {
  if (cached && cached.path === target && now - cached.at < CACHE_MS) return cached.value;
  let value: DiskSpaceStatus;
  try {
    // Linux statfs.bsize is an I/O size on virtiofs, while counters use
    // statvfs.f_frsize. Node 22 does not expose that fragment size.
    if (process.platform === "linux") {
      const output = execFileSync("stat", ["-f", "-c", "%S %b %a", "--", target], {
        encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C" },
      }).trim();
      if (!/^\d+ \d+ \d+$/.test(output)) throw new Error("Invalid filesystem statistics");
      const [bsize, blocks, bavail] = output.split(" ").map(Number);
      if (![bsize, blocks, bavail].every(Number.isSafeInteger) || bsize <= 0 || blocks <= 0) {
        throw new Error("Invalid filesystem statistics");
      }
      value = evaluateDiskSpace({ bsize, blocks, bavail });
    } else {
      value = evaluateDiskSpace(fs.statfsSync(target));
    }
  }
  catch { value = { level: "unknown", freeBytes: null, totalBytes: null, freePercent: null }; }
  cached = { at: now, path: target, value };
  return value;
}

export function assertDiskSpaceForWrite(target = JINN_HOME): void {
  const status = getDiskSpaceStatus(target);
  if (status.level === "critical") {
    const mib = status.freeBytes === null ? "unknown" : Math.floor(status.freeBytes / 1024 ** 2);
    throw new Error(`Insufficient disk space for a safe database write (${mib} MiB free)`);
  }
}

export function clearDiskSpaceCacheForTests(): void { cached = null; }
