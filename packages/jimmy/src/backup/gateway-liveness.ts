import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { GATEWAY_INFO_FILE, PID_FILE } from "../shared/paths.js";
import { databasePath, inHome } from "./layout.js";

export interface GatewayLiveness {
  running: boolean;
  /** What gave it away, in words an operator can act on. */
  reason?: string;
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

/**
 * Whether some other connection has this SQLite file open.
 *
 * A WAL-mode connection holds a shared lock on the database file for as long as
 * it is open, so asking for the file exclusively fails with SQLITE_BUSY the
 * moment anyone else is attached - in this process or another one. It is the
 * direct form of the question a restore needs answered, and it needs no pid
 * file and no port.
 *
 * It cannot see across a boundary that does not carry file locks: a gateway in
 * a container is invisible to a probe run on the host against the bind mount.
 * Run a database restore where the gateway runs.
 */
export function databaseHeldOpen(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  let database: Database.Database | undefined;
  try {
    database = new Database(file, { fileMustExist: true, timeout: 250 });
    database.pragma("locking_mode = EXCLUSIVE");
    database.prepare("SELECT count(*) FROM sqlite_master").get();
    return false;
  } catch (error) {
    return String((error as { code?: unknown }).code ?? "").startsWith("SQLITE_BUSY");
  } finally {
    try { database?.close(); } catch { /* nothing was changed either way */ }
  }
}

/**
 * Looks for a gateway running on `home`.
 *
 * No single sign is always there. `gateway.json` is written only when the
 * interactive engine is on, `gateway.pid` only by `ryoko start --daemon`; a
 * foreground gateway on the headless engine leaves neither. Every gateway does
 * keep the session registry open for its whole life, so that is asked last, as
 * the sign that does not depend on how it was started.
 */
export function detectRunningGateway(home: string): GatewayLiveness {
  const infoFile = inHome(home, GATEWAY_INFO_FILE);
  const infoPid = pidFromInfoFile(infoFile);
  if (infoPid !== null && isAlive(infoPid)) {
    return { running: true, reason: `${path.basename(infoFile)} names pid ${infoPid}, which is alive` };
  }
  const pidFile = inHome(home, PID_FILE);
  const daemonPid = pidFromPidFile(pidFile);
  if (daemonPid !== null && isAlive(daemonPid)) {
    return { running: true, reason: `${path.basename(pidFile)} names pid ${daemonPid}, which is alive` };
  }
  const registry = databasePath(home, "sessions");
  if (databaseHeldOpen(registry)) {
    return { running: true, reason: `${path.relative(home, registry)} is open in another process` };
  }
  return { running: false };
}
