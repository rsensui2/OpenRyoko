import { createHmac, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { editYamlText } from "./config-yaml-edit.js";
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

// Lives in a module of its own so that loadConfig() can use it without
// pulling in the config writer; still exported from here for its callers.
export { configErrorForLog } from "./config-error.js";

/** config.yaml as one read saw it: the text, and the mapping parsed from it. */
export interface ConfigSnapshot {
  /** The file's text; null when config.yaml does not exist yet. */
  raw: string | null;
  /** The file's exact bytes, for putting this very version back; null like `raw`. */
  bytes: Buffer | null;
  /** Permission bits of the file that was read; null when it does not exist yet. */
  mode: number | null;
  document: Record<string, unknown>;
  /** Identifies these exact bytes, within this process (see revisionOf); empty while the file does not exist. */
  revision: string;
}

/** Made when the process starts and kept in its memory only. */
const REVISION_KEY = randomBytes(32);

/**
 * Derived from the bytes rather than read off an mtime: a rename-based write
 * moves the mtime even when it changed nothing.
 *
 * Keyed (HMAC), not a plain hash. The revision is sent to every client of the
 * API, and the file it is made from holds tokens: a plain digest would let
 * whoever sees it test guesses about the file offline. With a key that never
 * leaves this process it says one thing only — whether the file is still the
 * one that was read. A revision therefore does not survive a restart: a page
 * left open across one gets a single conflict on its next save, and reloads.
 */
function revisionOf(bytes: Buffer | string): string {
  return createHmac("sha256", REVISION_KEY).update(bytes).digest("hex");
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
  let bytes: Buffer;
  let mode: number;
  try {
    const fd = fs.openSync(configPath, "r");
    try {
      mode = fs.fstatSync(fd).mode & 0o7777;
      bytes = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { raw: null, bytes: null, mode: null, document: {}, revision: "" };
    throw new ConfigFileUnreadableError(`exists but could not be read (${code ?? "unknown error"})`);
  }
  const raw = bytes.toString("utf-8");
  return { raw, bytes, mode, document: parseConfigMapping(raw), revision: revisionOf(bytes) };
}

/**
 * Replace config.yaml with `text` exactly as given — for a writer that edits
 * the text itself (the onboarding portal block) or puts an earlier version of
 * the file back (pass that snapshot's `bytes`). Staged and renamed into place
 * like writeConfigDocument, with the permission bits and owner of the file
 * `snapshot` was read from. Returns the revision of what was written.
 */
export function writeConfigText(snapshot: ConfigSnapshot, text: string | Buffer, configPath: string = CONFIG_PATH): string {
  replaceFile(configPath, text, snapshot.mode ?? 0o600);
  return revisionOf(text);
}

/**
 * Read config.yaml, let `change` derive the next document, and write it: one
 * call for a writer that sets a few keys. `change` receives a copy it is free
 * to modify. Throws when config.yaml does not exist — a setting on its own is
 * not a config the gateway could start from — or cannot be read.
 */
export function updateConfigDocument(
  change: (document: Record<string, unknown>) => Record<string, unknown>,
  configPath: string = CONFIG_PATH,
): string {
  const snapshot = readConfigSnapshot(configPath);
  if (snapshot.raw === null) throw new Error("config.yaml not found");
  return writeConfigDocument(snapshot, change(structuredClone(snapshot.document)), configPath);
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

function stageFile(temporary: string, data: string | Buffer, mode: number, target: string): void {
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

function replaceFile(filePath: string, data: string | Buffer, mode: number): void {
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
 * The text to store for `document`. config.yaml is edited by hand as much as
 * through the API, so only the lines whose value changed are rewritten: the
 * comments, the order of keys and the quoting of everything else stay as they
 * are. Where that cannot be done safely the whole document is dumped, the way
 * every save used to be.
 */
function renderConfig(snapshot: ConfigSnapshot, document: Record<string, unknown>): string {
  if (snapshot.raw === null) return yaml.dump(document);
  const edited = editYamlText(snapshot.raw, snapshot.document, document);
  if (edited !== null) return edited;
  if (/^\s*#/m.test(snapshot.raw)) {
    logger.info("config.yaml was rewritten in full: this change could not be applied in place, so its comments were not kept");
  }
  return yaml.dump(document);
}

/**
 * Replace config.yaml with `document`. The new contents are staged in a
 * temporary file next to it and renamed into place, so a crash or a full disk
 * mid-write leaves the previous file whole — neither the gateway's watcher nor
 * the next boot ever reads a half-written config. `snapshot` is the read the
 * document was merged from: it tells whether the file is being created
 * (owner-only, it holds tokens) or replaced (permission bits kept), and it is
 * the text the changed lines are written into. Returns the revision of what
 * was written.
 */
export function writeConfigDocument(
  snapshot: ConfigSnapshot,
  document: Record<string, unknown>,
  configPath: string = CONFIG_PATH,
): string {
  const data = renderConfig(snapshot, document);
  replaceFile(configPath, data, snapshot.mode ?? 0o600);
  return revisionOf(data);
}
