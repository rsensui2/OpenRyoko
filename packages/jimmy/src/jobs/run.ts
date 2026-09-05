import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JOBS_DIR } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { assertLoopbackGatewayUrl } from "./notify.js";
import { pruneOldJobs, writeJobState, type JobState } from "./state.js";

/**
 * `ryoko job run` — launch a shell command as a detached, self-waking job.
 *
 * The command itself runs under a monitor process spawned with
 * `detached: true` (Node calls setsid(2) on POSIX — no external `setsid`
 * binary needed, so this works on macOS too). The monitor lives in its own
 * process group: it survives the engine turn ending AND the engine's
 * group-kill, then wakes the originating session when the job exits.
 */

export interface LaunchJobOpts {
  name: string;
  sessionId: string;
  command: string;
  gatewayUrl?: string;
  logFile?: string;
  timeoutSec?: number;
  jobsDir?: string;
}

function defaultGatewayUrl(): string {
  let port = 7777;
  try {
    port = loadConfig().gateway?.port || 7777;
  } catch {
    // config unavailable — use the default port
  }
  return `http://127.0.0.1:${port}`;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "job";
}

export function launchDetachedJob(opts: LaunchJobOpts): JobState {
  const jobsDir = opts.jobsDir ?? JOBS_DIR;
  const gatewayUrl = opts.gatewayUrl ?? defaultGatewayUrl();
  assertLoopbackGatewayUrl(gatewayUrl);
  if (!opts.command.trim()) throw new Error("command must not be empty");
  if (!opts.sessionId.trim()) throw new Error("--session is required (the session to wake when the job finishes)");

  pruneOldJobs(jobsDir);

  const id = `${sanitizeName(opts.name)}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const logDir = path.join(jobsDir, "logs");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logFile = opts.logFile ?? path.join(logDir, `${id}.log`);
  fs.writeFileSync(logFile, `[job ${id}] ${new Date().toISOString()} :: ${opts.command}\n`, { flag: "a", mode: 0o600 });

  if (opts.timeoutSec !== undefined && (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec <= 0)) {
    throw new Error(`--timeout must be a positive number of seconds (got ${opts.timeoutSec})`);
  }

  const state: JobState = {
    id,
    name: opts.name,
    sessionId: opts.sessionId,
    gatewayUrl,
    command: opts.command,
    logFile,
    // The claimed monitor records its own pid — the launcher must not write
    // the state again after spawn, or it could revert a fast job's terminal
    // status back to "running".
    monitorPid: 0,
    startedAt: new Date().toISOString(),
    ...(opts.timeoutSec ? { timeoutSec: opts.timeoutSec } : {}),
    status: "running",
  };
  writeJobState(state, jobsDir);

  const cliEntry = fileURLToPath(new URL("../../bin/jimmy.js", import.meta.url));
  const child = spawn(process.execPath, [cliEntry, "job", "_monitor", id, "--jobs-dir", jobsDir], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  return { ...state, monitorPid: child.pid ?? 0 };
}
