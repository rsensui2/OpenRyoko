import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildChildEnv } from "../shared/childEnv.js";
import { resolveBin } from "../shared/resolveBin.js";
import type { ModelInfo } from "../shared/types.js";

const DISCOVERY_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT_BYTES = 256 * 1024;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;

/**
 * `agy models` prints one model per line as `<id>\t<label>`, after a
 * "Fetching available models..." line. Lines that are not of that shape
 * (progress, errors such as "Please sign in") are skipped.
 */
export function parseAgyModels(output: string): ModelInfo[] {
  const models = new Map<string, ModelInfo>();
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    if (!SAFE_ID.test(id)) continue;
    const label = line.slice(tab + 1).trim().slice(0, 100) || id;
    models.set(id, { id, label, supportsEffort: false, effortLevels: [] });
  }
  return [...models.values()];
}

/** List the models agy's signed-in account can use. Runs no inference turn. */
export async function discoverAntigravityModels(requestedBin: string): Promise<ModelInfo[]> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-agy-models-"));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const proc = spawn(resolveBin(requestedBin), ["models"], {
        cwd, env: buildChildEnv(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      });
      let stdout = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (proc.exitCode === null) process.platform !== "win32" && proc.pid ? process.kill(-proc.pid, "SIGKILL") : proc.kill("SIGKILL");
        } catch { /* already exited */ }
        error ? reject(error) : resolve(stdout);
      };
      const timer = setTimeout(() => finish(new Error("agy models timed out")), DISCOVERY_TIMEOUT_MS);
      timer.unref?.();
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > OUTPUT_LIMIT_BYTES) finish(new Error("agy models output exceeded size limit"));
      });
      proc.stderr.on("data", () => { /* not surfaced: may name the account */ });
      proc.on("error", () => finish(new Error("Cannot start agy. Check the Antigravity CLI installation.")));
      proc.on("close", () => finish());
    });
    const models = parseAgyModels(output);
    if (models.length === 0) throw new Error("agy listed no models. Run `agy` once to sign in.");
    return models;
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}
