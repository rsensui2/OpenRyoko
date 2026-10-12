/**
 * The only three things an operator may hand to a login CLI:
 *   - a short device code (`ABCD-EFGH`),
 *   - Claude's browser value `code#state`,
 *   - the loopback `/callback` URL a browser was redirected to, from which the
 *     same `code#state` is rebuilt.
 *
 * Anything else — a provider token, a shell fragment, a control character —
 * is refused here and never reaches the PTY. The state is kept with the code:
 * the CLI rejects a code that arrives without it.
 */

export type AuthInputKind = "short-code" | "code-state" | "callback-url";

export interface ParsedAuthInput {
  kind: AuthInputKind;
  /** Exactly what is written to the login CLI. */
  value: string;
}

const MAX_INPUT_LENGTH = 2048;
const SHORT_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4,5}$/;
const OAUTH_CODE = /^[A-Za-z0-9_-]{20,512}$/;
const OAUTH_STATE = /^[A-Za-z0-9_-]{8,512}$/;
const CODE_STATE = /^[A-Za-z0-9_-]{20,512}#[A-Za-z0-9_-]{8,512}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MAX_TOKENS_SCANNED = 50;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseLoopbackCallback(value: string): string | null {
  const url = parseUrl(value);
  if (!url || url.protocol !== "http:" || url.pathname !== "/callback") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) return null;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !OAUTH_CODE.test(code) || !OAUTH_STATE.test(state)) return null;
  return `${code}#${state}`;
}

export function parseAuthInput(raw: string): ParsedAuthInput | null {
  const value = raw.trim();
  if (!value || value.length > MAX_INPUT_LENGTH) return null;
  if (SHORT_CODE.test(value)) return { kind: "short-code", value };
  if (CODE_STATE.test(value)) return { kind: "code-state", value };
  const callback = parseLoopbackCallback(value);
  return callback ? { kind: "callback-url", value: callback } : null;
}

function isOAuthArtifact(token: string): boolean {
  if (CODE_STATE.test(token)) return true;
  const url = parseUrl(token);
  return !!url && url.pathname === "/callback" && url.searchParams.has("code");
}

/**
 * Whether a chat message carries an OAuth artifact — valid or not — that must
 * be kept out of logs and session history. A bare short code is not flagged:
 * outside a login it is indistinguishable from an order number.
 */
export function looksLikeAuthSecret(raw: string): boolean {
  return raw.trim().split(/\s+/).slice(0, MAX_TOKENS_SCANNED).some(isOAuthArtifact);
}
