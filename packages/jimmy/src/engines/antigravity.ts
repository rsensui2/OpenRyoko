import { spawn, type ChildProcess } from "node:child_process";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin, formatSpawnError } from "../shared/resolveBin.js";
import { buildChildEnv } from "../shared/childEnv.js";
import {
  ANTIGRAVITY_TURN_TIMEOUT_MS,
  antigravityUserLine,
  buildAntigravityArgs,
  parseAntigravityStreamLine,
  type AntigravityParsedLine,
} from "./antigravity-protocol.js";

/**
 * Antigravity CLI (`agy`) engine — one `agy --print` process per turn, prompt
 * in and events out as stream-JSON (see antigravity-protocol.ts).
 *
 * Auth is agy's own saved Google sign-in (`agy` once, interactively). The
 * conversation id from `init`/`result` is the engine session id; the next turn
 * resumes it with `--conversation`.
 */

const EXIT_CLOSE_GRACE_MS = 1500;
const FORCE_KILL_GRACE_MS = 2000;
/** agy may still be saving the conversation after it prints `result`. */
const AFTER_RESULT_EXIT_GRACE_MS = 5000;
const TIMEOUT_REASON = "Antigravity turn timed out";
const STDERR_MAX = 10 * 1024;

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

function signalProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // The group can outlive its leader when a task agy started inherits a pipe.
    if (proc.pid && process.platform !== "win32") process.kill(-proc.pid, signal);
    else if (proc.exitCode === null) proc.kill(signal);
  } catch {
    /* already exited */
  }
}

function terminateProcessTree(proc: ChildProcess): void {
  signalProcessTree(proc, "SIGTERM");
  const timer = setTimeout(() => signalProcessTree(proc, "SIGKILL"), FORCE_KILL_GRACE_MS);
  timer.unref?.();
}

