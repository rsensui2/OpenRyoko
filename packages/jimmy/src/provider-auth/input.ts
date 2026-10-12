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

/**
 * Outside a login, a chat message is taken for a pasted code only when the
 * whole message IS one. A request that merely mentions a callback URL or a
 * `page#anchor` ("this /callback?code=… returns 500, look into it") is an
 * ordinary request and must reach the session. A bare short code is not taken
 * either: with no login running it is an order number, and nobody's secret.
 */
export function isOAuthInput(raw: string): boolean {
  const parsed = parseAuthInput(raw);
  return parsed !== null && parsed.kind !== "short-code";
}

/** Slack caps a message at 40 000 characters; nothing longer needs reading. */
const MAX_SCANNED_LENGTH = 40_000;
const CODE_STATE_ANYWHERE = /[A-Za-z0-9_-]{20,512}#[A-Za-z0-9_-]{8,512}/;
const CALLBACK_ANYWHERE = /\/callback\?\S*?\bcode=/i;
const SHORT_CODE_ANYWHERE = /(?<![A-Za-z0-9-])[A-Z0-9]{4}-[A-Z0-9]{4,5}(?![A-Za-z0-9-])/;

/**
 * While a login is running, a code anywhere in a message counts — wrapped in
 * backticks or asterisks, or in the middle of a sentence. For those few
 * minutes a false alarm costs the operator a rephrased message; a miss puts a
 * live code into the log and the session history.
 */
export function containsAuthCode(raw: string): boolean {
  const text = raw.slice(0, MAX_SCANNED_LENGTH);
  return CODE_STATE_ANYWHERE.test(text) || CALLBACK_ANYWHERE.test(text) || SHORT_CODE_ANYWHERE.test(text);
}
