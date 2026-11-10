import fs from "node:fs";
import { logger } from "./logger.js";
import type { ClaudeEndpointConfig, ModelInfo } from "./types.js";

/**
 * `engines.claude.endpoints` — Anthropic-compatible servers that serve specific
 * models, such as an oMLX instance on another machine:
 *
 *   engines:
 *     claude:
 *       endpoints:
 *         - name: local-mac
 *           baseUrl: http://100.64.0.10:1236
 *           apiKeyFile: /path/to/.ryoko/secrets/local-mac.env
 *           apiKeyEnv: LOCAL_MAC_API_KEY
 *           models: [my-local-model]
 *
 * A local `claude -p` run of one of those models gets that server's URL and key
 * and none of the gateway's own ANTHROPIC_* settings, so neither the request nor
 * the subscription credentials can land on Anthropic. A model declared by an
 * entry that failed validation is held back (its runs fail) for the same reason.
 * Every other model is untouched.
 */

export interface ResolvedEndpointModel {
  id: string;
  label?: string;
  contextWindow?: number;
  supportsEffort?: boolean;
  effortLevels?: string[];
}

export interface ResolvedClaudeEndpoint {
  name: string;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  /** Let the engine fallback hand a failed turn to another engine. Default false. */
  fallback: boolean;
  models: ResolvedEndpointModel[];
}

/** Uppercase env-style names only, so a bare key such as `abc==` is not read as a pair. */
const KEY_LINE = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/;

