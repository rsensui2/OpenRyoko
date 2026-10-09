/**
 * Engine-specific session forking logic for the Duplicate feature.
 *
 * - Claude: uses --fork-session flag with --print mode
 * - Codex: copies the JSONL session file with a new UUID
 * - Gemini: copies the JSON session file with a new UUID
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../shared/logger.js";
import { claudeAutoMemoryEnvFor } from "../shared/claude-auto-memory.js";

export interface ForkResult {
  engineSessionId: string;
}

/**
 * Fork a Claude Code CLI session using --fork-session.
 * Returns the new engine session ID from the fork.
 */
export function forkClaudeSession(engineSessionId: string, cwd: string): ForkResult {
  logger.info(`Forking Claude session ${engineSessionId} in ${cwd}`);

  const result = execFileSync("claude", [
    "--resume", engineSessionId,
    "--fork-session",
    "--print",
    "--output-format", "json",
    "-p", "Session duplicated — this is a snapshot of the original conversation.",
  ], {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, PATH: process.env.PATH, ...claudeAutoMemoryEnvFor(cwd) },
  });

  const lastLine = result.trim().split("\n").pop();
  if (!lastLine) throw new Error("Claude fork returned empty output");
  const parsed = JSON.parse(lastLine) as { session_id?: string };
  if (!parsed.session_id) {
    throw new Error("Claude fork did not return a session_id");
  }

  logger.info(`Claude fork successful: ${engineSessionId} → ${parsed.session_id}`);
  return { engineSessionId: parsed.session_id };
}

/**
 * Fork a Codex CLI session by copying its JSONL file with a new UUID.
 * Returns the new engine session ID.
 */
export function forkCodexSession(engineSessionId: string): ForkResult {
  logger.info(`Forking Codex session ${engineSessionId}`);

  const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
  const sourceFile = findCodexSessionFile(sessionsRoot, engineSessionId);
  if (!sourceFile) {
    throw new Error(`Codex session file not found for ${engineSessionId}`);
  }

  const newUuid = uuidv4();
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const destDir = path.join(sessionsRoot, year, month, day);
  fs.mkdirSync(destDir, { recursive: true });
  const destFile = path.join(destDir, `rollout-${ts}-${newUuid}.jsonl`);

  // Read source, rewrite session_meta (first line) with new UUID
  const lines = fs.readFileSync(sourceFile, "utf-8").split("\n");
  if (lines.length > 0 && lines[0].trim()) {
    const meta = JSON.parse(lines[0]);
    if (meta.payload?.id) {
      meta.payload.id = newUuid;
      meta.timestamp = now.toISOString();
      lines[0] = JSON.stringify(meta);
    }
  }

  fs.writeFileSync(destFile, lines.join("\n"));
  logger.info(`Codex fork successful: ${engineSessionId} → ${newUuid} (${destFile})`);
  return { engineSessionId: newUuid };
}

/**
 * Fork a Gemini CLI session by copying its JSON file with a new UUID.
 * Returns the new engine session ID.
 */
export function forkGeminiSession(engineSessionId: string): ForkResult {
  logger.info(`Forking Gemini session ${engineSessionId}`);

  const geminiTmp = path.join(os.homedir(), ".gemini", "tmp");
  const sourceFile = findGeminiSessionFile(geminiTmp, engineSessionId);
  if (!sourceFile) {
    throw new Error(`Gemini session file not found for ${engineSessionId}`);
  }

  const data = JSON.parse(fs.readFileSync(sourceFile, "utf-8"));
  const newUuid = uuidv4();
  const now = new Date();
  const ts = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}T${String(now.getUTCHours()).padStart(2, "0")}-${String(now.getUTCMinutes()).padStart(2, "0")}`;

  // Update session ID and message IDs
  data.sessionId = newUuid;
  data.startTime = now.toISOString();
  data.lastUpdated = now.toISOString();
  if (Array.isArray(data.messages)) {
    for (const msg of data.messages) {
      if (msg.id) msg.id = uuidv4();
    }
  }

  // Write to same chats directory as the source
  const chatsDir = path.dirname(sourceFile);
  const destFile = path.join(chatsDir, `session-${ts}-${newUuid.slice(0, 8)}.json`);
  fs.writeFileSync(destFile, JSON.stringify(data, null, 2));

  logger.info(`Gemini fork successful: ${engineSessionId} → ${newUuid} (${destFile})`);
  return { engineSessionId: newUuid };
}

/**
 * Fork an engine session based on engine type.
 */
export function forkEngineSession(engine: string, engineSessionId: string, cwd: string): ForkResult {
  switch (engine) {
    case "claude":
      return forkClaudeSession(engineSessionId, cwd);
    case "codex":
      return forkCodexSession(engineSessionId);
    case "gemini":
      return forkGeminiSession(engineSessionId);
    default:
      throw new Error(`Unsupported engine for fork: ${engine}`);
  }
}

// --- Helpers ---

function findCodexSessionFile(root: string, sessionId: string): string | null {
  // Codex filenames contain the UUID: rollout-<ts>-<uuid>.jsonl
  // Walk year/month/day directories
  if (!fs.existsSync(root)) return null;
  for (const year of fs.readdirSync(root)) {
    const yearDir = path.join(root, year);
    if (!fs.statSync(yearDir).isDirectory()) continue;
    for (const month of fs.readdirSync(yearDir)) {
      const monthDir = path.join(yearDir, month);
      if (!fs.statSync(monthDir).isDirectory()) continue;
      for (const day of fs.readdirSync(monthDir)) {
        const dayDir = path.join(monthDir, day);
        if (!fs.statSync(dayDir).isDirectory()) continue;
        for (const file of fs.readdirSync(dayDir)) {
          if (file.endsWith(".jsonl") && file.includes(sessionId)) {
            return path.join(dayDir, file);
          }
        }
      }
    }
  }
  return null;
}

function findGeminiSessionFile(tmpRoot: string, sessionId: string): string | null {
  // Gemini sessions: ~/.gemini/tmp/<project-hash>/chats/session-<ts>-<id-prefix>.json
  // The filename only has the first 8 chars of the UUID, so we need to read the JSON to match
  if (!fs.existsSync(tmpRoot)) return null;
  const prefix = sessionId.slice(0, 8);
  for (const projHash of fs.readdirSync(tmpRoot)) {
    const chatsDir = path.join(tmpRoot, projHash, "chats");
    if (!fs.existsSync(chatsDir) || !fs.statSync(chatsDir).isDirectory()) continue;
    for (const file of fs.readdirSync(chatsDir)) {
      if (!file.endsWith(".json")) continue;
      // Quick check: filename contains the UUID prefix
      if (file.includes(prefix)) {
        const filePath = path.join(chatsDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (data.sessionId === sessionId) return filePath;
        } catch { /* skip corrupted files */ }
      }
    }
  }
  return null;
}
