/**
 * Private hot-reloadable API keys for decision-model providers (Jev triage).
 * One owner-only file per provider; keys never go into config, logs, or responses.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { JINN_HOME } from "./paths.js";

export const DECISION_PROVIDERS = ["typesafe", "openrouter", "openai"] as const;
export type DecisionProvider = typeof DECISION_PROVIDERS[number];

/** Default environment fallback per provider. */
export const DECISION_KEY_ENV: Readonly<Record<DecisionProvider, string>> = {
  typesafe: "TYPESAFE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_KEY_LENGTH = 4096;
const MAX_FILE_BYTES = 8192;

export interface DecisionCredentialStatus {
  configured: boolean;
  source: "stored" | "environment" | "none";
}

export class DecisionCredentialError extends Error {
  constructor(readonly code: "invalid_key" | "storage_unavailable") { super(code); }
}

export function isDecisionProvider(value: unknown): value is DecisionProvider {
  return typeof value === "string" && (DECISION_PROVIDERS as readonly string[]).includes(value);
}

/** The provider is checked against the fixed list, so it can never form an arbitrary path. */
export function decisionCredentialPath(provider: DecisionProvider, home = JINN_HOME): string {
  if (!isDecisionProvider(provider)) throw new DecisionCredentialError("storage_unavailable");
  return path.join(home, "credentials", `${provider}.json`);
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= MAX_KEY_LENGTH && Buffer.byteLength(value) <= MAX_KEY_LENGTH
    && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value);
}

function storedKey(provider: DecisionProvider, home: string): string | undefined {
  try {
    const directory = path.join(home, "credentials");
    if (!fs.lstatSync(directory).isDirectory()) return;
    const file = decisionCredentialPath(provider, home);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
    const raw = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const credential = parsed as Record<string, unknown>;
    if (credential.version !== 1 || Object.keys(credential).some((key) => key !== "version" && key !== "apiKey")) return;
    return validKey(credential.apiKey) ? credential.apiKey : undefined;
  } catch { return undefined; }
}

/**
 * The provider's default env uses the dashboard credential first. A custom env
 * name is an explicit isolated choice and never falls back to the stored key.
 */
export function resolveDecisionApiKey(
  provider: DecisionProvider, apiKeyEnv?: string, home = JINN_HOME,
): string | undefined {
  if (!isDecisionProvider(provider)) return;
  const defaultEnv = DECISION_KEY_ENV[provider];
  const envName = apiKeyEnv ?? defaultEnv;
  if (!ENV_NAME.test(envName)) return;
  if (envName === defaultEnv) {
    const saved = storedKey(provider, home);
    if (saved) return saved;
  }
  const value = process.env[envName]?.trim();
  return validKey(value) ? value : undefined;
}

export function getDecisionCredentialStatus(provider: DecisionProvider, home = JINN_HOME): DecisionCredentialStatus {
  if (!isDecisionProvider(provider)) return { configured: false, source: "none" };
  if (storedKey(provider, home)) return { configured: true, source: "stored" };
  const environment = process.env[DECISION_KEY_ENV[provider]]?.trim();
  return validKey(environment) ? { configured: true, source: "environment" } : { configured: false, source: "none" };
}

export function saveDecisionApiKey(provider: DecisionProvider, apiKey: unknown, home = JINN_HOME): DecisionCredentialStatus {
  // Reject controls before trimming so CR/LF cannot become a hidden accepted key.
  if (typeof apiKey !== "string" || /[\x00-\x1f\x7f-\x9f]/.test(apiKey)) throw new DecisionCredentialError("invalid_key");
  const normalized = apiKey.trim();
  if (!validKey(normalized)) throw new DecisionCredentialError("invalid_key");
  let temporary: string | undefined;
  try {
    const file = decisionCredentialPath(provider, home);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) throw new DecisionCredentialError("storage_unavailable");
    temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, apiKey: normalized }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    return { configured: true, source: "stored" };
  } catch {
    throw new DecisionCredentialError("storage_unavailable");
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* atomically renamed or already gone */ } }
  }
}

/** Remove only the dashboard credential. Existing environment configuration is retained. */
export function deleteDecisionApiKey(provider: DecisionProvider, home = JINN_HOME): DecisionCredentialStatus {
  try {
    const directory = path.join(home, "credentials");
    if (fs.existsSync(directory) && !fs.lstatSync(directory).isDirectory()) throw new DecisionCredentialError("storage_unavailable");
    fs.unlinkSync(decisionCredentialPath(provider, home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw new DecisionCredentialError("storage_unavailable");
  }
  return getDecisionCredentialStatus(provider, home);
}
