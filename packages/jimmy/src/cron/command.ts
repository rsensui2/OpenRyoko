import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { CronJob } from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";

const LOG_LIMIT = 1024 * 1024;
const lockOwner = randomUUID();
const pending = new Set<Promise<CommandResult>>();
const stoppers = new Set<() => void>();

export async function stopCommandJobs(): Promise<void> {
  for (const stop of stoppers) stop();
  await Promise.allSettled([...pending]);
}

export function validateCommandJob(job: Partial<CronJob>): string | undefined {
  if (job.kind !== "command") return;
  const c = job.command;
  if (!c || typeof c !== "object" || Array.isArray(c)) return "command is required";
  if (typeof c.executable !== "string" || !path.isAbsolute(c.executable) || c.executable.includes("\0"))
    return "command.executable must be an absolute path";
  if (c.args !== undefined && (!Array.isArray(c.args) || c.args.some(a => typeof a !== "string" || a.includes("\0"))))
    return "command.args must be an array of strings";
  if (c.cwd !== undefined && (typeof c.cwd !== "string" || !path.isAbsolute(c.cwd) || c.cwd.includes("\0")))
    return "command.cwd must be an absolute path";
  if (c.timeoutSeconds !== undefined && (!Number.isInteger(c.timeoutSeconds) || c.timeoutSeconds < 1 || c.timeoutSeconds > 86400))
    return "command.timeoutSeconds must be an integer from 1 to 86400";
  const delivery = job.failureDelivery;
  if (delivery !== undefined && delivery !== null && (typeof delivery !== "object" || Array.isArray(delivery)
    || typeof delivery.connector !== "string" || !delivery.connector.trim()
    || typeof delivery.channel !== "string" || !delivery.channel.trim()))
    return "failureDelivery must be null or an object with connector and channel";
}

export interface CommandResult {
  status: "success" | "error" | "skipped";
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  logFile?: string;
  error?: string;
  reason?: string;
}

/** A durable exclusive lock prevents duplicate execution across gateway restarts.
 * An interrupted owner leaves the lock for operator inspection: never guess
 * that an unobserved command did not perform its external side effects. */
export async function runCommand(job: CronJob): Promise<CommandResult> {
  const promise = executeCommand(job);
  pending.add(promise);
  try { return await promise; }
  finally { pending.delete(promise); }
}

async function executeCommand(job: CronJob): Promise<CommandResult> {
  const invalid = validateCommandJob(job);
  if (invalid) return { status: "error", error: invalid };
  const command = job.command!;
  const key = createHash("sha256").update(job.id).digest("hex").slice(0, 24);
  const dir = path.join(JINN_HOME, "cron", "commands", key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, "running.lock");
  let lockFd: number;
  try { lockFd = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      let active = false;
      try {
        const owner = JSON.parse(fs.readFileSync(lock, "utf8"));
        if (Number.isInteger(owner.gatewayPid) && owner.gatewayPid > 0) {
          if (owner.gatewayPid === process.pid) active = owner.lockOwner === lockOwner;
          else {
            try { process.kill(owner.gatewayPid, 0); active = true; }
            catch (e) { active = (e as NodeJS.ErrnoException).code === "EPERM"; }
          }
        }
      } catch { /* preserve unreadable locks for inspection */ }
      return active
        ? { status: "skipped", reason: "command-locked", error: `Command lock exists: ${lock}` }
        : { status: "error", reason: "command-lock-needs-review", error: `Interrupted or unreadable command lock; inspect before retrying: ${lock}` };
    }
    throw error;
  }
  const startedAt = new Date().toISOString();
  const logFile = path.join(dir, `${Date.now()}-${randomUUID()}.log`);
  let logFd: number | undefined;
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ jobId: job.id, lockOwner, gatewayPid: process.pid, startedAt, logFile }));
    // Keep at most 100 bounded logs per job. Never prune an active lock.
    const logs = fs.readdirSync(dir).filter(name => /^\d+-[a-f0-9-]+\.log$/.test(name)).sort().reverse();
    for (const name of logs.slice(99)) fs.unlinkSync(path.join(dir, name));
    logFd = fs.openSync(logFile, "wx", 0o600);
    const fd = logFd;
    let bytes = 0;
    let logError: string | undefined;
    let abortLogging = () => {};
    const write = (data: Buffer) => {
      const remaining = LOG_LIMIT - bytes;
      if (remaining > 0 && !logError) {
        try { bytes += fs.writeSync(fd, data.subarray(0, remaining)); }
        catch { logError = "Could not persist command output"; abortLogging(); }
      }
    };
    return await new Promise<CommandResult>((resolve) => {
      const child = spawn(command.executable, command.args ?? [], {
        cwd: command.cwd ?? JINN_HOME, shell: false, detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", write);
      child.stderr.on("data", write);
      let timedOut = false;
      let interrupted = false;
      let spawnError: string | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch { /* process group already exited */ }
      };
      const terminate = () => {
        kill("SIGTERM");
        killTimer ??= setTimeout(() => kill("SIGKILL"), 2000);
      };
      abortLogging = terminate;
      const stop = () => { interrupted = true; terminate(); };
      stoppers.add(stop);
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, (command.timeoutSeconds ?? 300) * 1000);
      child.on("error", (error) => { spawnError = error.message; });
      child.on("close", (exitCode, signal) => {
        clearTimeout(timer);
        stoppers.delete(stop);
        if (killTimer) clearTimeout(killTimer);
        // Kill surviving descendants before releasing the lock.
        kill("SIGKILL");
        resolve({ status: !spawnError && !logError && !timedOut && !interrupted && exitCode === 0 ? "success" : "error",
          exitCode, signal, timedOut, logFile,
          ...(spawnError || logError || timedOut || interrupted || exitCode !== 0 ? { error: spawnError ?? logError ?? (interrupted ? "Command interrupted by gateway shutdown" : timedOut ? "Command timed out" : `Command exited ${exitCode ?? signal}`) } : {}),
        });
      });
      // Register cleanup before any post-spawn I/O can fail.
      try {
        fs.ftruncateSync(lockFd, 0);
        fs.writeSync(lockFd, JSON.stringify({ jobId: job.id, lockOwner, gatewayPid: process.pid, childPid: child.pid, startedAt, logFile }), 0);
      } catch {
        logError = "Could not persist command PID";
        terminate();
      }
    });
  } finally {
    if (logFd !== undefined) fs.closeSync(logFd);
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}
