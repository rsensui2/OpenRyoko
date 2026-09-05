// Restore the executable bit on node-pty's spawn-helper after install.
//
// node-pty ships prebuilds/<platform>/spawn-helper with mode 0644 in its npm
// tarball, and neither npm nor pnpm nor node-pty's own install scripts turn
// it back into an executable. On macOS the native module then fails at the
// first PTY start (posix_spawnp EACCES) — i.e. the gateway crashes the first
// time a chat session starts an engine.
//
// This runs as the `postinstall` of the published package, so it covers both
// layouts:
//   - npm:  <this package>/node_modules/node-pty  (also hoisted / global)
//   - pnpm: <workspace>/node_modules/.pnpm/node-pty@*/node_modules/node-pty
// It resolves node-pty the way Node would (so hoisting and symlinks are
// followed) and additionally scans any pnpm store found walking up from the
// package directory. Everything is non-fatal: an install must never break
// because a chmod could not be applied.
import { chmod, readdir, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const MAX_WALK_UP = 6;
const verbose = process.env.npm_config_loglevel === "verbose" || process.env.FIX_PREBUILD_VERBOSE === "1";

function log(message) {
  if (verbose) process.stdout.write(`fix-prebuild-permissions: ${message}\n`);
}

async function directories(target) {
  try {
    const entries = await readdir(target, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Where Node would load node-pty from, seen from `base` — covers the npm
// layout (nested, hoisted, or `npm install -g`) and a linked pnpm dependency.
async function resolvedNodePty(base) {
  const require = createRequire(path.join(base, "package.json"));
  try {
    return path.dirname(await realpath(require.resolve("node-pty/package.json")));
  } catch {
    // An "exports" map may hide package.json; resolve the entry point instead
    // and walk up to the package root.
  }
  try {
    let dir = path.dirname(await realpath(require.resolve("node-pty")));
    for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
      if (path.basename(dir) === "node-pty") return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // not installed here — the pnpm store scan may still find it
  }
  return null;
}

// Every node-pty version in a pnpm store found walking up from `base` — for a
// workspace install where the dependency may not (yet) be linked into this
// package's own node_modules.
async function pnpmStoreNodePtys(base) {
  const found = [];
  let dir = base;
  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    const store = path.join(dir, "node_modules", ".pnpm");
    for (const entry of await directories(store)) {
      if (!entry.startsWith("node-pty@")) continue;
      const candidate = path.join(store, entry, "node_modules", "node-pty");
      try {
        found.push(await realpath(candidate));
      } catch {
        // dangling entry — not ours to fix
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

async function makeExecutable(file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    if ((info.mode & 0o111) === 0o111) return false; // already fine
    await chmod(file, 0o755);
    return true;
  } catch {
    // No spawn-helper for this prebuild, or no permission to change it.
    return false;
  }
}

async function main() {
  if (process.platform === "win32") return; // no executable bit to restore

  const base = process.cwd(); // npm and pnpm run lifecycle scripts inside the package directory
  const candidates = new Set();
  const resolved = await resolvedNodePty(base);
  if (resolved) candidates.add(resolved);
  for (const dir of await pnpmStoreNodePtys(base)) candidates.add(dir);

  let fixed = 0;
  let seen = 0;
  for (const dir of candidates) {
    const prebuilds = path.join(dir, "prebuilds");
    for (const platform of await directories(prebuilds)) {
      seen += 1;
      if (await makeExecutable(path.join(prebuilds, platform, "spawn-helper"))) fixed += 1;
    }
  }
  log(`${candidates.size} node-pty location(s), ${seen} prebuild dir(s), ${fixed} spawn-helper(s) made executable`);
}

main().catch((error) => {
  // Never fail an install over this.
  log(`skipped: ${error instanceof Error ? error.message : String(error)}`);
});
