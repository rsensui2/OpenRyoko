import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createBackupRun, type BackupRun } from "./gateway-url-backup.js";

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "sessions", "logs", "tmp", "jobs",
  "files", "models", "backups", "src", "updates", "runs", "migrations",
  "knowledge", "memory",
  // Skill copies the bundled skill sync moved aside: archives, not live references.
  ".migration-backups",
]);
const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".js", ".mjs",
  ".cjs", ".ts", ".tsx", ".py", ".sh", ".bash", ".zsh",
]);
const TEXT_BASENAMES = new Set(["CLAUDE.md", "AGENTS.md", "SOUL.md", "TOOLS.md", "MEMORY.md"]);
const LEGACY_V4 = /http:\/\/0\.0\.0\.0:(\d{1,5})/g;
const LEGACY_V6 = /http:\/\/\[::\]:(\d{1,5})/g;

export interface GatewayAuditReport {
  legacyFiles: string[];
  legacyOccurrences: number;
  fixedFiles: string[];
  unauthenticatedCurlCandidates: string[];
  backupDir?: string;
  /** Why no file was fixed although fixing was asked for and there was something to
   *  fix: the backup location could not be used, and nothing is rewritten unbacked. */
  fixRefused?: string;
}

export interface GatewayAuditOptions {
  fix?: boolean;
  now?: Date;
}

function isScannableTextFile(file: string, size: number): boolean {
  if (size > MAX_TEXT_FILE_BYTES) return false;
  return TEXT_BASENAMES.has(path.basename(file)) || TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function collectTextFiles(home: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.statSync(full);
        if (isScannableTextFile(full, stat.size)) files.push(full);
      } catch { /* file disappeared during scan */ }
    }
  };
  walk(home);
  return files;
}

function replacementCount(content: string): number {
  return (content.match(LEGACY_V4) ?? []).length + (content.match(LEGACY_V6) ?? []).length;
}

function replaceLegacyGatewayUrls(content: string): string {
  return content
    .replace(LEGACY_V4, "http://127.0.0.1:$1")
    .replace(LEGACY_V6, "http://[::1]:$1");
}

function looksLikeUnauthenticatedGatewayCurl(content: string): boolean {
  const apiLines = content.split(/\r?\n/).filter((line) => /curl\b/.test(line) && /\/api\//.test(line));
  if (apiLines.length === 0 || apiLines.every((line) => /\/api\/health(?:\b|[?"'])/.test(line))) return false;
  return !/(?:Authorization\s*:.*Bearer|gateway-auth\.json|readGatewayAuthToken|ryoko\s+api\s+)/i.test(content);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Replace `file` in one step, keeping its mode. The temporary file has a random name
 * and is created exclusively: a name built from the PID could be guessed, and a link
 * planted there was written through — overwriting whatever it pointed at, anywhere,
 * with text taken from a file in the home. The mode is set on the open temporary
 * file: set by path, it would land on whatever a link swapped in there points at.
 */
function atomicWritePreservingMode(file: string, content: string, mode: number): void {
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, "wx", mode);
  try {
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fchmodSync(fd, mode);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** The file's mode if it is, right now, a regular file — not a link put there since it was listed. */
function regularFileMode(file: string): number | null {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? stat.mode & 0o777 : null;
  } catch {
    return null;
  }
}

/** Audit and optionally repair unsafe bind-address URLs under one instance home. */
export function auditGatewayReferences(home: string, options: GatewayAuditOptions = {}): GatewayAuditReport {
  const report: GatewayAuditReport = {
    legacyFiles: [],
    legacyOccurrences: 0,
    fixedFiles: [],
    unauthenticatedCurlCandidates: [],
  };
  // Made when the first file needs it. Null once it turned out it cannot be made:
  // a file is not rewritten without a copy of what it held, so nothing is fixed then.
  let run: BackupRun | null | undefined;
  const backupRun = (): BackupRun | null => {
    if (run !== undefined) return run;
    try {
      run = createBackupRun(home, timestampForPath(options.now ?? new Date()));
    } catch (error) {
      report.fixRefused = error instanceof Error ? error.message : String(error);
      run = null;
    }
    return run;
  };

  for (const file of collectTextFiles(home)) {
    let content: string;
    try {
      const loaded = fs.readFileSync(file, "utf8");
      if (typeof loaded !== "string") continue;
      content = loaded;
    }
    catch { continue; }

    const relative = path.relative(home, file);
    const occurrences = replacementCount(content);
    if (occurrences > 0) {
      report.legacyFiles.push(relative);
      report.legacyOccurrences += occurrences;
      // Checked again here, without following: backing up and rewriting a link would
      // copy and chmod whatever it points at.
      const mode = options.fix ? regularFileMode(file) : null;
      const backup = mode === null ? null : backupRun();
      if (mode !== null && backup !== null) {
        // The copy comes first, and a file that could not be copied is not rewritten.
        backup.keep(file, relative, mode);
        content = replaceLegacyGatewayUrls(content);
        atomicWritePreservingMode(file, content, mode);
        report.fixedFiles.push(relative);
      }
    }
    if (looksLikeUnauthenticatedGatewayCurl(content)) report.unauthenticatedCurlCandidates.push(relative);
  }

  if (run) report.backupDir = run.directory;
  return report;
}
