import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type JsonRecord = Record<string, unknown>;

export interface ClaudeUsageWindow {
  name: string;
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
  resetsAtIso?: string;
}

export interface ClaudeUsageResponse {
  available: boolean;
  source: "claude-oauth-usage";
  refreshedAt: string;
  windows: ClaudeUsageWindow[];
  unavailableReason?: "disabled" | "no-oauth-credentials" | "provider-unavailable";
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 3_500;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function accessTokenFromCredentialPayload(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) return undefined;
    return nonEmptyString(parsed.claudeAiOauth.accessToken);
  } catch {
    return undefined;
  }
}

async function readClaudeOAuthToken(): Promise<string | undefined> {
  if (process.platform === "darwin") {
    const keychain = await new Promise<string | undefined>((resolve) => {
      execFile(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 3_000 },
        (error, stdout) => resolve(error ? undefined : accessTokenFromCredentialPayload(stdout.trim())),
      );
    });
    if (keychain) return keychain;
  }

  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    return accessTokenFromCredentialPayload(fs.readFileSync(path.join(configDir, ".credentials.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** Map every provider bucket, including future model-scoped weekly buckets. */
export function windowsFromClaudeUsage(usage: JsonRecord): ClaudeUsageWindow[] {
  const windows: ClaudeUsageWindow[] = [];
  const seen = new Set<string>();
  const push = (name: string, percent: number, resetsAtIso?: string, duration?: number) => {
    if (seen.has(name)) return;
    seen.add(name);
    const parsedReset = resetsAtIso ? Date.parse(resetsAtIso) : NaN;
    const resetsAt = Number.isFinite(parsedReset) ? Math.floor(parsedReset / 1_000) : undefined;
    windows.push({
      name,
      usedPercent: Math.round(percent),
      windowDurationMins: duration,
      resetsAt,
      resetsAtIso: resetsAt === undefined ? undefined : resetsAtIso,
    });
  };

  const limits = Array.isArray(usage.limits) ? usage.limits : [];
  for (const raw of limits) {
    if (!isRecord(raw)) continue;
    const percent = finiteNumber(raw.percent);
    if (percent === undefined) continue;
    const kind = nonEmptyString(raw.kind) ?? "limit";
    const scope = isRecord(raw.scope) ? raw.scope : undefined;
    const model = scope && isRecord(scope.model) ? scope.model : undefined;
    const modelName = model ? nonEmptyString(model.display_name) : undefined;
    const reset = nonEmptyString(raw.resets_at);
    if (kind === "session") push("5h", percent, reset, 300);
    else if (kind === "weekly_all") push("7d", percent, reset, 10_080);
    else if (kind === "weekly_scoped") push(modelName ? `7d ${modelName}` : "7d (scoped)", percent, reset);
    else push(modelName ? `${kind} ${modelName}` : kind, percent, reset);
  }
  if (windows.length > 0) return windows;

  // Older response shape: five_hour, seven_day, seven_day_<model>, ...
  for (const [key, raw] of Object.entries(usage)) {
    if (!isRecord(raw)) continue;
    const percent = finiteNumber(raw.utilization);
    if (percent === undefined) continue;
    const reset = nonEmptyString(raw.resets_at);
    if (key === "five_hour") push("5h", percent, reset, 300);
    else if (key === "seven_day") push("7d", percent, reset, 10_080);
    else push(key.replace(/^seven_day_/, "7d "), percent, reset);
  }
  return windows;
}

export async function collectClaudeUsage(options: {
  readToken?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<ClaudeUsageResponse> {
  const base = { source: "claude-oauth-usage" as const, refreshedAt: new Date().toISOString(), windows: [] };
  if (process.env.JINN_CLAUDE_USAGE_API === "off") {
    return { ...base, available: false, unavailableReason: "disabled" };
  }
  const token = await (options.readToken ?? readClaudeOAuthToken)();
  if (!token) return { ...base, available: false, unavailableReason: "no-oauth-credentials" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) return { ...base, available: false, unavailableReason: "provider-unavailable" };
    const body = await response.json() as unknown;
    const windows = isRecord(body) ? windowsFromClaudeUsage(body) : [];
    return windows.length > 0
      ? { ...base, available: true, windows }
      : { ...base, available: false, unavailableReason: "provider-unavailable" };
  } catch {
    // Fixed reason only: never expose a provider response or credential detail.
    return { ...base, available: false, unavailableReason: "provider-unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
