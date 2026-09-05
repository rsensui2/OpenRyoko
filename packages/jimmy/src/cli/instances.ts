import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { INSTANCES_REGISTRY, TEMPLATE_DIR } from "../shared/paths.js";

export interface Instance {
  name: string;
  port: number;
  home: string;
  createdAt: string;
}

export function loadInstances(): Instance[] {
  if (!fs.existsSync(INSTANCES_REGISTRY)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(INSTANCES_REGISTRY, "utf-8"));
    if (!Array.isArray(parsed)) return [];
    const seenNames = new Set<string>();
    const seenPorts = new Set<number>();
    return parsed.filter((item): item is Instance => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<Instance>;
      if (typeof candidate.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(candidate.name)) return false;
      if (!Number.isInteger(candidate.port) || candidate.port! < 1 || candidate.port! > 65_535) return false;
      if (typeof candidate.home !== "string" || !path.isAbsolute(candidate.home)) return false;
      if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) return false;
      if (seenNames.has(candidate.name) || seenPorts.has(candidate.port!)) return false;
      seenNames.add(candidate.name);
      seenPorts.add(candidate.port!);
      return true;
    });
  } catch {
    return [];
  }
}

export function saveInstances(instances: Instance[]): void {
  fs.mkdirSync(path.dirname(INSTANCES_REGISTRY), { recursive: true, mode: 0o700 });
  const temporary = `${INSTANCES_REGISTRY}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(instances, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, INSTANCES_REGISTRY);
  fs.chmodSync(INSTANCES_REGISTRY, 0o600);
}

/** Find the next available port starting from 7777, skipping ports already used by instances. */
export function nextAvailablePort(instances: Instance[]): number {
  const usedPorts = new Set(instances.map((i) => i.port));
  let port = 7777;
  while (usedPorts.has(port)) port++;
  return port;
}

/** Ensure the default "jinn" instance is registered. */
export function ensureDefaultInstance(): void {
  const instances = loadInstances();
  if (instances.some((i) => i.name === "jinn")) return;
  instances.unshift({
    name: "jinn",
    port: 7777,
    home: path.join(os.homedir(), ".jinn"),
    createdAt: new Date().toISOString(),
  });
  saveInstances(instances);
}

export function findInstance(name: string): Instance | undefined {
  return loadInstances().find((i) => i.name === name);
}
