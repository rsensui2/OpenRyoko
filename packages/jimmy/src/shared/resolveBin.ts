import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { logger } from "./logger.js";

const cache = new Map<string, string>();
const warnedMisses = new Set<string>();

/**
 * Walk PATH (then the user install directories) in pure JS to locate an executable. Avoids shelling out
 * (which would be a command-injection sink, since bin names come from
 * user-editable config like engines.*.bin).
 */
function findOnPath(bin: string): string | null {
  // Reject anything that would let a config value escape PATH lookup —
  // e.g. embedded slashes ("..","sub/path"), null bytes, or shell-metacharacters.
  // Absolute paths are handled by the caller before reaching here.
  if (!bin || /[\0/\\]/.test(bin)) return null;

  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const dir of [...PATH.split(sep), ...userInstallDirs()]) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        // On Unix, also require an exec bit (matches `which` semantics).
        if (process.platform !== "win32" && (stat.mode & 0o111) === 0) continue;
        return candidate;
      } catch {
        /* miss */
      }
    }
  }
  return null;
}

/**
 * Searched after PATH. The Claude Code and Antigravity installers put their
 * CLI in ~/.local/bin, which a daemon's or container's PATH often leaves out.
 */
function userInstallDirs(): string[] {
  if (process.platform === "win32") return [];
  const home = os.homedir();
  return home ? [path.join(home, ".local", "bin")] : [];
}

const INSTALL_HINTS: Record<string, string[]> = {
  claude: [
    "npm install -g @anthropic-ai/claude-code",
    "If installed but invisible to a daemon, set Environment=PATH=… in your systemd unit, or set engines.claude.bin to an absolute path in ~/.ryoko/config.yaml.",
  ],
  codex: [
    "npm install -g @openai/codex",
    "If installed but invisible to a daemon, set engines.codex.bin to an absolute path in ~/.ryoko/config.yaml.",
  ],
  agy: [
    "curl -fsSL https://antigravity.google/cli/install.sh | bash   (installs ~/.local/bin/agy), then run `agy` once to sign in",
    "If installed but invisible to a daemon, set engines.antigravity.bin to an absolute path in ~/.ryoko/config.yaml.",
  ],
  gemini: [
    "npm install -g @google/gemini-cli",
    "If installed but invisible to a daemon, set engines.gemini.bin to an absolute path in ~/.ryoko/config.yaml.",
  ],
};

/**
 * Resolve a CLI binary to an absolute path.
 *
 * If `bin` looks absolute, verify it exists. Otherwise search PATH via
 * `which`/`where`. On failure, fall back to the original name (the caller
 * will spawn it and surface a friendlier ENOENT message via `formatSpawnError`).
 *
 * Results are cached for the lifetime of the process so the lookup never
 * re-shells out hot-path. Tests can clear the cache via `_clearResolveBinCache`.
 */
export function resolveBin(bin: string): string {
  if (!bin) return bin;

  const cached = cache.get(bin);
  if (cached) return cached;

  if (path.isAbsolute(bin)) {
    if (fs.existsSync(bin)) {
      cache.set(bin, bin);
      return bin;
    }
    return bin;
  }

  const found = findOnPath(bin);
  if (found) {
    cache.set(bin, found);
    return found;
  }

  if (!warnedMisses.has(bin)) {
    warnedMisses.add(bin);
    logger.warn(
      `Could not resolve "${bin}" to an absolute path; will rely on PATH at spawn time. ` +
        `If you see ENOENT under systemd, set Environment=PATH=… or use an absolute bin path.`,
    );
  }
  return bin;
}

/**
 * Like {@link resolveBin}, but returns null on miss instead of falling back.
 * Useful for setup/health checks where you want to know whether the binary
 * is actually discoverable.
 */
export function tryResolveBin(bin: string): string | null {
  if (!bin) return null;
  if (path.isAbsolute(bin)) {
    return fs.existsSync(bin) ? bin : null;
  }
  const cached = cache.get(bin);
  if (cached) return cached;

  const found = findOnPath(bin);
  if (found) {
    cache.set(bin, found);
    return found;
  }
  return null;
}

/**
 * Format a spawn error with actionable hints. ENOENT typically means the
 * binary wasn't on PATH (very common under systemd because PATH defaults to
 * `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` and excludes
 * nvm shims). Other errors get a generic wrap.
 */
export function formatSpawnError(label: string, requestedBin: string, err: NodeJS.ErrnoException | Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    const hints = INSTALL_HINTS[requestedBin] ?? [
      `Ensure "${requestedBin}" is installed and on PATH, or pass an absolute path.`,
    ];
    return [
      `Failed to spawn ${label} (${requestedBin}): ENOENT — binary not found on PATH.`,
      `PATH=${process.env.PATH ?? "(empty)"}`,
      "Try one of:",
      ...hints.map((h) => `  - ${h}`),
    ].join("\n");
  }
  return `Failed to spawn ${label} (${requestedBin}): ${err.message}`;
}

/** Test-only: clear the resolution cache and miss-warning set. */
export function _clearResolveBinCache(): void {
  cache.clear();
  warnedMisses.clear();
}
