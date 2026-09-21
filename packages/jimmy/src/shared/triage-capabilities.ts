import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { SKILLS_DIR } from "./paths.js";
import { redactText } from "./redact.js";
import type { Employee } from "./types.js";

/** Descriptive evidence only: installation does not prove credentials, permission, or readiness. */
export interface TriageCapabilitySnapshot {
  role?: string;
  skills: Array<{ name: string; description: string }>;
  services?: Array<{ name: string; description: string }>;
  /** The snapshot is not an exhaustive statement of what the assistant can do. */
  truncated?: boolean;
}

export const TRIAGE_CAPABILITY_LIMITS = {
  cacheTtlMs: 30_000,
  headerBytes: 8192,
  candidateCount: 128,
  directoryEntries: 512,
  catalogChars: 32_768,
  snapshotSkills: 24,
  snapshotServices: 8,
  snapshotChars: 6000,
  nameChars: 80,
  descriptionChars: 240,
  roleChars: 800,
} as const;

type Capability = TriageCapabilitySnapshot["skills"][number];
interface Catalog { skills: Capability[]; truncated: boolean }
interface CacheEntry { catalog: Catalog; expiresAt: number }
const catalogs = new Map<string, CacheEntry>();

/** A watcher may invalidate all roots; tests can invalidate just their fixture root. */
export function invalidateTriageCapabilities(skillsDir?: string): void {
  if (skillsDir === undefined) catalogs.clear();
  else catalogs.delete(path.resolve(skillsDir));
}

function metadataText(value: unknown, limit: number): { text: string; truncated: boolean } {
  if (typeof value !== "string") return { text: "", truncated: false };
  // Bound redaction work too. This allowlist never reads credentials, MCP config,
  // skill bodies, or memory; redact accidental secrets in descriptive fields.
  const prefix = value.slice(0, TRIAGE_CAPABILITY_LIMITS.headerBytes);
  const clean = redactText(prefix)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[REDACTED]")
    .replace(/\bapikey_[A-Za-z0-9_]+/gi, "[REDACTED]")
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, "[REDACTED]")
    .replace(/\b(?:https?|ssh|file):\/\/[^\s<>"']+/gi, "[URL]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim();
  return { text: clean.slice(0, limit), truncated: value.length > prefix.length || clean.length > limit };
}

function readSkill(skillDir: string, directoryName: string): { skill?: Capability; truncated: boolean } {
  let fd: number | undefined;
  try {
    // Shared skill-directory symlinks are supported. A SKILL.md symlink may
    // point within that skill, but cannot be used to read some unrelated file.
    const realDir = fs.realpathSync(skillDir);
    if (!fs.statSync(realDir).isDirectory()) return { truncated: true };
    const realFile = fs.realpathSync(path.join(realDir, "SKILL.md"));
    const relative = path.relative(realDir, realFile);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      return { truncated: true };
    }
    fd = fs.openSync(realFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    if (!fs.fstatSync(fd).isFile()) return { truncated: true };
    const buffer = Buffer.alloc(TRIAGE_CAPABILITY_LIMITS.headerBytes);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const header = buffer.toString("utf8", 0, read).match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    // Never fall back to Trigger/body paragraphs: those can contain operational
    // instructions or private examples. Oversized/malformed headers are omitted.
    if (!header) return { truncated: true };
    const parsed = yaml.load(header[1], { schema: yaml.JSON_SCHEMA });
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { truncated: true };
    const fields = parsed as Record<string, unknown>;
    const name = metadataText(typeof fields.name === "string" ? fields.name : directoryName, TRIAGE_CAPABILITY_LIMITS.nameChars);
    const description = metadataText(fields.description, TRIAGE_CAPABILITY_LIMITS.descriptionChars);
    if (!name.text) return { truncated: true };
    return { skill: { name: name.text, description: description.text }, truncated: name.truncated || description.truncated };
  } catch {
    // No paths or file contents go into logs. Missing/broken skills are evidence
    // of an incomplete catalog, not a gateway or triage failure.
    return { truncated: true };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* No file data in errors. */ } }
  }
}

