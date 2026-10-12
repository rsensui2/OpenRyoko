import { randomUUID } from "node:crypto";
import { extractDiscovery, isKnownHost } from "./discovery.js";
import { AuthFailureNotices } from "./failure-notices.js";
import { parseAuthInput } from "./input.js";
import { PROVIDERS } from "./providers.js";
import { appendTail } from "./terminal.js";
import type {
  AuthClock, AuthFailureNotifier, AuthLogger, AuthProvider, AuthPty, FlowListener, FlowOutcome, FlowPrompt,
  InputResult, ProviderAuthPort, ProviderCommand, ResolveProviderCommand, RunCommand, SpawnPty, StartResult,
} from "./types.js";

/** A login nobody finishes is stopped after this long. */
export const FLOW_TTL_MS = 600_000;
/** After asking the CLI to stop, how long before it is killed outright. */
const KILL_GRACE_MS = 2_000;
/** Output that has been silent this long is complete: a link at its very end
 *  no longer needs the whitespace that would otherwise prove it whole. */
const QUIET_FLUSH_MS = 1_500;
/** No link or code recognized by now means the CLI's output is not being read. */
const STALL_NOTICE_MS = 30_000;
const STATUS_TIMEOUT_MS = 15_000;
/** Read this much per chunk, so a link at the head of a large one is seen… */
const SCAN_BYTES = 64 * 1024;
/** …but keep only this much between chunks. */
const KEEP_BYTES = 8 * 1024;
/** Wide enough that no renderer wraps a sign-in link across lines. */
const PTY_COLS = 2000;
const PTY_ROWS = 50;
const TAG = "[provider-auth]";

type TimerName = "ttl" | "quiet" | "stall" | "kill";

interface Flow {
  readonly id: string;
  readonly provider: AuthProvider;
  readonly command: ProviderCommand;
  readonly pty: AuthPty;
  readonly listener: FlowListener;
  readonly timers: Partial<Record<TimerName, unknown>>;
  phase: "awaiting" | "verifying";
  /** Raw output still to be read. Never logged, never handed out. */
  tail: string;
  bytes: number;
  url?: string;
  deviceCode?: string;
  exited: boolean;
  settled: boolean;
  dataSubscription?: { dispose(): void } | void;
}

export interface ProviderAuthDeps {
  resolveCommand: ResolveProviderCommand;
  spawnPty: SpawnPty;
  runCommand: RunCommand;
  clock: AuthClock;
  logger: AuthLogger;
}

/** An errno-style code is safe to log; an error message may quote anything. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : "unknown";
}

function describeOutcome(outcome: FlowOutcome): string {
  return outcome.status === "failed" ? `failed (${outcome.reason})` : outcome.status;
}

/**
 * Runs provider logins: one flow per provider at a time, each a login CLI in a
 * PTY that is always stopped — by finishing, by the operator, by the TTL, or
 * by gateway shutdown.
 *
 * Nothing the CLI prints and nothing the operator sends is logged. Log lines
 * here are built from fixed text, the provider's name and numbers only.
 */
export class ProviderAuthService implements ProviderAuthPort {
  readonly flowTtlMs = FLOW_TTL_MS;
  private readonly flows = new Map<AuthProvider, Flow>();
  private readonly starting = new Set<AuthProvider>();
  private readonly notices: AuthFailureNotices;
  private stopped = false;

  constructor(private readonly deps: ProviderAuthDeps) {
    this.notices = new AuthFailureNotices({
      clock: deps.clock,
      logger: deps.logger,
      isLoginInProgress: (provider) => this.flows.has(provider) || this.starting.has(provider),
    });
  }

  async start(provider: AuthProvider, listener: FlowListener): Promise<StartResult> {
    if (this.stopped) return { ok: false, reason: "stopped" };
    if (this.flows.has(provider) || this.starting.has(provider)) return { ok: false, reason: "busy" };
    this.starting.add(provider);
    try {
      const flow = await this.spawn(provider, listener);
      return flow ? { ok: true, flowId: flow.id } : { ok: false, reason: "stopped" };
    } catch (error) {
      this.deps.logger.error(`${TAG} ${PROVIDERS[provider].label} login could not start (${errorCode(error)})`);
      return { ok: false, reason: "spawn-failed" };
    } finally {
      this.starting.delete(provider);
    }
  }

