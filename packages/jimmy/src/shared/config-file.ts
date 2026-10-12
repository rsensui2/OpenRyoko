import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { logger } from "./logger.js";
import { CONFIG_PATH } from "./paths.js";

/**
 * config.yaml exists but cannot serve as the base of a merge. Every API writer
 * merges a partial update into the file on disk; starting that merge from an
 * empty object would replace engines, connectors and tokens with the request
 * body alone. The message never quotes the file — a token may sit on the
 * broken line.
 */
export class ConfigFileUnreadableError extends Error {
  readonly code = "CONFIG_UNREADABLE";
  constructor(reason: string) {
    super(`config.yaml ${reason}; refusing to overwrite it. Fix or restore the file, then try again.`);
    this.name = "ConfigFileUnreadableError";
  }
}

/** config.yaml as one read saw it: the text, and the mapping parsed from it. */
export interface ConfigSnapshot {
  /** Exact file contents; null when config.yaml does not exist yet. */
  raw: string | null;
  /** Permission bits of the file that was read; null when it does not exist yet. */
  mode: number | null;
  document: Record<string, unknown>;
}

function parseConfigMapping(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    // js-yaml's own message carries a snippet of the file around the error.
    const line = (err as { mark?: { line?: unknown } }).mark?.line;
    throw new ConfigFileUnreadableError(
      `exists but is not valid YAML${typeof line === "number" ? ` (near line ${line + 1})` : ""}`,
    );
  }
  // Empty or comment-only: nothing is configured yet, so nothing can be lost.
  if (parsed === undefined || parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigFileUnreadableError("exists but its top level is not a mapping");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Read config.yaml as the base for a merge. A missing file is the one honest
 * "start fresh" (setup has not written it yet). A file that is there but
 * cannot be read or parsed throws {@link ConfigFileUnreadableError}.
 */
export function readConfigSnapshot(configPath: string = CONFIG_PATH): ConfigSnapshot {
  let raw: string;
  let mode: number;
  try {
    const fd = fs.openSync(configPath, "r");
    try {
      mode = fs.fstatSync(fd).mode & 0o7777;
      raw = fs.readFileSync(fd).toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { raw: null, mode: null, document: {} };
    throw new ConfigFileUnreadableError(`exists but could not be read (${code ?? "unknown error"})`);
  }
  return { raw, mode, document: parseConfigMapping(raw) };
}

/** Follow a symlinked config.yaml (dotfiles setups) so the link survives the
 *  rename. A missing file is created where it was asked for; a dangling link
 *  creates what it points at, as a plain write would. */
function resolveWriteTarget(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    try {
      return path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
    } catch {
      return filePath;
    }
  }
}

/** Keep the file with whoever owned it: a root-run gateway must not take a
 *  user's config.yaml away from them. Throws EPERM when the process may not
 *  hand the staged file back, which sends the caller to the in-place write. */
function matchOwner(fd: number, target: string): void {
  let previous: fs.Stats;
  try {
    previous = fs.statSync(target);
  } catch {
    return; // being created: the process's own identity stands
  }
  const staged = fs.fstatSync(fd);
  if (previous.uid === staged.uid && previous.gid === staged.gid) return;
  fs.fchownSync(fd, previous.uid, previous.gid);
}

function stageFile(temporary: string, data: string, mode: number, target: string): void {
  const fd = fs.openSync(temporary, "wx", mode);
  try {
    fs.writeFileSync(fd, data, "utf-8");
    fs.fchmodSync(fd, mode); // the mode given to open() is filtered by the umask
    matchOwner(fd, target);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** rename(2) cannot replace these targets (a bind-mounted single file, a
 *  directory the process may not write to, a file it does not own). Writing in
 *  place still works there, and is what saving did before. Deliberately NOT
 *  here: ENOSPC, EIO — an in-place write would truncate the file and then fail. */
const IN_PLACE_FALLBACK_CODES = new Set(["EBUSY", "EXDEV", "EACCES", "EPERM", "EROFS"]);
let warnedInPlaceWrite = false;

function replaceFile(filePath: string, data: string, mode: number): void {
  const target = resolveWriteTarget(filePath);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}-${randomUUID()}.tmp`);
  try {
    stageFile(temporary, data, mode, target);
    fs.renameSync(temporary, target);
  } catch (err) {
    try { fs.unlinkSync(temporary); } catch { /* never created */ }
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (!IN_PLACE_FALLBACK_CODES.has(code)) throw err;
    if (!warnedInPlaceWrite) {
      warnedInPlaceWrite = true;
      logger.warn(`config.yaml cannot be replaced atomically here (${code}); writing it in place instead`);
    }
    fs.writeFileSync(target, data, "utf-8");
  }
}

/**
 * Replace config.yaml with `document`. The new contents are staged in a
 * temporary file next to it and renamed into place, so a crash or a full disk
 * mid-write leaves the previous file whole — neither the gateway's watcher nor
 * the next boot ever reads a half-written config. `snapshot` is the read the
 * document was merged from: it tells whether the file is being created
 * (owner-only, it holds tokens) or replaced (permission bits kept).
 */
export function writeConfigDocument(
  snapshot: ConfigSnapshot,
  document: Record<string, unknown>,
  configPath: string = CONFIG_PATH,
): void {
  replaceFile(configPath, yaml.dump(document), snapshot.mode ?? 0o600);
}
