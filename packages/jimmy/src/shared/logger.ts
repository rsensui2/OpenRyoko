import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "./paths.js";
import { redactText } from "./redact.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

let minLevel: LogLevel = "info";
let writeToStdout = true;
let logStream: fs.WriteStream | null = null;
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
  logStream = fs.createWriteStream(activeLogPath, { flags: "w" });
  logBytes = 0;
}

export function configureLogger(opts: {
  level?: string;
  stdout?: boolean;
  file?: boolean;
}) {
  if (opts.level && opts.level in LEVELS) minLevel = opts.level as LogLevel;
  if (opts.stdout !== undefined) writeToStdout = opts.stdout;
  if (opts.file === false && logStream) {
    logStream.end();
    logStream = null;
    activeLogPath = null;
    logBytes = 0;
  }
  if (opts.file !== false) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const logPath = path.join(LOGS_DIR, "gateway.log");
    if (logStream) {
      logStream.end();
      logStream = null;
    }
    rotateLog(logPath);
    activeLogPath = logPath;
    try { logBytes = fs.statSync(logPath).size; } catch { logBytes = 0; }
    logStream = fs.createWriteStream(logPath, {
      flags: "a",
    });
  }
}

function log(level: LogLevel, message: string) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${redactText(message)}`;
  if (writeToStdout) console.log(line);
  if (logStream) {
    const chunk = line + "\n";
    const bytes = Buffer.byteLength(chunk);
    rotateActiveLogIfNeeded(bytes);
    if (logStream) {
      logStream.write(chunk);
      logBytes += bytes;
    }
  }
}

export const logger = {
  debug: (msg: string) => log("debug", msg),
  info: (msg: string) => log("info", msg),
  warn: (msg: string) => log("warn", msg),
  error: (msg: string) => log("error", msg),
};
