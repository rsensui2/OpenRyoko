import { spawn, type ChildProcess } from "node:child_process";
import type { BidirectionalEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import type { BidirectionalTimeouts } from "./claude.js";
import { logger } from "../shared/logger.js";

/** State for a running Codex process */
interface LiveProcess {
  proc: ChildProcess;
  /** Last known engine thread ID */
  engineSessionId: string;
  /** When the process was spawned */
  spawnedAt: number;
  /** When the last turn completed (null if mid-turn) */
  lastTurnCompletedAt: number | null;
}

/**
 * Full Codex engine implementation using `codex exec` with JSONL streaming.
 *
 * Implements BidirectionalEngine for lifecycle parity with ClaudeEngine:
 * - kill() terminates a running process
 * - isAlive() checks if a process is still running
 * - steer() logs a warning (Codex exec is one-shot, no mid-turn stdin)
 * - Sweep loop manages idle/hard timeouts
 *
 * Key differences from Claude engine:
 * - No true bidirectional streaming — Codex exec is one-shot per invocation
 * - Session resume is a subcommand: `codex exec resume <threadId> <prompt>`
 * - No --append-system-prompt — system prompt is prepended to the user prompt
 * - Thread ID (from thread.started event) serves as engineSessionId
 * - JSONL events use a different schema than Claude's stream-json
 * - Always uses --json for reliable structured output parsing
 */
export class CodexEngine implements BidirectionalEngine {
  name = "codex" as const;
  private liveProcesses = new Map<string, LiveProcess>();
  private sweepInterval: ReturnType<typeof setInterval> | null = null;
  private timeouts: BidirectionalTimeouts = { idleTimeoutMinutes: 60, hardTimeoutHours: 24 };

  /**
   * Set timeout configuration and start the sweep loop.
   */
  setTimeouts(timeouts: BidirectionalTimeouts): void {
    this.timeouts = timeouts;
    this.startSweep();
  }

  /**
   * Start the global sweep interval (every 60s) that cleans up idle/expired processes.
   */
  private startSweep(): void {
    if (this.sweepInterval) return;
    this.sweepInterval = setInterval(() => this.sweep(), 60_000);
  }

  /**
   * Check all live processes for hard timeout expiry.
   * Note: Codex processes are one-shot so idle timeout is less relevant,
   * but hard timeout prevents runaway processes.
   */
  private sweep(): void {
    const now = Date.now();
    const hardMs = this.timeouts.hardTimeoutHours * 60 * 60 * 1000;

    for (const [sessionId, live] of this.liveProcesses) {
      if (live.proc.killed || live.proc.exitCode !== null) {
        // Clean up dead entries
        this.liveProcesses.delete(sessionId);
        continue;
      }

      const age = now - live.spawnedAt;

      // Hard timeout — kills even mid-turn
      if (hardMs > 0 && age >= hardMs) {
        logger.info(`Hard timeout (${this.timeouts.hardTimeoutHours}h) reached for Codex session ${sessionId}, killing process`);
        this.kill(sessionId);
      }
    }
  }

  /**
   * Stop the sweep loop (for graceful shutdown).
   */
  stopSweep(): void {
    if (this.sweepInterval) {
      clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  /**
   * Send a follow-up message to a running session.
   * Codex exec is one-shot — stdin is closed immediately after spawn.
   * Mid-turn steering is not supported; the message will be queued by the session manager.
   */
  steer(sessionId: string, message: string): void {
    logger.warn(`Cannot steer Codex session ${sessionId}: Codex exec is one-shot and does not accept mid-turn input. Message will be queued for next turn.`);
  }

  /**
   * Kill a running engine process (for interrupt).
   */
  kill(sessionId: string): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    logger.info(`Killing Codex process for session ${sessionId}`);
    live.proc.kill("SIGTERM");
    // Give it a moment, then force kill
    setTimeout(() => {
      if (!live.proc.killed) {
        live.proc.kill("SIGKILL");
      }
    }, 2000);
  }

  /**
   * Check if a process is alive for this session.
   */
  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    // Build the effective prompt (system prompt + user prompt)
    let prompt = opts.prompt;
    if (opts.systemPrompt) {
      prompt = opts.systemPrompt + "\n\n---\n\n" + prompt;
    }
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map(a => `- ${a}`).join("\n");
    }

    const bin = opts.bin || "codex";
    const isResume = !!opts.resumeSessionId;

    // Build args based on whether we're resuming or starting fresh
    let args: string[];
    if (isResume) {
      // codex exec resume <sessionId> <prompt>
      // Note: exec resume has fewer flags than exec (no --color, no -C)
      args = ["exec", "resume"];
      if (opts.model) args.push("--model", opts.model);
      args.push("--json");
      args.push("--full-auto");
      args.push("--skip-git-repo-check");
      if (opts.cliFlags?.length) args.push(...opts.cliFlags);
      args.push(opts.resumeSessionId!);
      args.push(prompt);
    } else {
      // codex exec <prompt>
      args = ["exec"];
      if (opts.model) args.push("--model", opts.model);
      args.push("--json");
      args.push("--color", "never");
      args.push("--full-auto");
      args.push("--skip-git-repo-check");
      if (opts.cwd) args.push("-C", opts.cwd);
      if (opts.cliFlags?.length) args.push(...opts.cliFlags);
      args.push(prompt);
    }

    logger.info(
      `Codex engine starting: ${bin} ${args[0]}${isResume ? " resume" : ""} --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"})`,
    );

    const cleanEnv = this.buildCleanEnv();

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Track the live process for kill/isAlive
      const sessionId = opts.sessionId || `codex-${Date.now()}`;
      const live: LiveProcess = {
        proc,
        engineSessionId: opts.resumeSessionId || "",
        spawnedAt: Date.now(),
        lastTurnCompletedAt: null,
      };
      this.liveProcesses.set(sessionId, live);

      // Ensure sweep loop is running
      this.startSweep();

      let stderr = "";
      let settled = false;

      // State tracked across JSONL events
      let threadId = "";
      let resultText = "";
      let numTurns = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let turnError: string | null = null;
      const onStream = opts.onStream || null;

      let lineBuf = "";

      proc.stdout!.on("data", (d: Buffer) => {
        const chunk = d.toString();
        lineBuf += chunk;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const line of lines) {
          const parsed = this.processJsonlLine(line);
          if (!parsed) continue;

          switch (parsed.type) {
            case "thread_id":
              threadId = parsed.threadId;
              live.engineSessionId = threadId;
              logger.info(`Codex session got thread ID: ${threadId}`);
              break;
            case "tool_start":
              if (onStream) onStream(parsed.delta);
              break;
            case "tool_end":
              if (onStream) onStream(parsed.delta);
              break;
            case "text":
              resultText += parsed.delta.content;
              if (onStream) onStream(parsed.delta);
              break;
            case "error":
              turnError = parsed.message;
              if (onStream) onStream({ type: "error", content: parsed.message });
              break;
            case "usage":
              numTurns++;
              if (parsed.inputTokens) totalInputTokens += parsed.inputTokens;
              if (parsed.outputTokens) totalOutputTokens += parsed.outputTokens;
              break;
            case "turn_failed":
              turnError = parsed.message;
              if (onStream) onStream({ type: "error", content: parsed.message });
              break;
          }
        }
      });

      proc.stderr!.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        for (const line of chunk.trim().split("\n").filter(Boolean)) {
          logger.debug(`[codex stderr] ${line}`);
        }
      });

      // Close stdin immediately — Codex exec doesn't read from it
      proc.stdin!.end();

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;

        // Process any remaining data in line buffer
        if (lineBuf.trim()) {
          const parsed = this.processJsonlLine(lineBuf);
          if (parsed) {
            switch (parsed.type) {
              case "thread_id":
                threadId = parsed.threadId;
                break;
              case "text":
                resultText += parsed.delta.content;
                break;
              case "usage":
                numTurns++;
                if (parsed.inputTokens) totalInputTokens += parsed.inputTokens;
                if (parsed.outputTokens) totalOutputTokens += parsed.outputTokens;
                break;
              case "error":
                turnError = parsed.message;
                break;
              case "turn_failed":
                turnError = parsed.message;
                break;
            }
          }
        }

        logger.info(`Codex engine exited with code ${code} (thread: ${threadId || "none"}, turns: ${numTurns})`);

        // Mark turn completed and clean up
        live.lastTurnCompletedAt = Date.now();
        this.liveProcesses.delete(sessionId);

        if (code === 0 || (code !== null && threadId)) {
          resolve({
            sessionId: threadId || opts.resumeSessionId || "",
            result: resultText,
            error: turnError ?? undefined,
            numTurns: numTurns || undefined,
          });
        } else {
          const errMsg = turnError || `Codex exited with code ${code}: ${stderr.slice(0, 500)}`;
          logger.error(errMsg);
          resolve({
            sessionId: threadId || opts.resumeSessionId || "",
            result: resultText || "",
            error: errMsg,
          });
        }
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        this.liveProcesses.delete(sessionId);
        reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
      });
    });
  }

  /**
   * Parse a single line of JSONL output from `codex exec --json`.
   *
   * Event types observed:
   * - thread.started → { thread_id }
   * - turn.started → (ignore)
   * - item.started → command_execution / file_edit / file_read in progress
   * - item.completed → agent_message / command_execution / file_edit completed
   * - turn.completed → usage stats
   * - turn.failed → error
   * - error → error message
   */
  private processJsonlLine(
    line: string,
  ):
    | { type: "thread_id"; threadId: string }
    | { type: "tool_start"; delta: StreamDelta }
    | { type: "tool_end"; delta: StreamDelta }
    | { type: "text"; delta: StreamDelta }
    | { type: "error"; message: string }
    | { type: "usage"; inputTokens: number; outputTokens: number }
    | { type: "turn_failed"; message: string }
    | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.debug(`[codex stream] unparseable line: ${trimmed.slice(0, 100)}`);
      return null;
    }

    const eventType = String(msg.type || "");

    // thread.started → capture thread ID (our engineSessionId)
    if (eventType === "thread.started") {
      return { type: "thread_id", threadId: String(msg.thread_id || "") };
    }

    // item.started → tool/command/file execution beginning
    if (eventType === "item.started") {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const itemType = String(item.type || "");

      if (itemType === "command_execution") {
        const command = String(item.command || "shell");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Running: ${command}`,
            toolName: "command_execution",
            toolId: String(item.id || ""),
          },
        };
      }

      if (itemType === "file_edit") {
        const filePath = String(item.file_path || item.filename || "file");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Editing: ${filePath}`,
            toolName: "file_edit",
            toolId: String(item.id || ""),
          },
        };
      }

      if (itemType === "file_read") {
        const filePath = String(item.file_path || item.filename || "file");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Reading: ${filePath}`,
            toolName: "file_read",
            toolId: String(item.id || ""),
          },
        };
      }

      return null;
    }

    // item.completed → agent message text or command/file result
    if (eventType === "item.completed") {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const itemType = String(item.type || "");

      if (itemType === "agent_message") {
        const text = String(item.text || "");
        if (text) {
          return { type: "text", delta: { type: "text", content: text } };
        }
      }

      if (itemType === "command_execution") {
        const output = String(item.aggregated_output || "");
        const exitCode = item.exit_code;
        const command = String(item.command || "shell");
        return {
          type: "tool_end",
          delta: {
            type: "tool_result",
            content: output
              ? `${command} (exit ${exitCode}): ${output.slice(0, 500)}`
              : `${command} (exit ${exitCode})`,
          },
        };
      }

      if (itemType === "file_edit") {
        const filePath = String(item.file_path || item.filename || "file");
        return {
          type: "tool_end",
          delta: {
            type: "tool_result",
            content: `Edited: ${filePath}`,
          },
        };
      }

      if (itemType === "file_read") {
        const filePath = String(item.file_path || item.filename || "file");
        return {
          type: "tool_end",
          delta: {
            type: "tool_result",
            content: `Read: ${filePath}`,
          },
        };
      }

      // Error items (warnings, model metadata issues, etc.)
      if (itemType === "error") {
        const message = String(item.message || "Unknown error");
        // Suppress noisy warnings that aren't real errors
        if (message.includes("Under-development features") || message.includes("Model metadata")) {
          logger.debug(`[codex] suppressed warning: ${message.slice(0, 200)}`);
          return null;
        }
        return { type: "error", message };
      }

      return null;
    }

    // turn.completed → usage statistics
    if (eventType === "turn.completed") {
      const usage = msg.usage as Record<string, unknown> | undefined;
      const inputTokens = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
      const outputTokens = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
      return { type: "usage", inputTokens, outputTokens };
    }

    // turn.failed → error
    if (eventType === "turn.failed") {
      const error = msg.error as Record<string, unknown> | undefined;
      const message = String(error?.message || "Turn failed");
      return { type: "turn_failed", message };
    }

    // error → top-level error
    if (eventType === "error") {
      return { type: "error", message: String(msg.message || "Unknown error") };
    }

    // turn.started and other events — ignore
    return null;
  }

  /**
   * Build a clean environment without nesting vars from either engine.
   */
  private buildCleanEnv(): Record<string, string> {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // Skip nesting indicators from both engines
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (k === "CODEX" || k.startsWith("CODEX_")) continue;
      if (v !== undefined) cleanEnv[k] = v;
    }
    return cleanEnv;
  }
}
