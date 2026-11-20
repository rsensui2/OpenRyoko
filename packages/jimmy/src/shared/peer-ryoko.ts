/**
 * Where a peer Ryoko lives on disk. A peer is another top-level assistant
 * defined as an employee YAML under `org/ryokos/` with a `peer` block; with
 * `memory: "own"` its long-term memory lives under `ryokos/<name>/` instead
 * of the main assistant's MEMORY.md / knowledge/.
 */
import path from "node:path";
import { JINN_HOME, ORG_DIR } from "./paths.js";
import type { Employee, PeerConfig, PeerMemoryMode } from "./types.js";

export const PEER_DEPARTMENT = "ryokos";
/** The main assistant's name in the Ryokos API; never a peer's name. */
export const MAIN_RYOKO = "main";
export const PEER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PEER_MEMORY_MODES: readonly PeerMemoryMode[] = ["shared", "own"];

export function isPeerName(value: unknown): value is string {
  return typeof value === "string" && PEER_NAME_PATTERN.test(value) && value !== MAIN_RYOKO;
}

export function isPeerMemoryMode(value: unknown): value is PeerMemoryMode {
  return typeof value === "string" && (PEER_MEMORY_MODES as readonly string[]).includes(value);
}

/** The `peer` block from a parsed YAML, or null when it is absent or invalid. */
export function parsePeerConfig(raw: unknown): PeerConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const memory = (raw as Record<string, unknown>).memory;
  return isPeerMemoryMode(memory) ? { memory } : null;
}

export function isPeer(employee: Employee | undefined): employee is Employee & { peer: PeerConfig } {
  return Boolean(employee?.peer);
}

export function peerYamlPath(name: string, orgDir: string = ORG_DIR): string {
  return path.join(orgDir, PEER_DEPARTMENT, `${name}.yaml`);
}

export function peerHomeDir(name: string, home: string = JINN_HOME): string {
  return path.join(home, "ryokos", name);
}

export function peerMemoryPath(name: string, home: string = JINN_HOME): string {
  return path.join(peerHomeDir(name, home), "MEMORY.md");
}

export function peerKnowledgeDir(name: string, home: string = JINN_HOME): string {
  return path.join(peerHomeDir(name, home), "knowledge");
}

/** The Slack connector instance a peer's own Slack app runs as. */
export function peerSlackInstanceId(name: string): string {
  return `slack-${name}`;
}
