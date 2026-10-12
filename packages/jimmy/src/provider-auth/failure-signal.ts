import type { AuthProvider } from "./types.js";

/**
 * Did a turn fail because the provider CLI is no longer logged in?
 *
 * Kept deliberately narrower than the shared `auth-terminal` failure class.
 * That class answers "is a retry pointless?" and reads any mention of a
 * credential, OAuth or a 401/403 as yes — correct for a retry decision, but an
 * MCP server's own 401, or a turn that merely discussed OAuth, would then tell
 * the operator to log in again. Only prose the provider CLIs themselves use
 * for a lost login counts here, each matched against its own engine.
 *
 * This module is imported by the engine run path, so it stays dependency-free.
 */
const SIGNATURES: Record<AuthProvider, readonly RegExp[]> = {
  claude: [
    // The interactive engine surfaces the Stop hook's error enum verbatim.
    /\binteractive turn failed:\s*authentication_failed\b/i,
    /\bauthentication_error\b/i,
    /\boauth token (?:has )?(?:expired|been revoked)\b/i,
    /\bplease run \/login\b/i,
  ],
  codex: [
    /\b401 unauthorized\b/i,
    /\btoken_expired\b/i,
    /\bcould not be refreshed\b/i,
    /\bsign(?:ing)? in again\b/i,
    /\bcodex login\b/i,
  ],
};

export interface EngineAttempt {
  engine: string;
  error?: string | null;
  /** The turn ran over SSH: that host's login is not ours to renew. */
  remote?: boolean;
}

export function detectProviderAuthFailure(attempt: EngineAttempt): AuthProvider | null {
  if (attempt.remote || !attempt.error) return null;
  if (attempt.engine !== "claude" && attempt.engine !== "codex") return null;
  if (/^Interrupted\b/.test(attempt.error)) return null;
  const error = attempt.error;
  return SIGNATURES[attempt.engine].some((signature) => signature.test(error)) ? attempt.engine : null;
}

type FailureListener = (provider: AuthProvider) => void;

const listeners = new Set<FailureListener>();

export function onProviderAuthFailure(listener: FailureListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Called for every settled engine attempt. With nobody subscribed (the
 * default: no connector has opted in) this returns before looking at anything.
 * It never throws — an observer must not be able to fail a turn.
 */
export function reportEngineAttempt(
  engine: string,
  opts: { sshHost?: string } | undefined,
  result: { error?: string } | undefined,
): void {
  if (listeners.size === 0) return;
  try {
    const provider = detectProviderAuthFailure({ engine, error: result?.error, remote: Boolean(opts?.sshHost) });
    if (!provider) return;
    for (const listener of [...listeners]) {
      try { listener(provider); } catch { /* one observer must not silence the rest */ }
    }
  } catch { /* never into the engine path */ }
}
