/**
 * Peer Ryokos on disk: each is an employee YAML at `org/ryokos/<name>.yaml`
 * (department ryokos, rank executive, no reportsTo) with a `peer` block, and
 * with memory "own" a `ryokos/<name>/` folder holding its MEMORY.md and
 * knowledge/. Memory files are never deleted here.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { JINN_HOME, ORG_DIR } from "../../shared/paths.js";
import {
  isPeer, isPeerMemoryMode, isPeerName, MAIN_RYOKO, PEER_DEPARTMENT, PEER_NAME_PATTERN, peerHomeDir, peerKnowledgeDir, peerMemoryPath,
  peerSlackInstanceId, peerYamlPath,
} from "../../shared/peer-ryoko.js";
import type { Employee, JinnConfig, PeerMemoryMode } from "../../shared/types.js";
import { scanOrg } from "../org.js";
import { instanceOf } from "../slack-instance-connect.js";

export const PEER_ENGINES = ["claude", "codex"] as const;
export type PeerEngine = (typeof PEER_ENGINES)[number];

export interface RyokoSummary {
  name: string;
  displayName: string;
  emoji?: string;
  persona?: string;
  engine?: string;
  model?: string;
  memory: "main" | PeerMemoryMode;
  primary: boolean;
  slack: { connected: boolean; instanceId?: string };
}

export interface RyokoFields {
  displayName: string;
  /** null clears it (on update). */
  emoji: string | null;
  persona: string;
  engine: PeerEngine;
  /** null clears it (on update): the engine default applies. */
  model: string | null;
  memory: PeerMemoryMode;
}

export type RyokoInput = Partial<RyokoFields>;

const LIMITS = { displayName: 40, emoji: 8, persona: 4000, model: 80 } as const;
/** Model ids go to the engine CLI: plain id characters only. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;

const length = (text: string): number => Array.from(text).length;

type Validated = { ok: true; value: RyokoInput } | { ok: false; message: string };

/** Check a create (all required fields) or update (all optional) body. */
export function validateRyokoInput(body: unknown, mode: "create" | "update"): Validated {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: "body must be a JSON object" };
  const raw = body as Record<string, unknown>;
  const value: RyokoInput = {};
  const required = mode === "create";

  if (raw.displayName !== undefined || required) {
    const name = typeof raw.displayName === "string" ? raw.displayName.trim() : "";
    if (!name || length(name) > LIMITS.displayName) return { ok: false, message: `displayName is required (1–${LIMITS.displayName} characters)` };
    value.displayName = name;
  }
  if (raw.persona !== undefined || required) {
    const persona = typeof raw.persona === "string" ? raw.persona.trim() : "";
    if (!persona || length(persona) > LIMITS.persona) return { ok: false, message: `persona is required (1–${LIMITS.persona} characters)` };
    value.persona = persona;
  }
  if (raw.engine !== undefined || required) {
    if (!(PEER_ENGINES as readonly unknown[]).includes(raw.engine)) return { ok: false, message: `engine must be one of ${PEER_ENGINES.join(", ")}` };
    value.engine = raw.engine as PeerEngine;
  }
  if (raw.memory !== undefined || required) {
    if (!isPeerMemoryMode(raw.memory)) return { ok: false, message: "memory must be \"shared\" or \"own\"" };
    value.memory = raw.memory;
  }
  if (raw.emoji !== undefined) {
    if (raw.emoji !== null && typeof raw.emoji !== "string") return { ok: false, message: "emoji must be a string" };
    const emoji = typeof raw.emoji === "string" ? raw.emoji.trim() : "";
    if (length(emoji) > LIMITS.emoji) return { ok: false, message: `emoji must be at most ${LIMITS.emoji} characters` };
    value.emoji = emoji || null;
  }
  if (raw.model !== undefined) {
    if (raw.model !== null && typeof raw.model !== "string") return { ok: false, message: "model must be a string" };
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    if (model && (model.length > LIMITS.model || !MODEL_PATTERN.test(model))) {
      return { ok: false, message: `model must be a model id (at most ${LIMITS.model} characters)` };
    }
    value.model = model || null;
  }
  return { ok: true, value };
}

