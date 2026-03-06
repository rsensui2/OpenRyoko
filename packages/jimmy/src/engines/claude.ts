import { spawn } from "node:child_process";
import type { Engine, EngineRunOpts, EngineResult } from "../shared/types.js";

export class ClaudeEngine implements Engine {
  name = "claude" as const;

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const args = ["-p", "--output-format", "json", "--verbose"];

    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);

    // Append attachment paths to prompt
    let prompt = opts.prompt;
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map(a => `- ${a}`).join("\n");
    }
    args.push(prompt);

    return new Promise((resolve, reject) => {
      const proc = spawn(opts.bin || "claude", args, {
        cwd: opts.cwd,
        env: { ...process.env, CLAUDECODE: undefined },
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        if (code === 0) {
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
            reject(new Error(`Failed to parse Claude output: ${e}`));
          }
        } else {
          resolve({
            sessionId: opts.resumeSessionId || "",
            result: "",
            error: `Claude exited with code ${code}: ${stderr.slice(0, 500)}`,
          });
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
      });
    });
  }
}
