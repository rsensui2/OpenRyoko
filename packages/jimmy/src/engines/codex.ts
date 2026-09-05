import { spawn, type ChildProcess } from "node:child_process";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin, formatSpawnError } from "../shared/resolveBin.js";
import { buildChildEnv } from "../shared/childEnv.js";

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

/**
 * Context-meter source for Codex: the `turn.completed` event carries a `usage`
 * object whose `input_tokens` reflects how full the context window currently is.
 * Defensive — returns undefined on any shape mismatch so it can never break the
 * turn handling path.
 */
function extractCodexContextTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const n = Number((usage as Record<string, unknown>).input_tokens ?? 0);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export class CodexEngine implements InterruptibleEngine {
  name = "codex" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    live.terminationReason = reason;
    logger.info(`Killing Codex process for session ${sessionId}`);
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
    let prompt = opts.prompt;
    if (opts.systemPrompt) {
      prompt = opts.systemPrompt + "\n\n---\n\n" + prompt;
    }
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const requestedBin = opts.bin || "codex";
    const bin = resolveBin(requestedBin);
    const isResume = !!opts.resumeSessionId;
    const args = isResume
      ? this.buildResumeArgs(opts, prompt)
      : this.buildFreshArgs(opts, prompt);

    logger.info(
      `Codex engine starting: ${bin} ${args[0]}${isResume ? " resume" : ""} --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"})`,
    );

    const cleanEnv = buildChildEnv({ stripPrefixes: ["CODEX_"], stripExact: ["CODEX"] });

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      const sessionId = opts.sessionId || `codex-${Date.now()}`;
      this.liveProcesses.set(sessionId, {
        proc,
        terminationReason: null,
      });

      let stderr = "";
      let settled = false;
      let threadId = "";
      let resultText = "";
      let numTurns = 0;
      let lastContextTokens: number | undefined;
      let turnError: string | null = null;
      let lineBuf = "";
      const onStream = opts.onStream || null;
      const STDERR_MAX = 10 * 1024; // 10KB rolling window for error reporting

      proc.stdout.on("data", (d: Buffer) => {
        lineBuf += d.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const line of lines) {
          const parsed = this.processJsonlLine(line);
          if (!parsed) continue;

          switch (parsed.type) {
            case "thread_id":
              threadId = parsed.threadId;
              logger.info(`Codex session got thread ID: ${threadId}`);
              break;
            case "tool_start":
              if (onStream) onStream(parsed.delta);
              break;
            case "tool_end":
              if (onStream) onStream(parsed.delta);
              break;
            case "text":
              // Each codex "text" event is a *complete* agent_message, not a
              // streaming delta. gpt-5.5 routinely emits an interim progress
              // message ("I'll check X first…") before its tool calls and a
              // separate final message afterwards. Keep only the latest so the
              // interim narration doesn't leak into the delivered reply; live
              // progress is still surfaced via onStream below.
              resultText = parsed.delta.content;
              if (onStream) onStream(parsed.delta);
              break;
            case "error":
              turnError = parsed.message;
              if (onStream) onStream({ type: "error", content: parsed.message });
              break;
            case "usage":
              numTurns++;
              if (typeof parsed.contextTokens === "number") lastContextTokens = parsed.contextTokens;
              break;
            case "turn_failed":
              turnError = parsed.message;
              if (onStream) onStream({ type: "error", content: parsed.message });
              break;
          }
        }
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        // Keep only the last 10KB of stderr to bound memory usage
        if (stderr.length > STDERR_MAX) {
          stderr = stderr.slice(stderr.length - STDERR_MAX);
        }
        for (const line of chunk.trim().split("\n").filter(Boolean)) {
          logger.debug(`[codex stderr] ${line}`);
        }
      });

      proc.stdin.end();

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;

        const terminationReason = this.liveProcesses.get(sessionId)?.terminationReason ?? null;
        this.liveProcesses.delete(sessionId);

        if (lineBuf.trim()) {
          const parsed = this.processJsonlLine(lineBuf);
          if (parsed) {
            switch (parsed.type) {
              case "thread_id":
                threadId = parsed.threadId;
                break;
              case "text":
                // See the stdout handler above — keep only the final
                // agent_message, never concatenate interim ones.
                resultText = parsed.delta.content;
                break;
              case "usage":
                numTurns++;
                if (typeof parsed.contextTokens === "number") lastContextTokens = parsed.contextTokens;
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

        if (terminationReason) {
          resolve({
            sessionId: threadId || opts.resumeSessionId || "",
            result: resultText,
            error: terminationReason,
            numTurns: numTurns || undefined,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          });
          return;
        }

        if (code === 0 || (code !== null && threadId)) {
          resolve({
            sessionId: threadId || opts.resumeSessionId || "",
            result: resultText,
            error: turnError ?? undefined,
            numTurns: numTurns || undefined,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          });
          return;
        }

        const errMsg = turnError || `Codex exited with code ${code}: ${stderr.slice(0, 500)}`;
        logger.error(errMsg);
        resolve({
          sessionId: threadId || opts.resumeSessionId || "",
          result: resultText,
          error: errMsg,
          ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
        });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        this.liveProcesses.delete(sessionId);
        const errMsg = formatSpawnError("Codex CLI", requestedBin, err);
        logger.error(errMsg);
        opts.onStream?.({ type: "error", content: errMsg });
        reject(new Error(errMsg));
      });
    });
  }

  private buildFreshArgs(opts: EngineRunOpts, prompt: string): string[] {
    const args = ["exec"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.effortLevel && opts.effortLevel !== "default") args.push("-c", `model_reasoning_effort="${opts.effortLevel}"`);
    args.push("--json", "--color", "never", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
    if (opts.cwd) args.push("-C", opts.cwd);
    if (opts.cliFlags?.length) args.push(...opts.cliFlags);
    args.push("--", prompt);
    return args;
  }

  private buildResumeArgs(opts: EngineRunOpts, prompt: string): string[] {
    const args = ["exec", "resume"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.effortLevel && opts.effortLevel !== "default") args.push("-c", `model_reasoning_effort="${opts.effortLevel}"`);
    args.push("--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
    if (opts.cliFlags?.length) args.push(...opts.cliFlags);
    args.push("--", opts.resumeSessionId!, prompt);
    return args;
  }

  private processJsonlLine(
    line: string,
  ):
    | { type: "thread_id"; threadId: string }
    | { type: "tool_start"; delta: StreamDelta }
    | { type: "tool_end"; delta: StreamDelta }
    | { type: "text"; delta: StreamDelta }
    | { type: "error"; message: string }
    | { type: "usage"; contextTokens?: number }
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

    if (eventType === "thread.started") {
      return { type: "thread_id", threadId: String(msg.thread_id || "") };
    }

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
        return { type: "tool_end", delta: { type: "tool_result", content: `Edited: ${filePath}` } };
      }

      if (itemType === "file_read") {
        const filePath = String(item.file_path || item.filename || "file");
        return { type: "tool_end", delta: { type: "tool_result", content: `Read: ${filePath}` } };
      }

      if (itemType === "error") {
        const message = String(item.message || "Unknown error");
        if (
          message.includes("Under-development features") ||
          message.includes("Model metadata") ||
          message.startsWith("Skill descriptions were shortened to fit the skills context budget.")
        ) {
          logger.debug(`[codex] suppressed warning: ${message.slice(0, 200)}`);
          return null;
        }
        return { type: "error", message };
      }

      return null;
    }

    if (eventType === "turn.completed") {
      return { type: "usage", contextTokens: extractCodexContextTokens(msg.usage) };
    }

    if (eventType === "turn.failed") {
      const error = msg.error as Record<string, unknown> | undefined;
      return { type: "turn_failed", message: String(error?.message || "Turn failed") };
    }

    if (eventType === "error") {
      return { type: "error", message: String(msg.message || "Unknown error") };
    }

    return null;
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
      logger.debug(`Failed to send ${signal} to Codex process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
