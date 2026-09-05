import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureOwnerOnlyDirectory } from "../owner-only.js";

describe("ensureOwnerOnlyDirectory", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "win32")("creates and heals a POSIX directory to 0700", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-owner-"));
    roots.push(root);
    const home = path.join(root, "instance");
    expect(ensureOwnerOnlyDirectory(home).warning).toBeUndefined();
    fs.chmodSync(home, 0o755);
    expect(ensureOwnerOnlyDirectory(home).warning).toBeUndefined();
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });
});