  submitInput(provider: AuthProvider, flowId: string, raw: string): InputResult {
    const flow = this.flows.get(provider);
    if (!flow || flow.id !== flowId || flow.settled || flow.phase !== "awaiting") return { ok: false, reason: "no-flow" };
    const spec = PROVIDERS[provider];
    if (spec.acceptedInput.length === 0) return this.refuse(provider, "unsupported");
    const input = parseAuthInput(raw);
    if (!input) return this.refuse(provider, "invalid");
    if (!spec.acceptedInput.includes(input.kind)) return this.refuse(provider, "unsupported");
    try {
      flow.pty.write(`${input.value}\r`);
    } catch {
      return this.refuse(provider, "write-failed");
    }
    this.deps.logger.info(`${TAG} ${spec.label} login: input sent to the CLI (${input.kind})`);
    return { ok: true };
  }

  private refuse(provider: AuthProvider, reason: "invalid" | "unsupported" | "write-failed"): InputResult {
    this.deps.logger.warn(`${TAG} ${PROVIDERS[provider].label} login: input not sent to the CLI (${reason})`);
    return { ok: false, reason };
  }

  cancel(provider: AuthProvider, flowId?: string): boolean {
    const flow = this.flows.get(provider);
    if (!flow || (flowId !== undefined && flow.id !== flowId)) return false;
    this.terminate(flow, false);
    this.settle(flow, { status: "cancelled" });
    return true;
  }

  /** The connector showing this flow is going away: stop it now, as at shutdown. */
  abort(provider: AuthProvider, flowId: string): boolean {
    const flow = this.flows.get(provider);
    if (!flow || flow.id !== flowId) return false;
    this.terminate(flow, true);
    this.settle(flow, { status: "failed", reason: "stopped" });
    return true;
  }

  activeFlow(provider: AuthProvider): { flowId: string; acceptsInput: boolean } | undefined {
    const flow = this.flows.get(provider);
    if (!flow) return undefined;
    return { flowId: flow.id, acceptsInput: flow.phase === "awaiting" && PROVIDERS[provider].acceptedInput.length > 0 };
  }

  hasActiveFlow(): boolean {
    return this.flows.size > 0;
  }

  addNotifier(notifier: AuthFailureNotifier): () => void {
    return this.notices.add(notifier);
  }

  /** A turn on this provider failed because its login is gone. */
  reportAuthFailure(provider: AuthProvider): void {
    this.notices.report(provider);
  }

  /** Gateway shutdown: no CLI outlives it, and nothing starts afterwards. */
  stop(): void {
    this.stopped = true;
    for (const flow of [...this.flows.values()]) {
      this.terminate(flow, true);
      this.settle(flow, { status: "failed", reason: "stopped" });
    }
  }

  private async spawn(provider: AuthProvider, listener: FlowListener): Promise<Flow | null> {
    const command = await this.deps.resolveCommand(provider);
    if (this.stopped) return null;
    const pty = await this.deps.spawnPty(command.file, PROVIDERS[provider].loginArgs, {
      name: "xterm-256color", cols: PTY_COLS, rows: PTY_ROWS, cwd: command.cwd, env: command.env,
    });
    const flow: Flow = {
      id: randomUUID(), provider, command, pty, listener, timers: {},
      phase: "awaiting", tail: "", bytes: 0, exited: false, settled: false,
    };
    if (this.stopped) {
      this.terminate(flow, true);
      return null;
    }
    this.flows.set(provider, flow);
    this.attach(flow);
    this.deps.logger.info(`${TAG} ${PROVIDERS[provider].label} login started`);
    return flow;
  }

  private attach(flow: Flow): void {
    flow.dataSubscription = flow.pty.onData((chunk) => this.onData(flow, chunk));
    flow.pty.onExit((event) => { void this.onExit(flow, event.exitCode); });
    this.arm(flow, "ttl", FLOW_TTL_MS, () => this.expire(flow));
    this.arm(flow, "stall", STALL_NOTICE_MS, () => this.noteStall(flow));
  }

  private onData(flow: Flow, chunk: string): void {
    if (flow.settled || flow.phase !== "awaiting") return;
    flow.bytes += Buffer.byteLength(chunk);
    flow.tail = appendTail(flow.tail, chunk, SCAN_BYTES);
    this.discover(flow, false);
    flow.tail = appendTail(flow.tail, "", KEEP_BYTES);
    this.arm(flow, "quiet", QUIET_FLUSH_MS, () => this.discover(flow, true));
  }

  private discover(flow: Flow, final: boolean): void {
    if (flow.settled || flow.phase !== "awaiting") return;
    const spec = PROVIDERS[flow.provider];
    const found = extractDiscovery(flow.tail, { final, preferredHosts: spec.signInHosts, deviceCode: spec.showsDeviceCode });
    // A sign-in link on the provider's own host is never traded for another link.
    const keepUrl = !found.url || (isKnownHost(flow.url, spec.signInHosts) && !isKnownHost(found.url, spec.signInHosts));
    const url = keepUrl ? flow.url : found.url;
    const deviceCode = found.deviceCode ?? flow.deviceCode;
    if (url === flow.url && deviceCode === flow.deviceCode) return;
    flow.url = url;
    flow.deviceCode = deviceCode;
    this.disarm(flow, "stall");
    this.deps.logger.info(`${TAG} ${spec.label} login: sign-in ${deviceCode ? "link and device code" : "link"} ready`);
    this.call(() => flow.listener.onPrompt(this.promptOf(flow)));
  }

