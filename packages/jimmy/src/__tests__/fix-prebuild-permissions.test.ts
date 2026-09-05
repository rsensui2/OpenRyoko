import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/* node-pty ships prebuilds/<platform>/spawn-helper as 0644 and nothing on the
 * install path restores the executable bit — on macOS the first PTY start then
 * fails. The published package's postinstall has to fix that in BOTH layouts
 * it gets installed into: plain npm (nested / hoisted / global) and a pnpm
 * workspace (symlink into the .pnpm store). These tests build each layout in a
 * temp dir and run the real script the way npm/pnpm do — cwd = package dir. */

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/fix-prebuild-permissions.mjs");
const created: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-prebuild-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A minimal node-pty package: resolvable main + prebuilds with 0644 helpers. */
function fakeNodePty(root: string, platforms: string[]): string[] {
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0", main: "lib/index.js" }));
  fs.writeFileSync(path.join(root, "lib", "index.js"), "module.exports = {};\n");
  return platforms.map((platform) => {
    const dir = path.join(root, "prebuilds", platform);
    fs.mkdirSync(dir, { recursive: true });
    const helper = path.join(dir, "spawn-helper");
    fs.writeFileSync(helper, "#!/bin/sh\n");
    fs.chmodSync(helper, 0o644);
    return helper;
  });
}

function packageDir(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openryoko", version: "0.0.0" }));
  return root;
}

function run(cwd: string): string {
  return execFileSync(process.execPath, [SCRIPT], { cwd, env: { ...process.env, FIX_PREBUILD_VERBOSE: "1" }, encoding: "utf8" });
}

const mode = (file: string): number => fs.statSync(file).mode & 0o777;

describe.skipIf(process.platform === "win32")("scripts/fix-prebuild-permissions.mjs", () => {
  it("makes spawn-helper executable in the npm layout (<package>/node_modules/node-pty)", () => {
    const pkg = packageDir(tmpDir());
    const helpers = fakeNodePty(path.join(pkg, "node_modules", "node-pty"), ["darwin-arm64", "darwin-x64"]);
    expect(helpers.map(mode)).toEqual([0o644, 0o644]);
    const out = run(pkg);
    expect(helpers.map(mode)).toEqual([0o755, 0o755]);
    expect(out).toContain("2 spawn-helper(s) made executable");
  });

  it("follows a hoisted dependency (node-pty in a parent node_modules, as npm does in a project)", () => {
    const project = tmpDir();
    const [helper] = fakeNodePty(path.join(project, "node_modules", "node-pty"), ["darwin-arm64"]);
    const pkg = packageDir(path.join(project, "node_modules", "openryoko"));
    run(pkg);
    expect(mode(helper)).toBe(0o755);
  });

  it("follows the pnpm workspace layout (package's node_modules/node-pty is a symlink into the .pnpm store)", () => {
    const workspace = tmpDir();
    const store = path.join(workspace, "node_modules", ".pnpm", "node-pty@1.1.0", "node_modules", "node-pty");
    const [helper] = fakeNodePty(store, ["darwin-arm64"]);
    const pkg = packageDir(path.join(workspace, "packages", "jimmy"));
    fs.mkdirSync(path.join(pkg, "node_modules"));
    fs.symlinkSync(path.relative(path.join(pkg, "node_modules"), store), path.join(pkg, "node_modules", "node-pty"));
    run(pkg);
    expect(mode(helper)).toBe(0o755); // the store file, through the symlink
  });

  it("finds a pnpm store above the package even when node-pty is not linked into it", () => {
    const workspace = tmpDir();
    const [helper] = fakeNodePty(path.join(workspace, "node_modules", ".pnpm", "node-pty@1.1.0", "node_modules", "node-pty"), ["darwin-x64"]);
    const pkg = packageDir(path.join(workspace, "packages", "jimmy"));
    run(pkg);
    expect(mode(helper)).toBe(0o755);
  });

  it("leaves an already-executable helper alone and reports nothing fixed", () => {
    const pkg = packageDir(tmpDir());
    const [helper] = fakeNodePty(path.join(pkg, "node_modules", "node-pty"), ["darwin-arm64"]);
    fs.chmodSync(helper, 0o755);
    const out = run(pkg);
    expect(mode(helper)).toBe(0o755);
    expect(out).toContain("0 spawn-helper(s) made executable");
  });

  it("exits 0 and touches nothing when node-pty is absent", () => {
    const pkg = packageDir(tmpDir());
    expect(() => run(pkg)).not.toThrow();
    expect(fs.existsSync(path.join(pkg, "node_modules"))).toBe(false);
  });
});
