import fs from "node:fs";
import path from "node:path";
import { SQLITE_SIDECAR_SUFFIXES } from "../sessions/backup.js";
import { GATEWAY_INFO_FILE, PID_FILE } from "../shared/paths.js";
import { databasePath, inHome } from "./layout.js";

/**
 * Signs that a gateway is running on a home, read without touching anything a
 * gateway might have open.
 *
 * The obvious way to ask "is this database in use" is to open it and see
 * whether SQLite lets us have it. That is exactly what must not be done. File
 * locks do not cross a container boundary: with the home bind-mounted into a
 * container, a process on the host is granted the database outright while the
 * gateway inside holds it, and on closing it - believing itself the last
 * connection - SQLite checkpoints the WAL into the main file and deletes it,
 * under a gateway that goes on appending to a WAL that is no longer there. The
 * commits it makes afterwards are lost. A probe of that kind damaged the
 * database it was written to protect, on the way to refusing a restore.
 *
 * So nothing here opens a database. It reads two small files and the
 * modification times of a few more, and that is all.
 */

/** A database file written this recently counts as in use. */
export const RECENT_WRITE_MS = 60_000;

export interface GatewayLiveness {
  running: boolean;
  /** What gave it away, in words an operator can act on. */
  reason?: string;
}

export interface LivenessOptions {
  now?: Date;
  /** Databases to look at besides the session registry: the one a restore is about to replace. */
  databases?: readonly string[];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else. Only ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function usablePid(value: unknown): number | null {
  const pid = typeof value === "string" ? Number(value.trim()) : value;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
}

function pidFromInfoFile(file: string): number | null {
  try {
    return usablePid((JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown } | null)?.pid);
  } catch {
    return null;
  }
}

function pidFromPidFile(file: string): number | null {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return /^\d+$/.test(text) ? usablePid(text) : null;
  } catch {
    return null;
  }
}

function alivePid(home: string): string | null {
  const infoFile = inHome(home, GATEWAY_INFO_FILE);
  const infoPid = pidFromInfoFile(infoFile);
  if (infoPid !== null && isAlive(infoPid)) return `${path.basename(infoFile)} names pid ${infoPid}, which is alive`;
  const pidFile = inHome(home, PID_FILE);
  const daemonPid = pidFromPidFile(pidFile);
  if (daemonPid !== null && isAlive(daemonPid)) return `${path.basename(pidFile)} names pid ${daemonPid}, which is alive`;
  return null;
}

/**
 * The database file or sidecar that was written within the last minute, if
 * any. A pid means nothing in another pid namespace and a lock does not leave
 * the container, but when a file was last written reads the same from both
 * sides of a bind mount. A timestamp slightly ahead of this clock counts too:
 * the writer may be on a machine whose clock is not quite ours.
 */
function recentWrite(home: string, database: string, now: Date): string | null {
  for (const suffix of ["", ...SQLITE_SIDECAR_SUFFIXES]) {
    const file = `${database}${suffix}`;
    let written: number;
    try {
      written = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const age = now.getTime() - written;
    if (age >= RECENT_WRITE_MS || age <= -RECENT_WRITE_MS) continue;
    const seconds = Math.round(Math.abs(age) / 1000);
    const when = age >= 0
      ? `was written ${seconds} second${seconds === 1 ? "" : "s"} ago`
      : `carries a timestamp ${seconds} second${seconds === 1 ? "" : "s"} ahead of this clock`;
    return `${path.relative(home, file)} ${when}`;
  }
  return null;
}

/**
 * Looks for a gateway running on `home`.
 *
 * `gateway.json` is written only when the interactive engine is on,
 * `gateway.pid` only by `ryoko start --daemon`; a foreground gateway on the
 * headless engine leaves neither, and a pid from inside a container says
 * nothing outside it. A recent write to the registry is the sign that does not
 * depend on how the gateway was started or where this command runs.
 *
 * None of it is proof of absence. A gateway that has had nothing to write for
 * a minute, behind a pid this process cannot see, is not detected - which is
 * why replacing a database also takes the operator's own word.
 */
export function detectRunningGateway(home: string, options: LivenessOptions = {}): GatewayLiveness {
  const pid = alivePid(home);
  if (pid) return { running: true, reason: pid };
  const now = options.now ?? new Date();
  for (const database of new Set([databasePath(home, "sessions"), ...(options.databases ?? [])])) {
    const written = recentWrite(home, database, now);
    if (written) return { running: true, reason: written };
  }
  return { running: false };
}
