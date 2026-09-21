/** Private hot-reloadable TypeSafe credential storage. Never place keys in config or logs. */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { JINN_HOME } from "./paths.js";

const DEFAULT_KEY_ENV = "TYPESAFE_API_KEY";
const MAX_KEY_LENGTH = 4096;
const MAX_FILE_BYTES = 8192;
export interface TypeSafeCredentialStatus {
  configured: boolean;
  source: "stored" | "environment" | "none";
}
export class TypeSafeCredentialError extends Error {
  constructor(readonly code: "invalid_key" | "storage_unavailable") { super(code); }
}

export function typeSafeCredentialPath(home = JINN_HOME): string {
  return path.join(home, "credentials", "typesafe.json");
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= MAX_KEY_LENGTH && Buffer.byteLength(value) <= MAX_KEY_LENGTH
    && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value);
}

function storedKey(home: string): string | undefined {
  try {
    const directory = path.join(home, "credentials");
    if (!fs.lstatSync(directory).isDirectory()) return;
    const file = typeSafeCredentialPath(home);
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

/** Default env uses the UI credential first. A custom env is an explicit isolated choice. */
export function resolveTypeSafeApiKey(apiKeyEnv = DEFAULT_KEY_ENV, home = JINN_HOME): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) return;
  if (apiKeyEnv === DEFAULT_KEY_ENV) {
    const saved = storedKey(home);
    if (saved) return saved;
  }
  const value = process.env[apiKeyEnv]?.trim();
  return validKey(value) ? value : undefined;
}

export function getTypeSafeCredentialStatus(home = JINN_HOME): TypeSafeCredentialStatus {
  if (storedKey(home)) return { configured: true, source: "stored" };
  const environment = process.env[DEFAULT_KEY_ENV]?.trim();
  return validKey(environment) ? { configured: true, source: "environment" } : { configured: false, source: "none" };
}

export function saveTypeSafeApiKey(apiKey: unknown, home = JINN_HOME): TypeSafeCredentialStatus {
  // Reject controls before trimming so CR/LF cannot become a hidden accepted key.
  if (typeof apiKey !== "string" || /[\x00-\x1f\x7f-\x9f]/.test(apiKey)) throw new TypeSafeCredentialError("invalid_key");
  const normalized = apiKey.trim();
  if (!validKey(normalized)) throw new TypeSafeCredentialError("invalid_key");
  let temporary: string | undefined;
  try {
    const file = typeSafeCredentialPath(home);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) throw new TypeSafeCredentialError("storage_unavailable");
    temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, apiKey: normalized }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    return { configured: true, source: "stored" };
  } catch {
    throw new TypeSafeCredentialError("storage_unavailable");
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* atomically renamed or already gone */ } }
  }
}

/** Remove only the dashboard credential. Existing environment configuration is retained. */
export function deleteTypeSafeApiKey(home = JINN_HOME): TypeSafeCredentialStatus {
  try {
    const directory = path.join(home, "credentials");
    if (fs.existsSync(directory) && !fs.lstatSync(directory).isDirectory()) throw new TypeSafeCredentialError("storage_unavailable");
    fs.unlinkSync(typeSafeCredentialPath(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw new TypeSafeCredentialError("storage_unavailable");
  }
  return getTypeSafeCredentialStatus(home);
}
