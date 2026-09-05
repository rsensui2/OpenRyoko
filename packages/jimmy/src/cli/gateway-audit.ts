import fs from "node:fs";
import path from "node:path";

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "sessions", "logs", "tmp", "jobs",
  "files", "models", "backups", "src", "updates", "runs", "migrations",
  "knowledge", "memory",
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

function atomicWritePreservingMode(file: string, content: string, mode: number): void {
  const temporary = `${file}.tmp-gateway-url-${process.pid}`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

/** Audit and optionally repair unsafe bind-address URLs under one instance home. */
export function auditGatewayReferences(home: string, options: GatewayAuditOptions = {}): GatewayAuditReport {
  const report: GatewayAuditReport = {
    legacyFiles: [],
    legacyOccurrences: 0,
    fixedFiles: [],
    unauthenticatedCurlCandidates: [],
  };
  let backupDir: string | undefined;

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
      if (options.fix) {
        backupDir ??= path.join(home, "backups", `gateway-url-${timestampForPath(options.now ?? new Date())}`);
        const backupFile = path.join(backupDir, relative);
        fs.mkdirSync(path.dirname(backupFile), { recursive: true, mode: 0o700 });
        const mode = fs.statSync(file).mode & 0o777;
        fs.copyFileSync(file, backupFile);
        fs.chmodSync(backupFile, mode);
        content = replaceLegacyGatewayUrls(content);
        atomicWritePreservingMode(file, content, mode);
        report.fixedFiles.push(relative);
      }
    }
    if (looksLikeUnauthenticatedGatewayCurl(content)) report.unauthenticatedCurlCandidates.push(relative);
  }

  if (backupDir) report.backupDir = backupDir;
  return report;
}
