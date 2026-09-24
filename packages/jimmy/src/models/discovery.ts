import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBin } from "../shared/resolveBin.js";
import { buildChildEnv } from "../shared/childEnv.js";
import type { ModelInfo } from "../shared/types.js";

export type ManagedEngine = "codex" | "claude";
export interface DiscoveredModel extends ModelInfo {
  isDefault?: boolean;
  aliases?: string[];
  defaultEffort?: string;
  upgrade?: string;
}
const safeId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]{0,159}$/.test(v);
const efforts = new Set(["low", "medium", "high", "xhigh", "max"]);
export function normalizeModels(engine: ManagedEngine, rows: unknown): DiscoveredModel[] {
  if (!Array.isArray(rows)) throw new Error("Invalid model catalog");
  const result = new Map<string, DiscoveredModel>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || row.hidden === true) continue;
    const id = engine === "codex" ? row.model ?? row.id : row.resolvedModel ?? row.value;
    if (!safeId(id)) continue;
    const levels = engine === "codex" ? row.supportedReasoningEfforts?.map((e: any) => e.reasoningEffort) : row.supportedEffortLevels;
    const effortLevels = Array.isArray(levels) ? levels.filter((e: unknown): e is string => typeof e === "string" && efforts.has(e)) : [];
    result.set(id, {
      id, label: typeof row.displayName === "string" && row.displayName.trim() ? row.displayName.trim().slice(0, 100) : id,
      supportsEffort: effortLevels.length > 0, effortLevels,
      ...(row.isDefault === true || row.value === "default" || result.get(id)?.isDefault ? { isDefault: true } : {}),
      ...(engine === "claude" ? { aliases: [...(result.get(id)?.aliases ?? []), row.value].filter(safeId) } : {}),
      ...(efforts.has(row.defaultReasoningEffort) ? { defaultEffort: row.defaultReasoningEffort } : {}),
      ...(safeId(row.upgrade) ? { upgrade: row.upgrade } : {}),
    });
  }
  if (!result.size) throw new Error("Empty model catalog");
  return [...result.values()];
}

/** Read CLI metadata without sending a user prompt or starting an inference turn.
 * Same binary and child environment as normal engine execution. No credentials
 * or arbitrary stderr are returned to callers or persisted in the catalog. */
export async function discoverModels(engine: ManagedEngine, requestedBin: string): Promise<DiscoveredModel[]> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-model-list-"));
  try {
    return await new Promise((resolve, reject) => {
      const args = engine === "codex" ? ["app-server"] : ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
      const proc = spawn(resolveBin(requestedBin), args, { cwd, env: buildChildEnv(engine === "codex" ? { stripPrefixes: ["CODEX_"], stripExact: ["CODEX"] } : {}), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
      let settled = false, buffer = "", bytes = 0, requestId = 1, pages = 0;
      const rows: unknown[] = [];
      const cursors = new Set<string>();
      const finish = (error?: Error, result?: DiscoveredModel[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stdin.destroy();
        const signal = (value: NodeJS.Signals) => {
          try { if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, value); else proc.kill(value); } catch { /* process already exited */ }
        };
        signal("SIGTERM");
        const kill = setTimeout(() => signal("SIGKILL"), 1000);
        kill.unref();
        error ? reject(error) : resolve(result!);
      };
      const timer = setTimeout(() => finish(new Error("Model discovery timed out. Check CLI version and login.")), 20_000);
      const send = (value: unknown) => proc.stdin.write(JSON.stringify(value) + "\n");
      proc.on("error", () => finish(new Error("Cannot start model discovery. Check CLI installation.")));
      proc.stdin.on("error", () => finish(new Error("Model discovery connection closed.")));
      proc.stderr.on("data", () => {});
      proc.on("close", () => { if (!settled) finish(new Error("CLI model discovery unavailable. Update the CLI or check login.")); });
      proc.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) return finish(new Error("Model catalog exceeded size limit"));
        buffer += chunk.toString();
        let end: number;
        while (!settled && (end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message: any;
          try { message = JSON.parse(line); } catch { continue; }
          try {
            if (engine === "claude") {
              if (message.type !== "control_response" || message.response?.request_id !== "models") continue;
              if (message.response.subtype !== "success") throw new Error("Claude model discovery failed");
              finish(undefined, normalizeModels(engine, message.response.response?.models));
            } else {
              if (message.id !== requestId) continue;
              if (message.error) throw new Error("Codex model discovery failed. Check CLI version and login.");
              if (requestId === 1) {
                send({ method: "initialized", params: {} });
                send({ method: "model/list", id: ++requestId, params: { limit: 100, includeHidden: false } });
              } else {
                if (!Array.isArray(message.result?.data)) throw new Error("Invalid model catalog");
                rows.push(...message.result.data);
                const cursor = message.result.nextCursor;
                if (cursor) {
                  if (typeof cursor !== "string" || cursors.has(cursor) || ++pages > 20) throw new Error("Invalid catalog pagination");
                  cursors.add(cursor);
                  send({ method: "model/list", id: ++requestId, params: { limit: 100, includeHidden: false, cursor } });
                } else finish(undefined, normalizeModels(engine, rows));
              }
            }
          } catch (error) { finish(error instanceof Error ? error : new Error("Invalid model catalog")); }
        }
      });
      send(engine === "codex"
        ? { method: "initialize", id: 1, params: { clientInfo: { name: "openryoko", version: "1.0.0" } } }
        : { type: "control_request", request_id: "models", request: { subtype: "initialize" } });
    });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}
