import { redactText } from "../shared/redact.js";
import type { AuthInputKind } from "./input.js";
import { terminalText } from "./terminal.js";
import type { AuthProvider, CommandResult } from "./types.js";

export interface ProviderSpec {
  label: string;
  loginArgs: readonly string[];
  statusArgs: readonly string[];
  /** Empty when the login is finished in the browser and the CLI reads nothing. */
  acceptedInput: readonly AuthInputKind[];
  showsDeviceCode: boolean;
  /** Hosts the sign-in page lives on (a subdomain counts). */
  signInHosts: readonly string[];
  /** Reads the status command's answer. Its output is never logged. */
  isAuthenticated(result: CommandResult): boolean;
  /**
   * One line of what the CLI says about the login it now holds, for the
   * operator to check. Set where a login can be completed by someone other
   * than the operator: a device code works for whoever sees it, and signs the
   * CLI in to *their* account. Absent where the code only ever travels from the
   * operator to the CLI.
   */
  describeLogin?(result: CommandResult): string | undefined;
}

const MAX_STATUS_LINE = 120;
const LOGGED_IN_LINE = /^logged in\b/i;
/** A long unbroken run of key-like characters is a credential until proven otherwise. */
const OPAQUE_RUN = /[A-Za-z0-9_.+/=-]{32,}/g;

/**
 * The status command's own "Logged in …" line, from either stream, and nothing
 * else it printed. An allowlist, because the alternative — showing the first
 * line, whatever it is — shows a warning when one comes first, and a token
 * when a CLI prints one on a line of its own. Within the line, anything shaped
 * like a key is masked, with or without a recognizable prefix.
 */
function loggedInLine(result: CommandResult): string | undefined {
  const line = terminalText(`${result.stdout}\n${result.stderr ?? ""}`)
    .split("\n")
    .map((text) => text.replace(/\s+/g, " ").trim())
    .find((text) => LOGGED_IN_LINE.test(text));
  return line ? redactText(line).replace(OPAQUE_RUN, "[REDACTED]").slice(0, MAX_STATUS_LINE) : undefined;
}

/** What the status JSON says, when it can be read at all. */
function statedLoggedIn(stdout: string): boolean | undefined {
  try {
    const stated = (JSON.parse(stdout) as { loggedIn?: unknown } | null)?.loggedIn;
    return typeof stated === "boolean" ? stated : undefined;
  } catch {
    return undefined;
  }
}

const SAYS_LOGGED_IN = /"loggedIn"\s*:\s*true/;
const SAYS_LOGGED_OUT = /"loggedIn"\s*:\s*false/;

/**
 * `claude auth status --json` exits `loggedIn ? 0 : 1`. Both halves of the
 * answer have to agree before a login is reported:
 *
 *   - A non-zero exit is never a login, whatever was printed.
 *   - A zero exit is not enough either. A CLI version that exits 0 while
 *     logged out would otherwise be shown as a successful login.
 *   - JSON that parses is taken at its word.
 *   - The JSON cannot be relied on to parse: the CLI draws it through
 *     Ink, which wraps at 80 columns when its output is piped, so a long value —
 *     an e-mail address, an organization name — is broken across lines. Output
 *     that does not parse counts only if it still literally says
 *     `"loggedIn": true`, and nowhere says false.
 *
 * Anything else is "could not be confirmed" — reported to the operator as
 * exactly that, neither as a login nor as a failed one.
 */
function claudeLoggedIn(result: CommandResult): boolean {
  if (result.exitCode !== 0) return false;
  const stated = statedLoggedIn(result.stdout);
  if (stated !== undefined) return stated;
  return SAYS_LOGGED_IN.test(result.stdout) && !SAYS_LOGGED_OUT.test(result.stdout);
}

export const PROVIDERS: Record<AuthProvider, ProviderSpec> = {
  claude: {
    label: "Claude",
    loginArgs: ["auth", "login", "--claudeai"],
    statusArgs: ["auth", "status", "--json"],
    // No short code: the CLI's prompt answers a line without '#' with
    // "Invalid code" and keeps waiting, so the login would hang until it timed out.
    acceptedInput: ["code-state", "callback-url"],
    showsDeviceCode: false,
    signInHosts: ["claude.ai", "claude.com", "anthropic.com"],
    isAuthenticated: claudeLoggedIn,
  },
  codex: {
    label: "Codex",
    loginArgs: ["login", "--device-auth"],
    statusArgs: ["login", "status"],
    acceptedInput: [],
    showsDeviceCode: true,
    signInHosts: ["openai.com", "chatgpt.com"],
    isAuthenticated: (result) => result.exitCode === 0,
    describeLogin: loggedInLine,
  },
};

export const AUTH_PROVIDERS = Object.keys(PROVIDERS) as AuthProvider[];

export function isAuthProvider(value: unknown): value is AuthProvider {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}