  private promptOf(flow: Flow): FlowPrompt {
    return {
      flowId: flow.id,
      provider: flow.provider,
      ...(flow.url ? { url: flow.url } : {}),
      ...(flow.deviceCode ? { deviceCode: flow.deviceCode } : {}),
      acceptsInput: PROVIDERS[flow.provider].acceptedInput.length > 0,
    };
  }

  private noteStall(flow: Flow): void {
    if (flow.settled || flow.phase !== "awaiting" || flow.url || flow.deviceCode) return;
    this.deps.logger.warn(
      `${TAG} ${PROVIDERS[flow.provider].label} login: no sign-in link recognized after ${STALL_NOTICE_MS / 1000}s (${flow.bytes} bytes of output)`,
    );
    this.call(() => flow.listener.onStalled?.());
  }

  private async onExit(flow: Flow, exitCode: number): Promise<void> {
    if (flow.exited) return;
    flow.exited = true;
    this.disarm(flow, "kill");
    if (flow.settled) return;
    for (const name of ["ttl", "quiet", "stall"] as const) this.disarm(flow, name);
    this.deps.logger.info(`${TAG} ${PROVIDERS[flow.provider].label} login: CLI exited with code ${Number(exitCode)}`);
    if (exitCode !== 0) {
      this.settle(flow, { status: "failed", reason: "exit" });
      return;
    }
    flow.phase = "verifying";
    this.call(() => flow.listener.onVerifying?.());
    const verified = await this.verify(flow);
    this.settle(flow, verified ? { status: "succeeded" } : { status: "failed", reason: "unverified" });
  }

  /** A clean exit is not proof: the CLI's own status command has the last word. */
  private async verify(flow: Flow): Promise<boolean> {
    const spec = PROVIDERS[flow.provider];
    try {
      const result = await this.deps.runCommand(flow.command.file, spec.statusArgs, {
        env: flow.command.env, cwd: flow.command.cwd, timeoutMs: STATUS_TIMEOUT_MS,
      });
      return spec.isAuthenticated(result);
    } catch {
      return false;
    }
  }

  private expire(flow: Flow): void {
    if (flow.settled) return;
    this.terminate(flow, false);
    this.settle(flow, { status: "expired" });
  }

  private terminate(flow: Flow, force: boolean): void {
    if (flow.exited) return;
    this.signal(flow);
    if (force) {
      this.signal(flow, "SIGKILL");
      return;
    }
    this.arm(flow, "kill", KILL_GRACE_MS, () => { if (!flow.exited) this.signal(flow, "SIGKILL"); });
  }

  private signal(flow: Flow, signal?: string): void {
    try {
      if (signal) flow.pty.kill(signal);
      else flow.pty.kill();
    } catch { /* already gone */ }
  }

  private settle(flow: Flow, outcome: FlowOutcome): void {
    if (flow.settled) return;
    flow.settled = true;
    for (const name of ["ttl", "quiet", "stall"] as const) this.disarm(flow, name);
    try { flow.dataSubscription?.dispose(); } catch { /* best effort */ }
    flow.tail = "";
    if (this.flows.get(flow.provider) === flow) this.flows.delete(flow.provider);
    this.deps.logger.info(`${TAG} ${PROVIDERS[flow.provider].label} login ${describeOutcome(outcome)}`);
    this.call(() => flow.listener.onSettled(outcome));
  }

  private arm(flow: Flow, name: TimerName, delayMs: number, handler: () => void): void {
    this.disarm(flow, name);
    flow.timers[name] = this.deps.clock.setTimeout(() => {
      flow.timers[name] = undefined;
      handler();
    }, delayMs);
  }

  private disarm(flow: Flow, name: TimerName): void {
    if (flow.timers[name] === undefined) return;
    this.deps.clock.clearTimeout(flow.timers[name]);
    flow.timers[name] = undefined;
  }

  /** A connector that fails to render must not stall or break the flow. */
  private call(invoke: () => void | Promise<void>): void {
    const failed = () => this.deps.logger.warn(`${TAG} a login update could not be shown`);
    try {
      void Promise.resolve(invoke()).catch(failed);
    } catch {
      failed();
    }
  }
}