function namesIn(dir: string, suffix: string): string[] {
  try {
    return fs.readdirSync(dir).flatMap((entry) => (entry.endsWith(suffix) ? [entry.slice(0, entry.length - suffix.length)] : []));
  } catch {
    return []; // the folder does not exist yet
  }
}

/**
 * Every name a new peer may not take: employees, "main", files already in
 * org/ryokos/, and what a deleted peer left behind — its memory folder
 * (ryokos/<name>/) and its Slack app record (slack-apps/<name>.json) — so a
 * new Ryoko never inherits another one's memory or Slack app.
 */
function takenNames(orgDir: string, home: string): Set<string> {
  return new Set<string>([
    MAIN_RYOKO,
    ...scanOrg().keys(),
    ...namesIn(path.join(orgDir, PEER_DEPARTMENT), ".yaml"),
    ...namesIn(path.join(home, "ryokos"), ""),
    ...namesIn(path.join(home, "slack-apps"), ".json"),
  ]);
}

/** A slug from the display name; `ryoko-2`, `ryoko-3`… when it has no latin letters or digits. */
export function slugFor(displayName: string, taken: ReadonlySet<string>): string {
  const base = displayName.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
  if (isPeerName(base) && !taken.has(base)) return base;
  // "main" is a valid stem, only not a name of its own.
  const stem = PEER_NAME_PATTERN.test(base) ? base : "ryoko";
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${stem.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (isPeerName(candidate) && !taken.has(candidate)) return candidate;
  }
}