let configured: ResolvedClaudeEndpoint[] = [];
let reserved = new Set<string>();
/** engines.claude.model — what a session without its own model runs. */
let defaultClaudeModel: string | undefined;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeModel(raw: unknown): ResolvedEndpointModel | undefined {
  if (typeof raw === "string") return nonEmptyString(raw) ? { id: raw.trim() } : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const id = nonEmptyString(m.id);
  if (!id) return undefined;
  return {
    id,
    ...(nonEmptyString(m.label) ? { label: nonEmptyString(m.label) } : {}),
    ...(typeof m.contextWindow === "number" && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
    ...(m.supportsEffort === true ? { supportsEffort: true } : {}),
    ...(Array.isArray(m.effortLevels) ? { effortLevels: m.effortLevels.filter((e): e is string => typeof e === "string") } : {}),
  };
}

function declaredModels(entry: unknown): ResolvedEndpointModel[] {
  const models = entry && typeof entry === "object" ? (entry as { models?: unknown }).models : undefined;
  return Array.isArray(models) ? models.map(normalizeModel).filter((m): m is ResolvedEndpointModel => !!m) : [];
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[::1\]$)|\.(local|ts\.net|internal)$/;

/** The base URL, or why it is unusable. */
function checkBaseUrl(raw: unknown): { url: string } | { problem: string } {
  const value = nonEmptyString(raw);
  if (!value) return { problem: "baseUrl is missing" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: "baseUrl is not a URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { problem: "baseUrl must be http(s)" };
  if (url.username || url.password) return { problem: "baseUrl must not carry credentials — use apiKeyEnv or apiKeyFile" };
  if (url.search || url.hash) return { problem: "baseUrl must not have a query or fragment" };
  const trimmed = value.replace(/\/+$/, "");
  if (/\/v1$/.test(trimmed)) return { problem: "baseUrl must not end in /v1 (the CLI adds it)" };
  return { url: trimmed };
}

/** Validate `engines.claude.endpoints`; invalid entries are skipped with a warning. */
export function normalizeClaudeEndpoints(raw: unknown, opts: { quiet?: boolean } = {}): ResolvedClaudeEndpoint[] {
  const warn = (message: string) => { if (!opts.quiet) logger.warn(`engines.claude.endpoints: ${message}`); };
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn("must be a list — ignoring it");
    return [];
  }

  const seen = new Map<string, string>();
  const endpoints: ResolvedClaudeEndpoint[] = [];
  raw.forEach((entry: unknown, index) => {
    const e = (entry && typeof entry === "object" ? entry : {}) as Partial<Record<keyof ClaudeEndpointConfig, unknown>>;
    const name = nonEmptyString(e.name) ?? `#${index + 1}`;
    const base = checkBaseUrl(e.baseUrl);
    const apiKeyEnv = nonEmptyString(e.apiKeyEnv);
    const apiKeyFile = nonEmptyString(e.apiKeyFile);
    const models = declaredModels(entry);

    if ("problem" in base) return warn(`${name}: ${base.problem} — skipping it; its models will fail rather than go to Anthropic`);
    if (models.length === 0) return warn(`${name}: lists no models — skipping it`);
    if (!apiKeyEnv && !apiKeyFile) return warn(`${name}: needs apiKeyEnv or apiKeyFile — skipping it; its models will fail rather than go to Anthropic`);
    const host = new URL(base.url).hostname;
    if (base.url.startsWith("http:") && !PRIVATE_HOST.test(host)) {
      warn(`${name}: ${host} is reached over plain http, so its API key travels unencrypted — prefer https or a private network`);
    }

    const unique = models.filter((model) => {
      const owner = seen.get(model.id);
      if (owner) {
        warn(`${name}: model ${model.id} is already served by ${owner} — keeping ${owner}`);
        return false;
      }
      seen.set(model.id, name);
      return true;
    });
    endpoints.push({
      name,
      baseUrl: base.url,
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(apiKeyFile ? { apiKeyFile } : {}),
      fallback: e.fallback === true,
      models: unique,
    });
  });
  return endpoints;
}

/** Called by the gateway at boot and on config reload; applies to new runs. */
export function configureClaudeEndpoints(raw: unknown, defaultModel?: string): void {
  defaultClaudeModel = nonEmptyString(defaultModel);
  configured = normalizeClaudeEndpoints(raw);
  const served = new Set(configured.flatMap((endpoint) => endpoint.models.map((m) => m.id)));
  const declared = Array.isArray(raw) ? raw.flatMap((entry: unknown) => declaredModels(entry).map((m) => m.id)) : [];
  reserved = new Set(declared.filter((id) => !served.has(id)));
  for (const endpoint of configured) {
    logger.info(`Claude endpoint ${endpoint.name} → ${endpoint.baseUrl} serves ${endpoint.models.map((m) => m.id).join(", ")}`);
  }
}

export function findClaudeEndpoint(model: string | null | undefined): ResolvedClaudeEndpoint | undefined {
  if (!model) return undefined;
  return configured.find((endpoint) => endpoint.models.some((m) => m.id === model));
}

/** True when an `engine` turn for `model` (null: the engine's default model)
 *  belongs to an endpoint, not to Anthropic. Such turns say nothing about the
 *  Anthropic account's login or allowance. */
export function isClaudeEndpointRun(engine: string | undefined, model: string | null | undefined): boolean {
  const effective = model ?? defaultClaudeModel;
  return engine === "claude" && !!effective && (!!findClaudeEndpoint(effective) || reserved.has(effective));
}

/** Whether a failed endpoint turn may be handed to another engine (opt-in per endpoint). */
export function claudeEndpointAllowsFallback(model: string | null | undefined): boolean {
  return findClaudeEndpoint(model ?? defaultClaudeModel)?.fallback === true;
}

function unquote(value: string): string {
  if (/^(['"]).*\1$/.test(value)) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, "");
}

/** Key from a file: the line named by `envName` (or the only KEY=VALUE line), else the bare content. */
function keyFromFile(file: string, envName: string | undefined): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const pairs = lines.map((l) => KEY_LINE.exec(l)).filter((m): m is RegExpExecArray => !!m);
  if (pairs.length > 0) {
    const pair = envName ? pairs.find((m) => m[1] === envName) : pairs.length === 1 ? pairs[0] : undefined;
    return pair ? nonEmptyString(unquote(pair[2])) : undefined;
  }
  return lines.length === 1 ? nonEmptyString(unquote(lines[0])) : undefined;
}

function resolveKey(endpoint: ResolvedClaudeEndpoint, env: NodeJS.ProcessEnv): string {
  const fromEnv = endpoint.apiKeyEnv ? nonEmptyString(env[endpoint.apiKeyEnv]) : undefined;
  const key = fromEnv ?? (endpoint.apiKeyFile ? keyFromFile(endpoint.apiKeyFile, endpoint.apiKeyEnv) : undefined);
  if (key) return key;
  const sources = [
    endpoint.apiKeyEnv ? `environment variable ${endpoint.apiKeyEnv}` : undefined,
    endpoint.apiKeyFile ? `file ${endpoint.apiKeyFile}` : undefined,
  ].filter(Boolean).join(" or ");
  logger.error(`Claude endpoint ${endpoint.name}: no API key found (looked in ${sources})`);
  throw new Error(`Claude endpoint ${endpoint.name} has no API key — see the gateway log`);
}

/**
 * Extra env for a local `claude -p` run of `model`: null when no endpoint serves
 * it. Throws when the model belongs to an endpoint whose key is missing or whose
 * entry is invalid, so the run fails instead of reaching Anthropic. Claude Code's
 * own secondary model calls (subagents, background tasks) use the same model.
 */
export function claudeEndpointEnvFor(model: string | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> | null {
  if (model && reserved.has(model)) {
    throw new Error(`Model ${model} is declared in engines.claude.endpoints by an entry that is not valid — see the gateway log`);
  }
  const endpoint = findClaudeEndpoint(model);
  if (!endpoint || !model) return null;
  return {
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    ANTHROPIC_API_KEY: resolveKey(endpoint, env),
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/**
 * `base` with the endpoint for `model` applied: every inherited ANTHROPIC_* value
 * is dropped and the endpoint's are added. Unchanged when no endpoint serves the
 * model. Throws like claudeEndpointEnvFor.
 */
export function withClaudeEndpointEnv<T extends Record<string, string | undefined>>(base: T, model: string | undefined): T | Record<string, string | undefined> {
  const endpointEnv = claudeEndpointEnvFor(model);
  if (!endpointEnv) return base;
  const kept = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith("ANTHROPIC_")));
  return { ...kept, ...endpointEnv };
}

/** Picker entries for the models the endpoints serve (registry input). */
export function claudeEndpointModels(raw: unknown): ModelInfo[] {
  return normalizeClaudeEndpoints(raw, { quiet: true }).flatMap((endpoint) =>
    endpoint.models.map((m) => {
      const supportsEffort = m.supportsEffort === true;
      return {
        id: m.id,
        label: m.label ?? `${m.id} (${endpoint.name})`,
        supportsEffort,
        effortLevels: supportsEffort ? [...(m.effortLevels ?? [])] : [],
        ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      };
    }),
  );
}

/** Test-only: forget the configured endpoints. */
export function resetClaudeEndpointsForTests(): void {
  configured = [];
  reserved = new Set();
  defaultClaudeModel = undefined;
}