function loadCatalog(skillsDir: string): Catalog {
  const result: Catalog = { skills: [], truncated: false };
  let dir: fs.Dir | undefined;
  try {
    dir = fs.opendirSync(skillsDir);
    let entries = 0;
    let candidates = 0;
    let chars = 0;
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++entries > TRIAGE_CAPABILITY_LIMITS.directoryEntries) { result.truncated = true; break; }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (++candidates > TRIAGE_CAPABILITY_LIMITS.candidateCount) { result.truncated = true; break; }
      const loaded = readSkill(path.join(skillsDir, entry.name), entry.name);
      result.truncated ||= loaded.truncated;
      if (!loaded.skill) continue;
      chars += loaded.skill.name.length + loaded.skill.description.length;
      if (chars > TRIAGE_CAPABILITY_LIMITS.catalogChars) { result.truncated = true; break; }
      result.skills.push(loaded.skill);
    }
  } catch {
    result.truncated = true;
  } finally {
    try { dir?.closeSync(); } catch { result.truncated = true; }
  }
  result.skills.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

function normalized(text: string): string { return text.normalize("NFKC").toLowerCase(); }

/** Cheap lexical selection, not another classifier or an assertion of relevance. */
function relevance(skill: Capability, message: string): number {
  if (!message) return 0;
  const name = normalized(skill.name);
  const description = normalized(skill.description);
  let score = name.length > 1 && message.includes(name) ? 20 : 0;
  const terms = new Set(`${name} ${description}`.match(/[a-z0-9][a-z0-9_+-]{1,}/g) ?? []);
  for (const term of terms) if (message.includes(term)) score += name.includes(term) ? 4 : 2;
  const grams = new Set<string>();
  for (const part of `${name} ${description}`.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu) ?? []) {
    for (let i = 0; i < part.length - 1; i++) grams.add(part.slice(i, i + 2));
  }
  for (const gram of grams) if (message.includes(gram)) score++;
  return score;
}

export interface TriageCapabilityOptions {
  employee?: Pick<Employee, "persona" | "provides">;
  personaOverride?: string;
  messageText?: string;
  /** Test injection; production uses the current instance's SKILLS_DIR. */
  skillsDir?: string;
  /** Test injection; milliseconds since epoch. */
  now?: number;
}

export function getTriageCapabilities(options: TriageCapabilityOptions = {}): TriageCapabilitySnapshot {
  const root = path.resolve(options.skillsDir ?? SKILLS_DIR);
  const now = options.now ?? Date.now();
  let cached = catalogs.get(root);
  if (!cached || now >= cached.expiresAt || now < cached.expiresAt - TRIAGE_CAPABILITY_LIMITS.cacheTtlMs) {
    cached = { catalog: loadCatalog(root), expiresAt: now + TRIAGE_CAPABILITY_LIMITS.cacheTtlMs };
    // Production has one instance root; bound injected/multi-root use as well.
    if (!catalogs.has(root) && catalogs.size >= 8) catalogs.delete(catalogs.keys().next().value!);
    catalogs.set(root, cached);
  }
  const result: TriageCapabilitySnapshot = { skills: [] };
  let truncated = cached.catalog.truncated;
  let remaining = TRIAGE_CAPABILITY_LIMITS.snapshotChars;
  const override = typeof options.personaOverride === "string" ? options.personaOverride.trim() : undefined;
  const role = metadataText(override || options.employee?.persona, TRIAGE_CAPABILITY_LIMITS.roleChars);
  if (role.text) { result.role = role.text; remaining -= role.text.length; }
  truncated ||= role.truncated;
  const services = options.employee?.provides;
  if (Array.isArray(services)) {
    result.services = [];
    truncated ||= services.length > TRIAGE_CAPABILITY_LIMITS.snapshotServices;
    for (const service of services.slice(0, TRIAGE_CAPABILITY_LIMITS.snapshotServices)) {
      if (!service || typeof service !== "object") { truncated = true; continue; }
      const name = metadataText(service.name, TRIAGE_CAPABILITY_LIMITS.nameChars);
      const description = metadataText(service.description, TRIAGE_CAPABILITY_LIMITS.descriptionChars);
      if (!name.text) { truncated = true; continue; }
      result.services.push({ name: name.text, description: description.text });
      remaining -= name.text.length + description.text.length;
      truncated ||= name.truncated || description.truncated;
    }
  }
  // The user's text is used only locally for selection and is never cached.
  const message = normalized((options.messageText ?? "").slice(0, 4000));
  const ranked = cached.catalog.skills.map((skill) => ({ skill, score: relevance(skill, message) }))
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  for (const { skill } of ranked) {
    const size = skill.name.length + skill.description.length;
    if (result.skills.length >= TRIAGE_CAPABILITY_LIMITS.snapshotSkills || size > remaining) { truncated = true; continue; }
    result.skills.push({ ...skill });
    remaining -= size;
  }
  if (truncated) result.truncated = true;
  return result;
}
