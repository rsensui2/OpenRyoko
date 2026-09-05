import fs from "node:fs";
import { spawn } from "node:child_process";
import { isPidAlive, jobStatePath, readJobState, writeJobState, type JobState } from "./state.js";
import { buildJobNotification, readLogTail, sendJobNotification, type NotifyDeps } from "./notify.js";

/**
 * Detached job monitor — the process `ryoko job run` spawns into its own
 * process group (survives the engine turn ending and gateway restarts).
 *
 * It runs the job command, streams output to the logfile, and when the job
 * exits — success, failure or timeout — wakes the originating session exactly
 * once via the gateway notification route. All state transitions are persisted
 * to the job state file so an orphaned job is detectable on the next turn.
 */

const KILL_GRACE_MS = 10_000;

export interface MonitorDeps extends NotifyDeps {
  jobsDir?: string;
}

/**
 * Atomically claim the job so two monitors can never run the same command or
 * notify twice. O_EXCL lock file next to the state file; a lock held by a
 * dead pid (previous monitor crashed) may be stolen once.
 */
function claimJob(jobId: string, jobsDir?: string): boolean {
  const lockFile = `${jobStatePath(jobId, jobsDir)}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      let holder = NaN;
      try {
        holder = parseInt(fs.readFileSync(lockFile, "utf8"), 10);
      } catch {
        // unreadable lock — treat as held
      }
      if (Number.isInteger(holder) && holder !== process.pid && !isPidAlive(holder)) {
        try { fs.unlinkSync(lockFile); } catch { /* lost the race to another claimer */ }
        continue; // retry the exclusive create once
      }
      return false;
    }
  }
  return false;
}

export async function runJobMonitor(jobId: string, deps: MonitorDeps = {}): Promise<JobState | null> {
  const jobsDir = deps.jobsDir;
  const state = readJobState(jobId, jobsDir);
  if (!state) return null;
  // A monitor restart must never re-run the command or double-notify.
  if (state.status !== "running") return state;
  // monitorPid !== 0 means a monitor already claimed this job and may have
  // started the command. Even if that monitor is now dead, re-running here
  // could execute the command twice (its detached child may still be alive).
  // Leave it to orphan detection instead.
  if (state.monitorPid !== 0 && state.monitorPid !== process.pid) return state;
  if (!claimJob(jobId, jobsDir)) return state;

  // The launcher wrote monitorPid 0; the claimed monitor records itself.
  // (The launcher never writes the state again — see run.ts — so this cannot
  // be overwritten by a stale parent.)
  const claimed: JobState = { ...state, monitorPid: process.pid };
  writeJobState(claimed, jobsDir);

  const exit = await runJobCommand(claimed);

  const exited: JobState = {
    ...claimed,
    status: "exited",
    exitCode: exit.code,
    signal: exit.signal,
    timedOut: exit.timedOut,
    finishedAt: new Date().toISOString(),
  };
  writeJobState(exited, jobsDir);

  const message = buildJobNotification(exited, readLogTail(exited.logFile));
  const sent = await sendJobNotification(exited, message, deps);

  const final: JobState = sent.ok
    ? { ...exited, status: "notified", notifiedAt: new Date().toISOString() }
    : { ...exited, status: "notify_failed", notifyError: sent.error };
  writeJobState(final, jobsDir);
  return final;
}

/** Kill the job's whole process group — a timed-out `sh -c` must not leave
 *  grandchildren running after we told the session it was killed. */
function killJobTree(child: { pid?: number; kill: (sig: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // group already gone — fall through to the direct kill
    }
  }
  try { child.kill(signal); } catch { /* already dead */ }
}

function runJobCommand(state: JobState): Promise<{ code: number | null; signal: string | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const logFd = fs.openSync(state.logFile, "a", 0o600);
    const child = spawn("/bin/sh", ["-c", state.command], {
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      // Own process group so a timeout can kill the whole tree, not just sh.
      detached: process.platform !== "win32",
    });

    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    if (state.timeoutSec && state.timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killJobTree(child, "SIGTERM");
        killTimer = setTimeout(() => killJobTree(child, "SIGKILL"), KILL_GRACE_MS);
      }, state.timeoutSec * 1000);
    }

    child.on("exit", (code, signal) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      // Sweep any survivors of the group even on normal exit paths.
      if (timedOut) killJobTree(child, "SIGKILL");
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      resolve({ code, signal, timedOut });
    });
    child.on("error", (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      try { fs.appendFileSync(state.logFile, `\n[job-monitor] failed to spawn command: ${err.message}\n`); } catch { /* best effort */ }
      try { fs.closeSync(logFd); } catch { /* already closed */ }
      resolve({ code: 127, signal: null, timedOut });
    });
  });
}