function writeYamlAtomic(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, yaml.dump(data, { lineWidth: -1 }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** The memory folder for memory "own": created once, never overwritten or removed. */
function ensureOwnMemory(name: string, home: string): void {
  fs.mkdirSync(peerKnowledgeDir(name, home), { recursive: true, mode: 0o700 });
  const memory = peerMemoryPath(name, home);
  if (!fs.existsSync(memory)) fs.writeFileSync(memory, "", { mode: 0o600, flag: "wx" });
}

function applyFields(data: Record<string, unknown>, input: RyokoInput): Record<string, unknown> {
  const next: Record<string, unknown> = { ...data };
  if (input.displayName !== undefined) next.displayName = input.displayName;
  if (input.persona !== undefined) next.persona = input.persona;
  if (input.engine !== undefined) next.engine = input.engine;
  if (input.memory !== undefined) next.peer = { memory: input.memory };
  if (input.emoji === null) delete next.emoji;
  else if (input.emoji !== undefined) next.emoji = input.emoji;
  if (input.model === null) delete next.model;
  else if (input.model !== undefined) next.model = input.model;
  return next;
}

let chain: Promise<unknown> = Promise.resolve();

/** Name choice → write runs one at a time, so two creates cannot pick the same name. */
function serialized<T>(fn: () => T): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export interface StoreDirs { orgDir?: string; home?: string }

export function createPeer(input: RyokoFields | RyokoInput, dirs: StoreDirs = {}): Promise<Employee> {
  const orgDir = dirs.orgDir ?? ORG_DIR;
  const home = dirs.home ?? JINN_HOME;
  return serialized(() => {
    const name = slugFor(input.displayName ?? "", takenNames(orgDir, home));
    const data = applyFields({
      name, department: PEER_DEPARTMENT, rank: "executive",
    }, input);
    if (input.memory === "own") ensureOwnMemory(name, home);
    writeYamlAtomic(peerYamlPath(name, orgDir), data);
    return toEmployee(data);
  });
}

function readPeerYaml(name: string, orgDir: string): Record<string, unknown> | null {
  if (!isPeerName(name)) return null;
  let data: unknown;
  try {
    data = yaml.load(fs.readFileSync(peerYamlPath(name, orgDir), "utf8"));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || (data as Record<string, unknown>).name !== name) return null;
  return isPeer(toEmployee(data as Record<string, unknown>)) ? (data as Record<string, unknown>) : null;
}

/** null when no peer of that name is managed in org/ryokos/. */
export function updatePeer(name: string, input: RyokoInput, dirs: StoreDirs = {}): Promise<Employee | null> {
  const orgDir = dirs.orgDir ?? ORG_DIR;
  const home = dirs.home ?? JINN_HOME;
  return serialized(() => {
    const data = readPeerYaml(name, orgDir);
    if (!data) return null;
    const next = applyFields(data, input);
    // Switching to "own" (again) makes sure its folder exists; switching to
    // "shared" keeps the own files on disk.
    if (input.memory === "own") ensureOwnMemory(name, home);
    writeYamlAtomic(peerYamlPath(name, orgDir), next);
    return toEmployee(next);
  });
}

/** Removes the YAML only. null when there was no such peer. */
export function deletePeerYaml(name: string, dirs: StoreDirs = {}): Promise<{ keptMemory: boolean } | null> {
  const orgDir = dirs.orgDir ?? ORG_DIR;
  const home = dirs.home ?? JINN_HOME;
  return serialized(() => {
    if (!readPeerYaml(name, orgDir)) return null;
    fs.rmSync(peerYamlPath(name, orgDir));
    return { keptMemory: fs.existsSync(peerHomeDir(name, home)) };
  });
}

/**
 * The one "does this peer Ryoko exist" check, used by the Ryokos API, the
 * Slack setup routes and the Slack connect: a valid peer name (never "main")
 * whose YAML in org/ryokos/ parses with a valid `peer` block.
 */
export function peerExists(name: unknown, dirs: StoreDirs = {}): name is string {
  return isPeerName(name) && readPeerYaml(name, dirs.orgDir ?? ORG_DIR) !== null;
}

/** The same normalization scanOrg applies, for a document just written. */
function toEmployee(data: Record<string, unknown>): Employee {
  const memory = (data.peer as Record<string, unknown> | undefined)?.memory;
  return {
    name: String(data.name),
    displayName: typeof data.displayName === "string" && data.displayName ? data.displayName : String(data.name),
    department: typeof data.department === "string" ? data.department : PEER_DEPARTMENT,
    rank: "executive",
    engine: typeof data.engine === "string" ? data.engine : "claude",
    model: typeof data.model === "string" ? data.model.trim() || undefined : undefined,
    persona: typeof data.persona === "string" ? data.persona : "",
    emoji: typeof data.emoji === "string" ? data.emoji : undefined,
    ...(isPeerMemoryMode(memory) ? { peer: { memory } } : {}),
  };
}

function hasTokens(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const { botToken, appToken } = block as Record<string, unknown>;
  return typeof botToken === "string" && botToken.trim() !== "" && typeof appToken === "string" && appToken.trim() !== "";
}

export function peerSummary(peer: Employee, configDocument: Record<string, unknown>): RyokoSummary {
  const instanceId = peerSlackInstanceId(peer.name);
  const entry = instanceOf(configDocument, instanceId);
  return {
    name: peer.name,
    displayName: peer.displayName,
    ...(peer.emoji ? { emoji: peer.emoji } : {}),
    persona: peer.persona,
    engine: peer.engine,
    ...(peer.model ? { model: peer.model } : {}),
    memory: peer.peer?.memory ?? "shared",
    primary: false,
    slack: { connected: entry?.type === "slack" && hasTokens(entry), instanceId },
  };
}

export function mainSummary(config: JinnConfig | undefined, configDocument: Record<string, unknown>): RyokoSummary {
  const engine = config?.engines?.default;
  const engineBlock = engine ? config?.engines?.[engine] : undefined;
  const connectors = (configDocument.connectors ?? {}) as Record<string, unknown>;
  return {
    name: MAIN_RYOKO,
    displayName: config?.portal?.portalName?.trim() || "Ryoko",
    ...(engine ? { engine } : {}),
    ...(engineBlock?.model ? { model: engineBlock.model } : {}),
    memory: "main",
    primary: true,
    slack: { connected: hasTokens(connectors.slack) },
  };
}

/** Main first, then every peer by display name. */
export function listRyokos(config: JinnConfig | undefined, configDocument: Record<string, unknown>): RyokoSummary[] {
  const peers = [...scanOrg().values()].filter((employee) => isPeer(employee) && peerExists(employee.name))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.name.localeCompare(b.name));
  return [mainSummary(config, configDocument), ...peers.map((peer) => peerSummary(peer, configDocument))];
}
