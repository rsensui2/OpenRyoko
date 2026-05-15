import { spawn, type ChildProcess } from "node:child_process";
import type { EngineRateLimitInfo, InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { isDeadSessionError } from "../shared/rateLimit.js";
import { resolveBin, formatSpawnError } from "../shared/resolveBin.js";
import { buildChildEnv } from "../shared/childEnv.js";

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

/** Errors that are likely transient and worth retrying */
const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /503/,
  /529/,
  /overloaded/i,
  /rate limit/i,
  /spawn.*EAGAIN/i,
];

function isTransientError(stderr: string, code: number | null): boolean {
  // Exit code 1 with no meaningful stderr is often a transient crash
  if (code === 1 && stderr.trim().length < 10) return true;
  return TRANSIENT_PATTERNS.some((pat) => pat.test(stderr));
}

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;

/** POSIX single-quote shell escape — safe for arbitrary content. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Quote anything that's not a bare flag/safe token. */
function quoteIfNeeded(s: string): string {
  if (/^--?[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s)) return s;
  return shellQuote(s);
}

/**
 * Strip args that don't make sense on the remote side:
 *  - --chrome (local browser bridge)
 *  - --mcp-config <path> (path is local-only)
 *  - --include-partial-messages (optional; harmless to keep, but dropped to
 *    minimize remote stream-json variance)
 */
function filterArgsForRemote(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--chrome" || a === "--include-partial-messages") continue;
    if (a === "--mcp-config") {
      i++; // skip the value too
      continue;
    }
    out.push(a);
  }
  return out;
}

