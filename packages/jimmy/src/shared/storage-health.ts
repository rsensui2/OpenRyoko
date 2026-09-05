import fs from "node:fs";
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
  try { value = evaluateDiskSpace(fs.statfsSync(target)); }
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