export function buildAntigravityPrompt(opts: EngineRunOpts): string {
  // A resumed conversation already carries the system prompt.
  const withSystem = opts.systemPrompt && !opts.resumeSessionId
    ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`
    : opts.prompt;
  return opts.attachments?.length
    ? `${withSystem}\n\nAttached files:\n${opts.attachments.map((file) => `- ${file}`).join("\n")}`
    : withSystem;
}

export class AntigravityEngine implements InterruptibleEngine {
  name = "antigravity" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;
    live.terminationReason = reason;
    logger.info(`Killing Antigravity process for session ${sessionId}`);
    terminateProcessTree(live.proc);
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) {
      this.kill(sessionId, "Interrupted: gateway shutting down");
    }
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  run(opts: EngineRunOpts): Promise<EngineResult> {
    const requestedBin = opts.bin || "agy";
    const bin = resolveBin(requestedBin);
    const args = buildAntigravityArgs(opts);
    logger.info(`Antigravity engine starting: ${bin} --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"})`);

    const proc = spawn(bin, args, {
      cwd: opts.cwd,
      env: buildChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const sessionId = opts.sessionId || `antigravity-${Date.now()}`;
    const live: LiveProcess = { proc, terminationReason: null };
    this.liveProcesses.set(sessionId, live);

    const turn = new AntigravityTurn(proc, live, opts, () => {
      if (this.liveProcesses.get(sessionId) === live) this.liveProcesses.delete(sessionId);
    });
    return turn.run(buildAntigravityPrompt(opts), requestedBin);
  }
}

/** One agy process from spawn to its terminal `result` (or its exit). */
class AntigravityTurn {
  private settled = false;
  private lineBuffer = "";
  private stderr = "";
  private conversationId: string;
  private contextTokens: number | undefined;
  private streamedText = false;
  private timers: NodeJS.Timeout[] = [];
  private resolve: (result: EngineResult) => void = () => {};
  private reject: (error: Error) => void = () => {};

  constructor(
    private proc: ChildProcess,
    private live: LiveProcess,
    private opts: EngineRunOpts,
    private release: () => void,
  ) {
    this.conversationId = opts.resumeSessionId ?? "";
  }

  run(prompt: string, requestedBin: string): Promise<EngineResult> {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      const { proc } = this;
      // Decode as a stream so a multibyte character split across chunks survives.
      proc.stdout!.setEncoding("utf8");
      proc.stderr!.setEncoding("utf8");
      proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
      proc.stderr!.on("data", (chunk: string) => {
        this.stderr = (this.stderr + chunk).slice(-STDERR_MAX);
      });
      proc.stdin!.on("error", () => { /* close/error below carry the diagnostic */ });
      proc.on("close", (code: number | null) => this.finishWithoutResult(code));
      proc.on("exit", (code: number | null) => {
        if (!this.settled) this.later(EXIT_CLOSE_GRACE_MS, () => this.finishWithoutResult(code));
      });
      proc.on("error", (err: Error) => {
        if (this.settled) return;
        this.settled = true;
        this.cleanup();
        this.reject(new Error(formatSpawnError("Antigravity", requestedBin, err)));
      });
      this.later(ANTIGRAVITY_TURN_TIMEOUT_MS, () => {
        if (this.settled) return;
        this.live.terminationReason = TIMEOUT_REASON;
        terminateProcessTree(proc);
      });
      proc.stdin!.end(antigravityUserLine(prompt));
    });
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  private onStdout(chunk: string): void {
    if (this.settled) return;
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    if (this.settled) return;
    const parsed = parseAntigravityStreamLine(line);
    if (!parsed) return;
    if (parsed.conversationId) this.conversationId = parsed.conversationId;
    if (parsed.contextTokens) this.contextTokens = parsed.contextTokens;
    for (const delta of parsed.deltas) {
      if (delta.type === "text") this.streamedText = true;
      this.opts.onStream?.(delta);
    }
    if (parsed.terminal) this.finishWithResult(parsed);
  }

  private finishWithResult(parsed: AntigravityParsedLine): void {
    // The turn is over. agy may still be saving the conversation the next turn
    // resumes, so it gets a moment to exit before anything it left is stopped.
    const proc = this.proc;
    setTimeout(() => { if (proc.exitCode === null) terminateProcessTree(proc); }, AFTER_RESULT_EXIT_GRACE_MS).unref?.();
    const reason = this.live.terminationReason;
    if (reason && reason !== TIMEOUT_REASON) {
      // A stop the gateway asked for, even if agy managed to print a result.
      this.settle({ sessionId: this.conversationId, result: "", error: reason, interruptRequested: true });
      return;
    }
    // An older agy that does not stream text_delta still shows its answer.
    if (parsed.result && !this.streamedText) this.opts.onStream?.({ type: "text", content: parsed.result });
    this.settle({
      sessionId: this.conversationId,
      result: parsed.result ?? "",
      ...(parsed.error ? { error: parsed.error } : { numTurns: 1 }),
    });
  }

  private finishWithoutResult(code: number | null): void {
    if (this.settled) return;
    this.handleLine(this.lineBuffer);
    if (this.settled) return;
    const reason = this.live.terminationReason;
    if (!reason) terminateProcessTree(this.proc);
    const detail = this.stderr.trim().slice(0, 500);
    this.settle({
      sessionId: this.conversationId,
      result: "",
      error: reason ?? `Antigravity exited with code ${code}${detail ? `: ${detail}` : " without a result"}`,
      // Only kill() sets a reason: the gateway asked for this stop.
      ...(reason && reason !== TIMEOUT_REASON ? { interruptRequested: true as const } : {}),
    });
  }

  private settle(result: EngineResult): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.resolve({ ...result, ...(this.contextTokens ? { contextTokens: this.contextTokens } : {}) });
  }

  private cleanup(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.proc.stdout?.removeAllListeners("data");
    this.proc.stderr?.removeAllListeners("data");
    this.release();
  }
}
