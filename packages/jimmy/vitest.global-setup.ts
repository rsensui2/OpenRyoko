import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Redirect the ryoko home to a throwaway directory BEFORE any test worker
 * loads shared/paths.ts — without this, suites that touch the session
 * registry or the workflow store write into the real ~/.ryoko.
 * (Ported rationale from upstream jinn's vitest.global-setup.ts.)
 */
export default function setup(): () => void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ryoko-vitest-home-'));
  // JINN_HOME only: RYOKO_HOME outranks it in resolveHome(), and upstream-authored
  // suites re-point JINN_HOME at their own temp roots — a lingering RYOKO_HOME
  // would silently override every one of them.
  delete process.env.RYOKO_HOME;
  process.env.JINN_HOME = home;
  return () => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  };
}
