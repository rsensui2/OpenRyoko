/**
 * Re-login to a provider CLI (Claude Code, Codex) without a shell on the host.
 *
 * Everything in this directory is connector-agnostic. A connector starts a
 * flow, renders what the flow reports, and hands back what the operator typed;
 * it never sees the PTY. The PTY, the status command and the clock are
 * injected, so the flow is exercised in tests without running a login CLI.
 */

export type AuthProvider = "claude" | "codex";

/** The slice of node-pty's IPty a login flow uses. */
export interface AuthPty {
  write(data: string): void;
  kill(signal?: string): void;
  onData(handler: (data: string) => void): { dispose(): void } | void;
  onExit(handler: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } | void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type SpawnPty = (
  file: string,
  args: readonly string[],
  options: PtySpawnOptions,
) => AuthPty | Promise<AuthPty>;

export interface CommandResult {
  stdout: string;
  exitCode: number;
}

export type RunCommand = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd: string; timeoutMs: number },
) => Promise<CommandResult>;

/** Where and how a provider's CLI runs — the same as the engine that uses it. */
export interface ProviderCommand {
  file: string;
  env: Record<string, string>;
  cwd: string;
}

export type ResolveProviderCommand = (provider: AuthProvider) => ProviderCommand | Promise<ProviderCommand>;

export interface AuthClock {
  now(): number;
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AuthLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** What the operator has to act on. Sent again, in full, whenever it changes. */
export interface FlowPrompt {
  flowId: string;
  provider: AuthProvider;
  url?: string;
  deviceCode?: string;
  /** Whether this provider waits for the operator to send a code back. */
  acceptsInput: boolean;
}

export type FlowOutcome =
  | { status: "succeeded" }
  /** `exit`: the CLI gave up. `unverified`: it exited cleanly but the status
   *  command does not report a login. `stopped`: the gateway is shutting down. */
  | { status: "failed"; reason: "exit" | "unverified" | "stopped" }
  | { status: "expired" }
  | { status: "cancelled" };

export interface FlowListener {
  onPrompt(prompt: FlowPrompt): void | Promise<void>;
  /** No link or code has been recognized in the CLI's output so far. */
  onStalled?(): void | Promise<void>;
  /** The CLI exited cleanly; the result is being confirmed. */
  onVerifying?(): void | Promise<void>;
  /** Called exactly once, last. */
  onSettled(outcome: FlowOutcome): void | Promise<void>;
}

export type StartResult =
  | { ok: true; flowId: string }
  | { ok: false; reason: "busy" | "stopped" | "spawn-failed" };

export type InputResult =
  | { ok: true }
  | { ok: false; reason: "no-flow" | "invalid" | "unsupported" | "write-failed" };

/** Tells the operator a provider's login looks broken. Resolves true once delivered. */
export type AuthFailureNotifier = (provider: AuthProvider) => boolean | Promise<boolean>;

/** What a connector needs from the flow engine. */
export interface ProviderAuthPort {
  readonly flowTtlMs: number;
  start(provider: AuthProvider, listener: FlowListener): Promise<StartResult>;
  submitInput(provider: AuthProvider, flowId: string, raw: string): InputResult;
  cancel(provider: AuthProvider, flowId?: string): boolean;
  abort(provider: AuthProvider, flowId: string): boolean;
  activeFlow(provider: AuthProvider): { flowId: string; acceptsInput: boolean } | undefined;
  hasActiveFlow(): boolean;
  addNotifier(notifier: AuthFailureNotifier): () => void;
}
