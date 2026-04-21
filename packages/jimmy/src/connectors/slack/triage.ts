/**
 * Air-reading triage runner for Slack.
 *
 * Invokes a cheap LLM (Haiku, via Claude Code CLI by default) to decide
 * whether an incoming Slack message should be ignored, acknowledged
 * with an emoji, or replied to with a full engine session.
 *
 * This sits BEFORE the main session manager and prevents the expensive
 * engine from running on messages that don't actually want a reply.
 */

import { spawn } from "node:child_process";
import { logger } from "../../shared/logger.js";
import {
  buildTriagePrompt,
  parseTriageDecision,
  type TriageDecision,
  type TriagePromptInput,
} from "./triage-prompt.js";

export interface TriageRunnerOptions {
  /** Binary to invoke — defaults to "claude" */
  bin?: string;
  /** Model to use for the triage call (e.g. "claude-haiku-4-5") */
  model?: string;
  /** Soft timeout before we fall back to "silent" */
  timeoutMs?: number;
  /** Override the spawner (for tests) */
  spawnImpl?: typeof spawn;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_BIN = "claude";

/**
 * Run a triage decision. Never throws — on error returns a safe fallback
 * decision ("silent") so a failing triage cannot block legitimate work.
 */
export async function runTriage(
  input: TriagePromptInput,
  options: TriageRunnerOptions = {},
): Promise<TriageDecision> {
  const prompt = buildTriagePrompt(input);
  const bin = options.bin || DEFAULT_BIN;
  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = options.spawnImpl || spawn;

  try {
    const output = await invokeClaudeOneShot(prompt, {
      bin,
      model,
      timeoutMs,
      spawnFn,
    });
    const decision = parseTriageDecision(output);
    if (!decision) {
      logger.warn(`[triage] unparseable output, defaulting to silent: ${output.slice(0, 200)}`);
      return { action: "silent", reason: "parse_failed" };
    }
    return decision;
  } catch (err) {
    logger.warn(`[triage] execution failed, defaulting to silent: ${err}`);
    return { action: "silent", reason: "triage_error" };
  }
}

interface InvokeOptions {
  bin: string;
  model: string;
  timeoutMs: number;
  spawnFn: typeof spawn;
}

async function invokeClaudeOneShot(prompt: string, opts: InvokeOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      opts.model,
      "--dangerously-skip-permissions",
      prompt,
    ];

    const proc = opts.spawnFn(opts.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGTERM");
      } catch { /* ignore */ }
      reject(new Error(`triage timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(extractClaudeResult(stdout));
    });
  });
}

/**
 * Claude Code's `--output-format json` wraps the model's response in an
 * envelope like `{ "type": "result", "result": "...", ... }`. Strip that
 * if present; otherwise return the raw stdout unchanged.
 */
function extractClaudeResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.result === "string") {
      return parsed.result;
    }
  } catch { /* fall through */ }
  return trimmed;
}
