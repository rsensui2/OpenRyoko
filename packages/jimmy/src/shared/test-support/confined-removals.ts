import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

/**
 * True when `target` is an absolute path strictly inside the absolute
 * directory `directory`. Pure string work: nothing is read from disk and the
 * working directory plays no part, so it can be tested with any hostile input.
 */
export function isStrictlyInside(directory: string, target: unknown): target is string {
  if (typeof target !== "string" || !path.isAbsolute(directory) || !path.isAbsolute(target)) return false;
  const relative = path.relative(directory, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export interface ConfinedRemovals {
  /** Every path the code under test asked fs.rmSync to remove, in order. */
  requests: string[];
  /** The requests that were inside the sandbox and were therefore carried out. */
  performed: string[];
  /** The real fs.rmSync, for the test's own cleanup of paths it created. */
  remove: typeof fs.rmSync;
  isInside(target: string): boolean;
}

/**
 * For tests of code that deletes. Replaces fs.rmSync with a recorder that
 * carries out a removal only when the target is an absolute path strictly
 * inside `sandbox`; every other request is recorded and dropped.
 *
 * A test of deletion code must stay harmless when that code is wrong. With a
 * path guard broken, such a test used to remove whatever the bad path pointed
 * at — a working directory, once. Here it fails an assertion on `requests`
 * instead. Undone by vi.restoreAllMocks().
 */
export function confineRemovals(sandbox: string): ConfinedRemovals {
  if (!isStrictlyInside(os.tmpdir(), sandbox) && !isStrictlyInside(fs.realpathSync(os.tmpdir()), sandbox)) {
    throw new Error(`confineRemovals: the sandbox must be a directory inside the OS temp directory, got ${JSON.stringify(sandbox)}`);
  }
  const root = path.normalize(sandbox);
  const remove = fs.rmSync.bind(fs);
  const confined: ConfinedRemovals = {
    requests: [],
    performed: [],
    remove,
    isInside: (target) => isStrictlyInside(root, target),
  };
  vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    confined.requests.push(String(target));
    if (!isStrictlyInside(root, target)) return;
    confined.performed.push(target);
    remove(target, options);
  });
  return confined;
}