export class ClaudeEngine implements InterruptibleEngine {
  name = "claude" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    live.terminationReason = reason;
    logger.info(`Killing Claude process for session ${sessionId}`);
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) {
        this.signalProcess(live.proc, "SIGKILL");
      }
    }, 2000);
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

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    let lastResult: EngineResult | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        logger.warn(
          `Claude engine retry ${attempt}/${MAX_RETRIES} for session ${opts.sessionId || "unknown"} after ${delayMs}ms`,
        );
        // Emit a status delta so the UI knows we're retrying
        opts.onStream?.({ type: "status", content: `Retrying (attempt ${attempt + 1}/${MAX_RETRIES + 1})...` });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const result = await this.runOnce(opts);
      lastResult = result;

      // Success or non-transient error — return immediately
      if (!result.error) return result;

      // If the process was intentionally killed, don't retry
      if (result.error.startsWith("Interrupted")) return result;

      // Dead session (expired/invalid --resume ID) — clear the stale ID so the
      // next attempt (if any) starts fresh instead of retrying the same dead session.
      if (isDeadSessionError(result)) {
        logger.warn(`Dead session detected for ${opts.sessionId || "unknown"}: ${result.error.slice(0, 200)}`);
        opts = { ...opts, resumeSessionId: undefined };
        // Don't retry — let the caller (manager) handle cleanup
        return result;
      }

      // Check if this is a transient failure worth retrying
      if (attempt < MAX_RETRIES && isTransientError(result.error, null)) {
        logger.warn(`Transient Claude failure (attempt ${attempt + 1}): ${result.error.slice(0, 200)}`);
        continue;
      }

      // Non-transient or final attempt — return the error
      return result;
    }

    return lastResult!;
  }

  private async runOnce(opts: EngineRunOpts): Promise<EngineResult> {
    // Always use stream-json so the engine can capture every assistant turn
    // in a multi-turn `/goal` session, not just the final one. The legacy
    // single-JSON path threw away intermediate turns. Delta callbacks fire
    // only when the caller provides `opts.onStream`.
    const streaming = true;
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--chrome", "--include-partial-messages"];
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.effortLevel && opts.effortLevel !== "default") args.push("--effort", opts.effortLevel);
    if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
    let prompt = opts.prompt;
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }
    // Prompt MUST come before --mcp-config because --mcp-config is variadic
    // and would consume the prompt as another config path
    args.push(prompt);

    if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
    if (opts.cliFlags?.length) args.push(...opts.cliFlags);

    const requestedBin = opts.bin || "claude";

    // SSH branch: run claude on a remote host. We rebuild the argv as a
    // single shell-escaped command line so the remote shell parses it
    // correctly. Local-only flags (--chrome, --mcp-config <path>) are
    // dropped because they would not work on the remote machine.
    let spawnBin: string;
    let spawnArgs: string[];
    let spawnCwd: string | undefined;
    let spawnEnv: NodeJS.ProcessEnv | undefined;

    if (opts.sshHost) {
      const remoteArgs = filterArgsForRemote(args);
      spawnBin = "ssh";
      spawnArgs = [
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ServerAliveInterval=30",
        opts.sshHost,
        ["claude", ...remoteArgs.map(quoteIfNeeded)].join(" "),
      ];
      spawnCwd = undefined;
      spawnEnv = process.env;
      logger.info(
        `Claude engine (one-shot) starting via SSH ${opts.sshHost}: claude -p --output-format ${streaming ? "stream-json" : "json"} --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"})`,
      );
    } else {
      spawnBin = resolveBin(requestedBin);
      spawnArgs = args;
      spawnCwd = opts.cwd;
      spawnEnv = buildChildEnv();
      logger.info(
        `Claude engine (one-shot) starting: ${spawnBin} -p --output-format ${streaming ? "stream-json" : "json"} --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"})`,
      );
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(spawnBin, spawnArgs, {
        cwd: spawnCwd,
        env: spawnEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      if (opts.sessionId) {
        this.liveProcesses.set(opts.sessionId, {
          proc,
          terminationReason: null,
        });
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      let lastResultMsg: Record<string, unknown> | null = null;
      let rateLimitInfo: EngineRateLimitInfo | undefined;
      let lineCount = 0;
      let inTool = false;
      // Per-turn text capture: each `assistant` event carries the full text
      // snapshot of one turn's message (keyed by message.id). For
      // multi-turn sessions (driven by /goal) this lets us surface every
      // intermediate turn to the caller, not just the final result.
      const turnTextById = new Map<string, string>();
      const turnOrder: string[] = [];

      const STDERR_MAX = 10 * 1024; // 10KB rolling window for error reporting

      if (streaming) {
        const onStream = opts.onStream;
        let lineBuf = "";

        proc.stdout.on("data", (d: Buffer) => {
          const chunk = d.toString();
          // Do not accumulate stdout in streaming mode — data is forwarded to
          // the client as it arrives. Only lineBuf is needed for line parsing.
          lineBuf += chunk;
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop() || "";
          for (const line of lines) {
            // Track per-turn text snapshots from raw `assistant` events
            // before they're transformed into deltas. Each turn emits one
            // (or more, with --include-partial-messages) `assistant` event
            // with the full text-so-far; the LAST snapshot per message.id
            // is the final text for that turn.
            this.captureTurnText(line, turnTextById, turnOrder);

            const parsed = this.processStreamLine(line, lineCount++, inTool);
            if (!parsed) continue;

            if (parsed.type === "__result") {
              lastResultMsg = parsed.msg;
              continue;
            }

            if (parsed.type === "__rate_limit") {
              rateLimitInfo = parsed.info;
              continue;
            }

            if (parsed.type === "__tool_start") {
              inTool = true;
              onStream?.(parsed.delta);
              continue;
            }

            if (parsed.type === "__tool_end") {
              inTool = false;
              onStream?.(parsed.delta);
              continue;
            }

            onStream?.(parsed.delta);
          }
        });
      } else {
        proc.stdout.on("data", (d: Buffer) => {
          stdout += d.toString();
        });
      }

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        // Keep only the last 10KB of stderr to bound memory usage
        if (stderr.length > STDERR_MAX) {
          stderr = stderr.slice(stderr.length - STDERR_MAX);
        }
        for (const line of chunk.trim().split("\n").filter(Boolean)) {
          logger.debug(`[claude stderr] ${line}`);
        }
      });

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;

        const terminationReason = opts.sessionId
          ? this.liveProcesses.get(opts.sessionId)?.terminationReason ?? null
          : null;
        if (opts.sessionId) {
          this.liveProcesses.delete(opts.sessionId);
        }

        logger.info(`Claude engine (one-shot) exited with code ${code}`);

        if (terminationReason) {
          resolve({
            sessionId: opts.resumeSessionId || "",
            result: "",
            error: terminationReason,
          });
          return;
        }

        const turns = turnOrder
          .map((id) => turnTextById.get(id) ?? "")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);

        if (code === 0) {
          if (streaming && lastResultMsg) {
            const extracted = this.buildEngineResultFromResultEvent(
              lastResultMsg,
              String(lastResultMsg.result || ""),
              opts.resumeSessionId,
              rateLimitInfo,
              turns,
            );
            if (extracted.error) opts.onStream?.({ type: "error", content: extracted.error });
            resolve(extracted);
            return;
          }

          try {
            const parsedResult = this.parseClaudeJsonOutput(stdout, opts.resumeSessionId);
            logger.info(`Claude result: session_id=${parsedResult.sessionId || "none"}, result_length=${parsedResult.result.length}, cost=$${parsedResult.cost || 0}`);
            resolve(parsedResult);
          } catch (err) {
            logger.error(`Failed to parse Claude output: ${err}\nstdout: ${stdout.slice(0, 500)}`);
            resolve({
              sessionId: opts.resumeSessionId || "",
              result: stdout || "(unparseable output)",
              error: `Failed to parse Claude output: ${err}`,
            });
          }
          return;
        }

        // Non-zero exit code — if we still got a structured "result" message, use it.
        if (streaming && lastResultMsg) {
          resolve(this.extractResult(lastResultMsg, opts.resumeSessionId, rateLimitInfo, turns));
          return;
        }

        if (!streaming && stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout);
            if (Array.isArray(parsed)) {
              const resultEvent = [...parsed].reverse().find((e: Record<string, unknown>) => e.type === "result") as Record<string, unknown> | undefined;
              const rlEvent = [...parsed].reverse().find((e: Record<string, unknown>) => e.type === "rate_limit_event") as Record<string, unknown> | undefined;
              const rl = rlEvent ? this.normalizeRateLimitInfo(rlEvent.rate_limit_info) : rateLimitInfo;
              if (resultEvent) {
                resolve(this.extractResult(resultEvent, opts.resumeSessionId, rl));
                return;
              }
            } else if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).type === "result") {
              resolve(this.extractResult(parsed as Record<string, unknown>, opts.resumeSessionId, rateLimitInfo));
              return;
            }
          } catch {
            // ignore parse errors, fall through to generic stderr/code error
          }
        }

        // Non-zero exit code — log full stderr for debugging
        if (stderr.trim()) {
          logger.error(`Claude stderr (exit code ${code}):\n${stderr}`);
        }

        // Prefer structured output when available (stream-json)
        if (streaming && lastResultMsg) {
          const extracted = this.buildEngineResultFromResultEvent(
            lastResultMsg,
            String(lastResultMsg.result || ""),
            opts.resumeSessionId,
            rateLimitInfo,
            turns,
          );
          if (extracted.error) opts.onStream?.({ type: "error", content: extracted.error });
          resolve(extracted);
          return;
        }

        // If stdout contains JSON output, try to parse it even on non-zero exit.
        if (!streaming && stdout.trim()) {
          try {
            const parsedResult = this.parseClaudeJsonOutput(stdout, opts.resumeSessionId);
            if (parsedResult.error) opts.onStream?.({ type: "error", content: parsedResult.error });
            resolve(parsedResult);
            return;
          } catch {
            // Fall through to generic error below
          }
        }

        const errMsg = `Claude exited with code ${code}${stderr.trim() ? `: ${stderr.slice(0, 500)}` : " (no stderr output)"}`;
        logger.error(errMsg);

        // Emit error delta so WebSocket clients see the failure immediately
        opts.onStream?.({ type: "error", content: errMsg });

        resolve({
          sessionId: opts.resumeSessionId || "",
          result: "",
          error: errMsg,
        });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        if (opts.sessionId) {
          this.liveProcesses.delete(opts.sessionId);
        }
        const errMsg = formatSpawnError("Claude CLI", requestedBin, err);
        logger.error(errMsg);
        opts.onStream?.({ type: "error", content: errMsg });
        reject(new Error(errMsg));
      });
    });
  }

  /**
   * Inspect a raw stream-json line and, if it is an `assistant` event,
   * record the latest text snapshot for that turn (keyed by message.id).
   *
   * Stream-json with `--include-partial-messages` emits multiple snapshots
   * per turn as text accumulates; the LAST snapshot per id is the turn's
   * final text. For multi-turn `/goal` sessions each turn produces its own
   * message.id, so iterating `turnTextById` in insertion order yields the
   * chronological turn outputs.
   */
  private captureTurnText(
    line: string,
    turnTextById: Map<string, string>,
    turnOrder: string[],
  ): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.type !== "assistant") return;
    const message = msg.message as Record<string, unknown> | undefined;
    if (!message) return;
    const id = typeof message.id === "string" ? message.id : null;
    if (!id) return;
    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(content)) return;
    const text = content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    if (!text) return;
    if (!turnTextById.has(id)) turnOrder.push(id);
    turnTextById.set(id, text);
  }

  private processStreamLine(
    line: string,
    lineCount: number,
    inTool: boolean,
  ):
    | { type: "__result"; msg: Record<string, unknown> }
    | { type: "__rate_limit"; info: EngineRateLimitInfo }
    | { type: "__tool_start"; delta: StreamDelta }
    | { type: "__tool_end"; delta: StreamDelta }
    | { type: "delta"; delta: StreamDelta }
    | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    if (lineCount <= 5) {
      logger.debug(`[claude stream] line ${lineCount}: ${trimmed.slice(0, 300)}`);
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.debug(`[claude stream] unparseable line: ${trimmed.slice(0, 100)}`);
      return null;
    }

    const msgType = String(msg.type || "");
    if (msgType === "result") {
      return { type: "__result", msg };
    }

    if (msgType === "rate_limit_event") {
      const info = this.parseRateLimitInfo(msg.rate_limit_info);
      if (!info) return null;
      return { type: "__rate_limit", info };
    }

    // Partial assistant messages contain the full accumulated text so far.
    // Use these as snapshots to correct any dropped text_delta events.
    if (msgType === "assistant") {
      const message = msg.message as Record<string, unknown> | undefined;
      if (message) {
        const content = message.content as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(content)) {
          const textParts = content
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string);
          if (textParts.length > 0) {
            return { type: "delta", delta: { type: "text_snapshot", content: textParts.join("") } };
          }
        }
      }
      return null;
    }

    if (msgType === "stream_event") {
      const event = msg.event as Record<string, unknown> | undefined;
      if (!event) return null;
      const eventType = String(event.type || "");

      if (eventType === "content_block_start") {
        const block = event.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          const toolName = String(block.name || "unknown");
          const toolId = String(block.id || "");
          return {
            type: "__tool_start",
            delta: { type: "tool_use", content: `Using ${toolName}`, toolName, toolId },
          };
        }
      } else if (eventType === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (!delta) return null;
        if (delta.type === "text_delta" && !inTool) {
          const text = String(delta.text || "");
          if (text) {
            return { type: "delta", delta: { type: "text", content: text } };
          }
        }
      } else if (eventType === "content_block_stop" && inTool) {
        return { type: "__tool_end", delta: { type: "tool_result", content: "" } };
      }
      return null;
    }

    return null;
  }

  private formatClaudeError(message: string, rateLimit?: EngineRateLimitInfo): string {
    const cleaned = message.trim() || "Claude error";
    if (rateLimit?.status === "rejected") {
      return `Claude usage limit reached: ${cleaned}`;
    }
    return cleaned;
  }

  private buildEngineResultFromResultEvent(
    resultEvent: Record<string, unknown>,
    finalText: string,
    fallbackSessionId?: string,
    rateLimit?: EngineRateLimitInfo,
    turns?: string[],
  ): EngineResult {
    const isError = resultEvent.is_error === true || rateLimit?.status === "rejected";
    return {
      sessionId: String(resultEvent.session_id || fallbackSessionId || ""),
      result: isError ? "" : finalText,
      error: isError ? this.formatClaudeError(finalText, rateLimit) : undefined,
      cost: typeof resultEvent.total_cost_usd === "number" ? (resultEvent.total_cost_usd as number) : undefined,
      durationMs: typeof resultEvent.duration_ms === "number" ? (resultEvent.duration_ms as number) : undefined,
      numTurns: typeof resultEvent.num_turns === "number" ? (resultEvent.num_turns as number) : undefined,
      ...(rateLimit ? { rateLimit } : {}),
      ...(turns && turns.length > 0 ? { turns } : {}),
    };
  }

  private parseRateLimitInfo(value: unknown): EngineRateLimitInfo | undefined {
    if (!value || typeof value !== "object") return undefined;
    const obj = value as Record<string, unknown>;
    const info: EngineRateLimitInfo = {};

    if (typeof obj.status === "string") info.status = obj.status;
    const resetsAt = obj.resetsAt;
    if (typeof resetsAt === "number" && Number.isFinite(resetsAt)) info.resetsAt = resetsAt;
    if (typeof resetsAt === "string" && resetsAt.trim()) {
      const parsed = Number(resetsAt);
      if (Number.isFinite(parsed)) info.resetsAt = parsed;
    }
    if (typeof obj.rateLimitType === "string") info.rateLimitType = obj.rateLimitType;
    if (typeof obj.overageStatus === "string") info.overageStatus = obj.overageStatus;
    if (typeof obj.overageDisabledReason === "string") info.overageDisabledReason = obj.overageDisabledReason;
    if (typeof obj.isUsingOverage === "boolean") info.isUsingOverage = obj.isUsingOverage;

    return Object.keys(info).length > 0 ? info : undefined;
  }

  private parseClaudeJsonOutput(stdout: string, fallbackSessionId?: string): EngineResult {
    const parsed = JSON.parse(stdout) as unknown;

    let rateLimitInfo: EngineRateLimitInfo | undefined;
    let resultEvent: Record<string, unknown> = {};

    if (Array.isArray(parsed)) {
      const foundResult = [...parsed].reverse().find(
        (e): e is Record<string, unknown> => !!e && typeof e === "object" && (e as Record<string, unknown>).type === "result",
      );
      resultEvent = foundResult || (parsed[parsed.length - 1] as Record<string, unknown>) || {};

      const foundRate = [...parsed].reverse().find(
        (e): e is Record<string, unknown> => !!e && typeof e === "object" && (e as Record<string, unknown>).type === "rate_limit_event",
      );
      if (foundRate) {
        rateLimitInfo = this.parseRateLimitInfo((foundRate as Record<string, unknown>).rate_limit_info);
      }
    } else if (parsed && typeof parsed === "object") {
      resultEvent = parsed as Record<string, unknown>;
    }

    let finalText = (resultEvent.result as string) || "";

    // If result text is empty, extract last assistant text from conversation
    if (!finalText.trim() && Array.isArray(parsed)) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        const evt = parsed[i] as Record<string, unknown>;
        if (evt.type === "assistant" && Array.isArray(evt.content)) {
          const textBlocks = (evt.content as Array<Record<string, unknown>>)
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string);
          if (textBlocks.length > 0) {
            finalText = textBlocks.join("\n");
            break;
          }
        }
        // Also check for message format with role field
        if (evt.role === "assistant" && Array.isArray(evt.content)) {
          const textBlocks = (evt.content as Array<Record<string, unknown>>)
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text as string);
          if (textBlocks.length > 0) {
            finalText = textBlocks.join("\n");
            break;
          }
        }
      }
    }

    return this.buildEngineResultFromResultEvent(resultEvent, finalText, fallbackSessionId, rateLimitInfo);
  }

  private extractResult(
    result: Record<string, unknown>,
    fallbackSessionId?: string,
    rateLimitInfo?: EngineRateLimitInfo,
    turns?: string[],
  ): EngineResult {
    const isError = result.is_error === true;
    const msg = String(result.result || "");
    const error = isError
      ? (rateLimitInfo?.status === "rejected" ? `Claude usage limit reached: ${msg || "Rate limited"}` : (msg || "Claude error"))
      : undefined;
    return {
      sessionId: String(result.session_id || fallbackSessionId || ""),
      result: isError ? "" : String(result.result || ""),
      error,
      rateLimit: rateLimitInfo,
      cost: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
      durationMs: typeof result.duration_ms === "number" ? result.duration_ms : undefined,
      numTurns: typeof result.num_turns === "number" ? result.num_turns : undefined,
      ...(turns && turns.length > 0 ? { turns } : {}),
    };
  }

  private normalizeRateLimitInfo(raw: unknown): EngineRateLimitInfo | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, unknown>;
    const resetsAt = typeof o.resetsAt === "number" ? o.resetsAt : undefined;
    return {
      status: typeof o.status === "string" ? o.status : undefined,
      resetsAt,
      rateLimitType: typeof o.rateLimitType === "string" ? o.rateLimitType : undefined,
      overageStatus: typeof o.overageStatus === "string" ? o.overageStatus : undefined,
      overageDisabledReason: typeof o.overageDisabledReason === "string" ? o.overageDisabledReason : undefined,
      isUsingOverage: typeof o.isUsingOverage === "boolean" ? o.isUsingOverage : undefined,
    };
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) {
        process.kill(-proc.pid, signal);
      } else {
        proc.kill(signal);
      }
    } catch (err) {
      logger.debug(`Failed to send ${signal} to Claude process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
