import { vi } from "vitest";
import { ProviderAuthService } from "../service.js";
import type {
  AuthClock, AuthLogger, AuthProvider, AuthPty, CommandResult, FlowListener, FlowOutcome, FlowPrompt,
  ProviderCommand, PtySpawnOptions, RunCommand, SpawnPty,
} from "../types.js";

/** Realistic CLI output. The login CLIs are never run in tests — see the brief. */
export const CLAUDE_URL =
  "https://claude.ai/oauth/authorize?code=true&client_id=client123&response_type=code"
  + "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
  + "&scope=user%3Aprofile+user%3Ainference&code_challenge=challenge123&code_challenge_method=S256&state=state123";
export const CLAUDE_LOGIN_OUTPUT =
  `Opening browser to sign in…\r\nIf the browser didn't open, visit: ${CLAUDE_URL}\r\n\r\nPaste code here if prompted > `;
export const OAUTH_CODE = "Ab".repeat(24);
export const OAUTH_STATE = "state_1234567890123456";
export const CODEX_URL = "https://auth.openai.com/codex/device";
export const CODEX_DEVICE_CODE = "FHI3-TCJKF";
export const CODEX_LOGIN_OUTPUT =
  "\r\nFollow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n"
  + "1. Open this link in your browser and sign in to your account\r\n"
  + `   \u001b[94m${CODEX_URL}\u001b[0m\r\n\r\n`
  + "2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\r\n"
  + `   \u001b[94m${CODEX_DEVICE_CODE}\u001b[0m\r\n\r\n`
  + "\u001b[90mDevice codes are a common phishing target. Never share this code.\u001b[0m\r\n\r\n";

export interface FakePty extends AuthPty {
  write: ReturnType<typeof vi.fn<(data: string) => void>>;
  kill: ReturnType<typeof vi.fn<(signal?: string) => void>>;
  file: string;
  args: readonly string[];
  options: PtySpawnOptions;
  emitData(data: string): void;
  emitExit(exitCode: number): void;
}

export function makePty(file: string, args: readonly string[], options: PtySpawnOptions): FakePty {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  return {
    file, args, options,
    write: vi.fn<(data: string) => void>(),
    kill: vi.fn<(signal?: string) => void>(),
    onData: (handler) => { onData = handler; return { dispose: () => { onData = undefined; } }; },
    onExit: (handler) => { onExit = handler; return { dispose: () => { onExit = undefined; } }; },
    emitData: (data) => onData?.(data),
    emitExit: (exitCode) => onExit?.({ exitCode }),
  };
}

export interface FakeClock extends AuthClock {
  advance(ms: number): void;
  delays(): number[];
}

export function makeClock(): FakeClock {
  let now = 1_000_000;
  let sequence = 0;
  const timers = new Map<number, { at: number; handler: () => void }>();
  return {
    now: () => now,
    setTimeout: (handler, delayMs) => { sequence += 1; timers.set(sequence, { at: now + delayMs, handler }); return sequence; },
    clearTimeout: (handle) => { timers.delete(handle as number); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].handler();
      }
      now = target;
    },
    delays: () => [...timers.values()].map((timer) => timer.at - now),
  };
}

export const COMMANDS: Record<AuthProvider, ProviderCommand> = {
  claude: { file: "/opt/bin/claude", env: { HOME: "/home/ryoko", ENGINE: "claude" }, cwd: "/home/ryoko/.ryoko" },
  codex: { file: "/opt/bin/codex", env: { HOME: "/home/ryoko", ENGINE: "codex" }, cwd: "/home/ryoko/.ryoko" },
};

export function makeListener() {
  const prompts: FlowPrompt[] = [];
  const outcomes: FlowOutcome[] = [];
  const events: string[] = [];
  const listener: FlowListener = {
    onPrompt: (prompt) => { prompts.push(prompt); events.push("prompt"); },
    onStalled: () => { events.push("stalled"); },
    onVerifying: () => { events.push("verifying"); },
    onSettled: (outcome) => { outcomes.push(outcome); events.push(`settled:${outcome.status}`); },
  };
  return { listener, prompts, outcomes, events };
}

export function makeHarness(options: { status?: Partial<Record<AuthProvider, CommandResult | Error>> } = {}) {
  const ptys: FakePty[] = [];
  const clock = makeClock();
  const logged: string[] = [];
  const record = (message: string) => { logged.push(message); };
  const logger: AuthLogger = { info: vi.fn(record), warn: vi.fn(record), error: vi.fn(record) };
  const spawnPty = vi.fn<SpawnPty>((file, args, spawnOptions) => {
    const pty = makePty(file, args, spawnOptions);
    ptys.push(pty);
    return pty;
  });
  const status: Record<AuthProvider, CommandResult | Error> = {
    claude: { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "operator@example.com" }), exitCode: 0 },
    codex: { stdout: "Logged in using ChatGPT\n", exitCode: 0 },
    ...options.status,
  };
  const runCommand = vi.fn<RunCommand>(async (file) => {
    const answer = file === COMMANDS.claude.file ? status.claude : status.codex;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const resolveCommand = vi.fn((provider: AuthProvider) => COMMANDS[provider]);
  const service = new ProviderAuthService({ resolveCommand, spawnPty, runCommand, clock, logger });
  return { service, ptys, clock, logger, logged, spawnPty, runCommand, resolveCommand, status };
}

/** Let promise continuations (verification, listener callbacks) run. */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
