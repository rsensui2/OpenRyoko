import fs from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/**
 * SQLite's integrity check on a database file, run on a thread of its own.
 *
 * The check is a single synchronous call that reads the whole file. A registry
 * of a few hundred megabytes takes it seconds, and on the gateway's own thread
 * those would be seconds in which nothing else happens: no message is taken,
 * no request answered, no timer fired. So it is handed to a worker, which
 * opens the file with a connection of its own, and the caller waits for a
 * message instead.
 *
 * What it can tell and what it cannot: it walks every table and index and
 * finds a file whose structure is broken - a page that is not what the tree
 * says it is, an index that disagrees with its table. It cannot tell that a
 * structurally sound file holds pages from two different moments. A copy made
 * while a writer it could not see was at work may be exactly that, and passes.
 */

export interface IntegrityCheckOptions {
  /** The SQLite driver the worker loads. Replaceable so that its failing to load can be exercised. */
  driver?: string;
  /** How long the check may take before it is stopped. Default: {@link integrityCheckTimeoutMs} for the file's size. */
  timeoutMs?: number;
}

const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;
const MINIMUM_TIMEOUT_MS = 5 * 60_000;
const TIMEOUT_MS_PER_MEGABYTE = 2_000;

/**
 * How long a check of a database of `bytes` may take before it is given up on.
 *
 * Long on purpose. A few hundred megabytes are checked in under a second on a
 * fast disk with the file fresh in the cache, and this allows for a disk that
 * reads half a megabyte a second. It is not there to hurry a slow check along.
 * It is there because a check that never answers would otherwise hold the
 * backup waiting for it, and the scheduler behind that, until the gateway was
 * restarted.
 */
export function integrityCheckTimeoutMs(bytes: number): number {
  return MINIMUM_TIMEOUT_MS + Math.ceil(bytes / (1024 * 1024)) * TIMEOUT_MS_PER_MEGABYTE;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * What the worker runs: plain CommonJS in a string, so that it is the same
 * thing under the compiled gateway and under the tests, and nothing in it is
 * resolved from this package's own files.
 *
 * The driver is loaded outside the `try` on purpose. Failing there is the
 * check being unable to run, which the caller must be able to tell from a file
 * that is unreadable. Reading a WAL-mode file makes SQLite put a -wal and a
 * -shm beside it and leave them; the ones that were not there before are
 * removed again.
 */
const CHECK = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const Database = require(workerData.driver);
const made = ["-wal", "-shm"].map((suffix) => workerData.file + suffix).filter((sidecar) => !fs.existsSync(sidecar));
let database;
let answer;
try {
  database = new Database(workerData.file, { readonly: true, fileMustExist: true });
  answer = { lines: database.pragma("integrity_check").map((row) => String(row.integrity_check)) };
} catch (error) {
  answer = { unreadable: String((error && error.message) || error) };
} finally {
  try { if (database) database.close(); } catch {}
  for (const sidecar of made) { try { fs.rmSync(sidecar, { force: true }); } catch {} }
}
parentPort.postMessage(answer);
`;

interface Answer {
  lines?: unknown;
  unreadable?: unknown;
}

function problemsFrom(answer: Answer): string[] {
  if (typeof answer.unreadable === "string") return [`the database could not be read: ${answer.unreadable}`];
  const lines = Array.isArray(answer.lines) ? answer.lines.map(String) : [];
  if (lines.length === 1 && lines[0] === "ok") return [];
  return lines.length > 0 ? lines : ["the integrity check returned nothing"];
}

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const unavailable = (reason: string): Error => new Error(`the integrity check could not be run: ${reason}`);

/**
 * Stops a check that has run out of time and clears away what it had put
 * beside the file - which it would have removed itself, had it been let finish.
 */
async function stop(worker: Worker, made: string[]): Promise<void> {
  try {
    await worker.terminate();
  } finally {
    for (const sidecar of made) fs.rmSync(sidecar, { force: true });
  }
}

/**
 * What is wrong with the database at `file`: SQLite's own findings, or an
 * empty list when it is sound. A file that cannot be opened or read as a
 * database is a finding, not an error.
 *
 * Rejects only when the check could not be made at all - no worker, a driver
 * that will not load in one, no answer within the time allowed. That says
 * nothing about the file either way, and is for the caller to decide what to
 * do with.
 */
export function findDatabaseProblems(file: string, options: IntegrityCheckOptions = {}): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const made = SIDECAR_SUFFIXES.map((suffix) => `${file}${suffix}`).filter((sidecar) => !fs.existsSync(sidecar));
    let worker: Worker;
    try {
      const driver = options.driver ?? createRequire(import.meta.url).resolve("better-sqlite3");
      // No inherited flags: an inspector or a loader given to the gateway is not meant for this thread.
      worker = new Worker(CHECK, { eval: true, workerData: { file, driver }, execArgv: [] });
    } catch (error) {
      reject(unavailable(text(error)));
      return;
    }
    const allowed = options.timeoutMs ?? integrityCheckTimeoutMs(sizeOf(file));
    let settled = false;
    /** Whichever comes first - an answer, a failure, the worker gone, or time up - is the outcome; the rest are ignored. */
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const timer = setTimeout(() => settle(() => {
      const late = unavailable(`it did not answer within ${Math.round(allowed / 1000)} seconds and was stopped`);
      void stop(worker, made).then(() => reject(late), () => reject(late));
    }), allowed);
    worker.once("message", (answer: Answer) => settle(() => resolve(problemsFrom(answer))));
    worker.once("error", (error) => settle(() => reject(unavailable(text(error)))));
    worker.once("exit", (code) => settle(() => reject(unavailable(`it stopped without an answer (exit code ${code})`))));
  });
}
