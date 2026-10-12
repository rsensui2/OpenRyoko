import type { AuthProvider } from "./types.js";

/**
 * Did a turn fail because the provider CLI is no longer logged in?
 *
 * Kept deliberately narrower than the shared `auth-terminal` failure class.
 * That class answers "is a retry pointless?" and reads any mention of a
 * credential, OAuth or a 401/403 as yes — correct for a retry decision, but an
 * MCP server's own 401, or a turn that merely discussed OAuth, would then tell
 * the operator to log in again.
 *
 * Two rules keep a false notice out:
 *   - Only the words the provider CLIs themselves use for a lost login count,
 *     each matched against its own engine.
 *   - Every signature is anchored to the START of the text. Failure prose
 *     quotes things a chat user chooses — `/model <name>` becomes the next
 *     turn's model, and "the model 'token_expired' is not supported" would
 *     otherwise summon a notice to the operator on demand. What a user chooses
 *     appears inside the sentence; the CLI's own opening words do not.
 *
 * This module is imported by the engine run path, so it stays dependency-free.
 */

/** What the engines put in front of a CLI's stderr when it exits non-zero. */
const ENGINE_WRAPPER = /^(?:claude|codex) exited with code \d+: (?:error: )?/i;

const SIGNATURES: Record<AuthProvider, readonly RegExp[]> = {
  claude: [
    // The interactive engine surfaces the Stop hook's error enum verbatim, and nothing else.
    /^interactive turn failed: authentication_failed$/i,
    // `claude -p`, Claude Code 2.1.x. Every lost-login failure opens this way:
    // "Failed to authenticate: OAuth session expired and could not be refreshed",
    // "Failed to authenticate: OAuth token revoked. …", "Failed to authenticate. API Error: 401 …".
    /^failed to authenticate\b/i,
    // Older Claude Code versions, kept for instances whose CLI has not been updated.
    /^api error: 401\b/i,
    /^invalid api key\b/i,
    /^not logged in\b/i,
    /^oauth token (?:has expired|has been revoked|revoked)\b/i,
  ],
  codex: [
    // "unexpected status 401 Unauthorized: …" is the CLI's own request failing.
    // A bare "401 Unauthorized" is not: an MCP server's 401 reads the same.
    /^unexpected status 401\b/i,
    /^your access token could not be refreshed\b/i,
    /^not logged in\b/i,
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
  const ownWords = attempt.error.trim().replace(ENGINE_WRAPPER, "");
  return SIGNATURES[attempt.engine].some((signature) => signature.test(ownWords)) ? attempt.engine : null;
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
