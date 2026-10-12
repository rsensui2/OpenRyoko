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

/** The first line a status command printed — on either stream — made safe to
 *  show: no terminal control, nothing that looks like a key, bounded length. */
function statusLine(result: CommandResult): string | undefined {
  const line = terminalText(`${result.stdout}\n${result.stderr ?? ""}`)
    .split("\n")
    .map((text) => text.replace(/\s+/g, " ").trim())
    .find(Boolean);
  return line ? redactText(line).slice(0, MAX_STATUS_LINE) : undefined;
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
    describeLogin: statusLine,
  },
};

export const AUTH_PROVIDERS = Object.keys(PROVIDERS) as AuthProvider[];

export function isAuthProvider(value: unknown): value is AuthProvider {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}
