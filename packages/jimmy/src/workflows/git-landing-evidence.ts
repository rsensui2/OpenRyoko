import { execFile } from "node:child_process";
import { loadConfig } from "../shared/config.js";
import type { WorkflowLandingVerifier } from "./run-closure.js";

export interface CanonicalGitTarget {
  remote: string;
  branch: string;
}

function git(checkout: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", checkout, ...args],
      { timeout: 30_000, windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}

function canonicalTarget(): CanonicalGitTarget {
  const delivery = loadConfig().workflows?.delivery;
  return { remote: delivery?.remote ?? "origin", branch: delivery?.branch ?? "main" };
}

/**
 * Proof that a commit reached the freshly fetched canonical remote branch.
 *
 * An argument vector, never a shell string — both values come out of a phase's
 * submitted output, so both are input. Exit 1 is git's answer, and everything
 * else (no repository there any more, an object it never heard of) throws, so
 * the caller can tell "no" apart from "could not ask".
 */
export function createGitLandingEvidence(target: CanonicalGitTarget): WorkflowLandingVerifier {
  const trackingRef = `refs/remotes/${target.remote}/${target.branch}`;
  return {
    async mergedIntoMain({ commit, checkout }) {
      await git(checkout, ["fetch", "--quiet", target.remote,
        `+refs/heads/${target.branch}:${trackingRef}`]);
      return new Promise((resolve, reject) => {
        execFile("git", ["-C", checkout, "merge-base", "--is-ancestor", commit, trackingRef],
          { timeout: 10_000, windowsHide: true }, (error) => {
            if (!error) resolve(true);
            else if (error.code === 1) resolve(false);
            else reject(error);
          });
      });
    },
  };
}

export const gitLandingEvidence: WorkflowLandingVerifier = {
  mergedIntoMain(input) {
    return createGitLandingEvidence(canonicalTarget()).mergedIntoMain(input);
  },
};
