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

/** `claude auth status --json` exits non-zero when logged out; an answer from
 *  a failed probe is not trusted either way. */
function claudeLoggedIn(result: CommandResult): boolean {
  if (result.exitCode !== 0) return false;
  try {
    return (JSON.parse(result.stdout) as { loggedIn?: unknown } | null)?.loggedIn === true;
  } catch {
    return false;
  }
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
