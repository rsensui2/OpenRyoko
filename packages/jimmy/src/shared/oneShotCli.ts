import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBin, formatSpawnError } from "./resolveBin.js";
import { buildChildEnv } from "./childEnv.js";

export type OneShotEngine = "claude" | "codex";

export interface OneShotOptions {
  engine?: OneShotEngine;
  bin: string;
  model: string;
  timeoutMs: number;
  spawnFn?: typeof spawn;
  label: string;
  /** A classifier reads supplied text only; never inherit operational tools. */
  classificationOnly?: boolean;
}

export function defaultBinForEngine(engine: OneShotEngine): string {
  return engine === "codex" ? "codex" : "claude";
}

export function defaultModelForEngine(engine: OneShotEngine): string {
  return engine === "codex" ? "gpt-5-nano" : "claude-haiku-4-5";
}

export async function invokeOneShot(prompt: string, opts: OneShotOptions): Promise<string> {
  const engine = opts.engine ?? "claude";
  const cwd = opts.classificationOnly ? fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-classifier-")) : undefined;
  try { return await new Promise((resolve, reject) => {
    const args = buildArgs(engine, opts.model, prompt, opts.classificationOnly);
    const resolvedBin = resolveBin(opts.bin);
    const proc = (opts.spawnFn ?? spawn)(resolvedBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildChildEnv(),
      ...(cwd ? { cwd, detached: process.platform !== "win32" } : {}),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (opts.classificationOnly && process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill(opts.classificationOnly ? "SIGKILL" : "SIGTERM");
      } catch { /* ignore */ }
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail(`${opts.label} timed out after ${opts.timeoutMs}ms`), opts.timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (opts.classificationOnly && stdout.length > 256_000) fail(`${opts.label} output limit exceeded`);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-16000);
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(formatSpawnError(`${opts.label} CLI`, opts.bin, err)));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${engine} exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(engine === "codex" ? extractCodexResult(stdout) : extractClaudeResult(stdout));
    });
  }); } finally {
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function buildArgs(engine: OneShotEngine, model: string, prompt: string, classificationOnly = false): string[] {
  if (engine === "codex") {
    return [
      "exec",
      "--json",
      "--color",
      "never",
      "--model",
      model,
      ...(classificationOnly ? [
        "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--ignore-rules",
        "-c", 'approval_policy="never"', "-c", "project_doc_max_bytes=0",
        "-c", 'web_search="disabled"', "-c", "tools.view_image=false",
        ...["shell_tool", "shell_snapshot", "apps", "browser_use", "computer_use", "goals", "hooks", "multi_agent",
          "plugins", "remote_plugin", "image_generation", "view_image", "code_mode", "code_mode_host",
          "tool_suggest", "skill_search", "skill_mcp_dependency_install", "in_app_local_automation",
        ].flatMap((feature) => ["--disable", feature]),
      ] : ["--dangerously-bypass-approvals-and-sandbox"]),
      "--skip-git-repo-check",
      "--",
      prompt,
    ];
  }
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    ...(classificationOnly ? ["--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", ""] : ["--dangerously-skip-permissions"]),
    "--",
    prompt,
  ];
}

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

function extractCodexResult(stdout: string): string {
  let text = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as Record<string, unknown>;
      if (msg.type !== "item.completed") continue;
      const item = msg.item as Record<string, unknown> | undefined;
      if (item?.type !== "agent_message") continue;
      if (typeof item.text === "string") text = item.text;
    } catch { /* ignore non-json lines */ }
  }
  return text || stdout.trim();
}
