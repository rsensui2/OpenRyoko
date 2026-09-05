import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-worker home isolation. The globalSetup hands every fork the same temp
 * root; suites in CONCURRENT forks would then share one sessions registry, and
 * a boot sweep in one file (restart-redispatch's recoverStaleWorkflowAttempt-
 * Sessions) can stamp `interrupted` over another file's mid-turn session.
 * Runs before the test module is imported, so shared/paths.ts resolves the
 * per-process home. A test file that re-points JINN_HOME at its own mkdtemp
 * still wins — it does so before dynamically importing the modules under test.
 */
const base = process.env.JINN_HOME;
if (base) {
  // Pool ID first: under a threads pool every worker shares one PID, so PID
  // alone would collapse the isolation this file exists to provide. The PID
  // stays as a suffix so the forks pool (isolate: true — a fresh fork per test
  // file) also separates sequential files that reuse a pool slot.
  const worker = `${process.env.VITEST_POOL_ID ?? '0'}-${process.pid}`;
  const workerHome = path.join(base, `w-${worker}`);
  fs.mkdirSync(workerHome, { recursive: true });
  process.env.JINN_HOME = workerHome;
}
