import type { AuthInputKind } from "./input.js";
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
  /** Reads the status command's answer. Its output is never logged or shown:
   *  it names the account. */
  isAuthenticated(result: CommandResult): boolean;
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

/**
 * `claude auth status --json` exits `loggedIn ? 0 : 1`, and the exit status is
 * the answer of record. A non-zero exit is never a login, whatever was
 * printed. The JSON cannot be relied on for a yes: the CLI draws it through
 * Ink, which wraps at 80 columns when its output is piped, so a long value —
 * an e-mail address, an organization name — is broken across lines and the
 * output stops parsing. It is consulted only to hear an explicit no.
 */
function claudeLoggedIn(result: CommandResult): boolean {
  return result.exitCode === 0 && statedLoggedIn(result.stdout) !== false;
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
  },
};

export const AUTH_PROVIDERS = Object.keys(PROVIDERS) as AuthProvider[];

export function isAuthProvider(value: unknown): value is AuthProvider {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}
