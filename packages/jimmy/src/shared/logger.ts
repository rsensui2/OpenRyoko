import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "./paths.js";
import { redactText } from "./redact.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

let minLevel: LogLevel = "info";
let writeToStdout = true;
/** Whether lines are wanted in the log file at the moment. */
let writeToFile = false;
/** The stream lines for the file go to. There is only ever one writing at a time. */
let logStream: fs.WriteStream | null = null;
/** Streams that were closed and have not finished writing yet. */
let closing = 0;
/** Lines for the file that wait for those streams to finish, in the order they were logged. */
let waiting: string[] | null = null;
const LOG_MAX_BYTES = 10 * 1024 * 1024;
const LOG_BACKUPS = 3;
let activeLogPath: string | null = null;
let logBytes = 0;

function rotateLog(logPath: string, force = false): boolean {
  let size = 0;
  try { size = fs.statSync(logPath).size; } catch { return false; }
  if (!force && size < LOG_MAX_BYTES) return false;
  try {
    const oldest = `${logPath}.${LOG_BACKUPS}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    for (let i = LOG_BACKUPS - 1; i >= 1; i--) {
      const source = `${logPath}.${i}`;
      if (fs.existsSync(source)) fs.renameSync(source, `${logPath}.${i + 1}`);
    }
    fs.renameSync(logPath, `${logPath}.1`);
    return true;
  } catch (err) {
    console.warn(`[openryoko] log rotation failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function rotateActiveLogIfNeeded(nextBytes: number): void {
  if (!logStream || !activeLogPath || logBytes + nextBytes <= LOG_MAX_BYTES) return;
  const stream = logStream;
  logStream = null;
  stream.end();
  // If rename fails (for example due to an open-file restriction), opening with
  // "w" still truncates the active generation so disk growth stays bounded.
  rotateLog(activeLogPath, true);
  logStream = openLog(activeLogPath, "w");
  logBytes = 0;
}

/**
 * Open the log file. A stream nobody listens to for errors brings the process down
 * when the file cannot be opened or written (no permission, a full disk, something
 * that is not a file in its place). The log is not worth that: the stream is dropped,
 * this is said once where it still can be, and logging goes on without the file.
 */
function openLog(logPath: string, flags: "a" | "w"): fs.WriteStream {
  const stream = fs.createWriteStream(logPath, { flags });
  stream.on("error", (error) => {
    if (logStream === stream) logStream = null;
    console.warn(`[openryoko] cannot write ${logPath}: ${error.message}. Logging continues without the file.`);
  });
  return stream;
}

/** Start writing to the log file, rotating it first if it has grown too large. */
function startLog(): void {
  const logPath = path.join(LOGS_DIR, "gateway.log");
  rotateLog(logPath);
  activeLogPath = logPath;
  try { logBytes = fs.statSync(logPath).size; } catch { logBytes = 0; }
  logStream = openLog(logPath, "a");
}

/**
 * Close a stream, and keep the file to itself until it has finished. Its last lines
 * are still on their way when `end()` returns. A second stream opened on the same file
 * at that moment races it there, and a line logged later can land above the lines
 * logged before: in a log, that is the order of events told wrong.
 */
function retire(stream: fs.WriteStream): void {
  closing += 1;
  stream.once("close", () => {
    closing -= 1;
    if (closing === 0) resumeLog();
  });
  stream.end();
}

/** Every stream closed earlier has finished. Hand the file to whatever waited for it. */
function resumeLog(): void {
  const held = waiting;
  waiting = null;
  if (held === null || (!writeToFile && held.length === 0)) return;
  startLog();
  for (const chunk of held) writeToLog(chunk);
  // Turned off again while it waited: what had been accepted is written, and no more.
  if (!writeToFile) stopLog();
}

function stopLog(): void {
  if (!logStream) return;
  const stream = logStream;
  logStream = null;
  activeLogPath = null;
  logBytes = 0;
  retire(stream);
}

function writeToLog(chunk: string): void {
  const bytes = Buffer.byteLength(chunk);
  rotateActiveLogIfNeeded(bytes);
  if (logStream) {
    logStream.write(chunk);
    logBytes += bytes;
  }
}

export function configureLogger(opts: {
  level?: string;
  stdout?: boolean;
  file?: boolean;
}) {
  if (opts.level && opts.level in LEVELS) minLevel = opts.level as LogLevel;
  if (opts.stdout !== undefined) writeToStdout = opts.stdout;
  if (opts.file === false) {
    writeToFile = false;
    stopLog();
    return;
  }
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  writeToFile = true;
  // Already writing there: keep the stream. `ryoko start` sets the logger up before
  // the gateway does, the same way, and nothing is gained by opening the file twice.
  if (logStream) return;
  // A stream closed a moment ago is still writing. The file is opened again when it
  // has finished, and what is logged until then waits its turn (see `retire`).
  if (closing > 0) {
    waiting ??= [];
    return;
  }
  startLog();
}

function log(level: LogLevel, message: string) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${redactText(message)}`;
  if (writeToStdout) console.log(line);
  if (!writeToFile) return;
  const chunk = line + "\n";
  if (waiting) waiting.push(chunk);
  else if (logStream) writeToLog(chunk);
}

export const logger = {
  debug: (msg: string) => log("debug", msg),
  info: (msg: string) => log("info", msg),
  warn: (msg: string) => log("warn", msg),
  error: (msg: string) => log("error", msg),
};
