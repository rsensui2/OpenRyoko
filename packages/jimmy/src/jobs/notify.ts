import fs from "node:fs";
import { readGatewayAuthToken } from "../gateway/auth.js";
import { JINN_HOME } from "../shared/paths.js";
import type { JobState } from "./state.js";

/**
 * Wake-up notification for a finished detached job.
 *
 * The message is dispatched to the job's own session via the existing
 * `POST /api/sessions/:id/message` + `role: "notification"` route (the same
 * mechanism child-session callbacks use, see sessions/callbacks.ts), which
 * persists it, enqueues it and runs the engine — i.e. the session wakes up.
 */

const LOG_TAIL_LINES = 40;
const LOG_TAIL_MAX_CHARS = 4000;
const LOG_TAIL_READ_BYTES = 64 * 1024;

/** Read only the last chunk of the file — a multi-GB job log must not be
 *  slurped into the monitor's memory. */
export function readLogTail(logFile: string, maxLines: number = LOG_TAIL_LINES): string {
  let fd: number | undefined;
  try {
    const size = fs.statSync(logFile).size;
    const start = Math.max(0, size - LOG_TAIL_READ_BYTES);
    const buf = Buffer.alloc(size - start);
    fd = fs.openSync(logFile, "r");
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    const tail = lines.slice(-maxLines).join("\n").trimEnd();
    return tail.length > LOG_TAIL_MAX_CHARS ? `…${tail.slice(-LOG_TAIL_MAX_CHARS)}` : tail;
  } catch {
    return "(log file missing or unreadable)";
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

function formatDuration(state: JobState): string {
  const start = new Date(state.startedAt).getTime();
  const end = new Date(state.finishedAt ?? state.startedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "unknown duration";
  const sec = Math.round((end - start) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

export function buildJobNotification(state: JobState, logTail: string): string {
  const succeeded = state.exitCode === 0 && !state.timedOut;
  const outcome = state.timedOut
    ? `timed out after ${state.timeoutSec}s and was killed`
    : state.signal
      ? `was killed by signal ${state.signal}`
      : `exited with code ${state.exitCode}`;

  const header = succeeded
    ? `✅ Detached job "${state.name}" completed successfully (exit 0, ${formatDuration(state)}).`
    : `❌ Detached job "${state.name}" FAILED — ${outcome} (${formatDuration(state)}).`;

  const followUp = succeeded
    ? `Continue the work you deferred behind this job (e.g. assemble the output, upload it) and reply to the original conversation — it is still waiting on you.`
    : [
      `Recover now — do NOT leave the original conversation waiting silently:`,
      `1. Read the full log to diagnose: ${state.logFile}`,
      `2. Fix and re-run the job, or complete the work another way.`,
      `3. If you cannot recover, tell the user in the original conversation what failed.`,
    ].join("\n");

  return [
    header,
    ``,
    `Command: ${state.command}`,
    `Log file: ${state.logFile}`,
    `Last ${LOG_TAIL_LINES} log lines:`,
    "```",
    logTail || "(empty)",
    "```",
    ``,
    followUp,
  ].join("\n");
}

/** Allow only loopback gateway URLs — the wake-up route must never grow into
 *  a remote-wake mechanism (the gateway API is loopback-trust). */
export function assertLoopbackGatewayUrl(gatewayUrl: string): void {
  let host: string;
  try {
    host = new URL(gatewayUrl).hostname;
  } catch {
    throw new Error(`Invalid gateway URL: ${gatewayUrl}`);
  }
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!loopback.has(host)) {
    throw new Error(`Gateway URL must be loopback (got host "${host}") — detached jobs may only wake sessions on the local gateway`);
  }
}

export interface NotifyDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Read on every attempt so a gateway restart can create or rotate the token. */
  readAuthToken?: () => string | null;
  /** Retry delays in ms. Default spans ~10 minutes so a gateway restart is survived. */
  retryDelaysMs?: number[];
}

const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 120_000, 180_000, 240_000];

/**
 * Deliver the wake-up notification, retrying across gateway restarts.
 * Returns `{ok: true}` once the gateway accepted it (exactly-once from this
 * monitor: the caller marks the state file `notified` and never calls again).
 */
export async function sendJobNotification(
  state: JobState,
  message: string,
  deps: NotifyDeps = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const readAuthToken = deps.readAuthToken ?? (() => readGatewayAuthToken(JINN_HOME));
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  assertLoopbackGatewayUrl(state.gatewayUrl);
  const url = `${state.gatewayUrl.replace(/\/$/, "")}/api/sessions/${state.sessionId}/message`;

  let lastError = "unknown";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const token = readAuthToken();
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        // dedupeKey: if the gateway accepted an earlier attempt but the
        // response was lost, the retry must not enqueue a second turn.
        body: JSON.stringify({ message, role: "notification", dedupeKey: `job:${state.id}` }),
      });
      if (res.ok) return { ok: true };
      lastError = `gateway responded ${res.status}`;
      // The session is gone — retrying will never succeed.
      if (res.status === 404) return { ok: false, error: `session ${state.sessionId} not found (404)` };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  return { ok: false, error: lastError };
}
