import { spawn } from "node:child_process";
import type { Engine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";

export class ClaudeEngine implements Engine {
  name = "claude" as const;

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const streaming = !!opts.onStream;
    const args = ["-p", "--output-format", streaming ? "stream-json" : "json", "--verbose"];

    if (streaming) args.push("--include-partial-messages");
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);

    // Append attachment paths to prompt
    let prompt = opts.prompt;
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map(a => `- ${a}`).join("\n");
    }
    args.push(prompt);

    const bin = opts.bin || "claude";
    logger.info(`Claude engine starting: ${bin} -p --output-format ${streaming ? "stream-json" : "json"} --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"})`);

    // Strip all Claude Code env vars so the spawned CLI doesn't
    // try to attach to the parent session or detect nesting.
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (v !== undefined) cleanEnv[k] = v;
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      // Stream parsing state
      let lastResultMsg: Record<string, unknown> | null = null;
      let lineCount = 0;
      let inTool = false;

      function processStreamLine(line: string, onStream: (delta: StreamDelta) => void): void {
        const trimmed = line.trim();
        if (!trimmed) return;

        lineCount++;
        if (lineCount <= 5) {
          logger.debug(`[claude stream] line ${lineCount}: ${trimmed.slice(0, 300)}`);
        }

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          logger.debug(`[claude stream] unparseable line: ${trimmed.slice(0, 100)}`);
          return;
        }

        const msgType = String(msg.type || "");

        // Final result message — save for extraction on close
        if (msgType === "result") {
          lastResultMsg = msg;
          return;
        }

        // StreamEvent wrapper: { type: "stream_event", event: { type: "content_block_start"|"content_block_delta"|... } }
        if (msgType === "stream_event") {
          const event = msg.event as Record<string, unknown> | undefined;
          if (!event) return;
          const eventType = String(event.type || "");

          if (eventType === "content_block_start") {
            const block = event.content_block as Record<string, unknown> | undefined;
            if (block?.type === "tool_use") {
              const toolName = String(block.name || "unknown");
              const toolId = String(block.id || "");
              inTool = true;
              onStream({ type: "tool_use", content: `Using ${toolName}`, toolName, toolId });
            }
          } else if (eventType === "content_block_delta") {
            const delta = event.delta as Record<string, unknown> | undefined;
            if (!delta) return;
            if (delta.type === "text_delta" && !inTool) {
              const text = String(delta.text || "");
              if (text) {
                onStream({ type: "text", content: text });
              }
            }
          } else if (eventType === "content_block_stop") {
            if (inTool) {
              inTool = false;
              onStream({ type: "tool_result", content: "" });
            }
          }
          return;
        }

        // AssistantMessage (complete message after a turn) — ignore during streaming,
        // we already streamed the text deltas
        if (msgType === "assistant") {
          return;
        }
      }

      if (streaming && opts.onStream) {
        const onStream = opts.onStream;
        let lineBuf = "";

        proc.stdout.on("data", (d: Buffer) => {
          const chunk = d.toString();
          stdout += chunk;
          lineBuf += chunk;
          const lines = lineBuf.split("\n");
          lineBuf = lines.pop() || "";
          for (const line of lines) {
            processStreamLine(line, onStream);
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
        const lines = chunk.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          logger.debug(`[claude stderr] ${line}`);
        }
      });

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;

        logger.info(`Claude engine exited with code ${code}`);

        if (code === 0) {
          // In streaming mode, extract result from the last "result" message
          if (streaming && lastResultMsg) {
            const r = lastResultMsg;
            resolve({
              sessionId: String(r.session_id || opts.resumeSessionId || ""),
              result: String(r.result || ""),
              cost: typeof r.total_cost_usd === "number" ? r.total_cost_usd : undefined,
              durationMs: typeof r.duration_ms === "number" ? r.duration_ms : undefined,
              numTurns: typeof r.num_turns === "number" ? r.num_turns : undefined,
            });
            return;
          }

          // Non-streaming: parse the single JSON blob
          try {
            const result = JSON.parse(stdout);
            resolve({
              sessionId: result.session_id,
              result: result.result,
              cost: result.total_cost_usd,
              durationMs: result.duration_ms,
              numTurns: result.num_turns,
            });
          } catch (e) {
            logger.error(`Failed to parse Claude output: ${e}\nstdout: ${stdout.slice(0, 500)}`);
            resolve({
              sessionId: opts.resumeSessionId || "",
              result: stdout || "(unparseable output)",
              error: `Failed to parse Claude output: ${e}`,
            });
          }
        } else {
          const errMsg = `Claude exited with code ${code}: ${stderr.slice(0, 500)}`;
          logger.error(errMsg);
          resolve({
            sessionId: opts.resumeSessionId || "",
            result: "",
            error: errMsg,
          });
        }
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        const msg = `Failed to spawn Claude CLI: ${err.message}`;
        logger.error(msg);
        reject(new Error(msg));
      });
    });
  }
}
