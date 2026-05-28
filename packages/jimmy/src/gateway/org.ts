import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { ORG_DIR } from "../shared/paths.js";
import type { Employee } from "../shared/types.js";
import { logger } from "../shared/logger.js";

/**
 * Validate an SSH host/alias before it is handed to the `ssh` command.
 * Rejects leading dashes (so the value can't be parsed as an ssh option such
 * as `-oProxyCommand=...`) and anything outside `user@host:port` shape.
 */
export function isValidSshHost(value: string): boolean {
  return /^(?!-)(?:[A-Za-z0-9._~-]+@)?[A-Za-z0-9._~-]+(?::\d{1,5})?$/.test(value);
}

export function scanOrg(): Map<string, Employee> {
  const registry = new Map<string, Employee>();

  if (!fs.existsSync(ORG_DIR)) return registry;

  // Recursively find all .yaml files in org/
  function scan(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (
        entry.name.endsWith(".yaml") &&
        entry.name !== "department.yaml"
      ) {
        try {
          const raw = fs.readFileSync(fullPath, "utf-8");
          const data = yaml.load(raw) as any;
          if (data && data.name && data.persona) {
            const engine = data.engine || "claude";

            // sshHost: validate, and warn when it can't take effect so it never
            // silently degrades to a local run.
            let sshHost: string | undefined;
            if (typeof data.sshHost === "string" && data.sshHost.trim()) {
              const host = data.sshHost.trim();
              if (!isValidSshHost(host)) {
                logger.warn(`Ignoring invalid sshHost "${host}" for employee ${data.name}`);
              } else if (engine !== "claude") {
                logger.warn(`Ignoring sshHost for employee ${data.name}: engine "${engine}" does not support remote SSH execution (only "claude" does)`);
              } else {
                sshHost = host;
              }
            }

            const employee: Employee = {
              name: data.name,
              displayName: data.displayName || data.name,
              department:
                data.department || path.basename(path.dirname(fullPath)),
              rank: data.rank || "employee",
              engine,
              model: data.model || "sonnet",
              persona: data.persona,
              emoji: typeof data.emoji === "string" ? data.emoji : undefined,
              cliFlags: Array.isArray(data.cliFlags) ? data.cliFlags : undefined,
              effortLevel: typeof data.effortLevel === "string" ? data.effortLevel : undefined,
              alwaysNotify: typeof data.alwaysNotify === "boolean" ? data.alwaysNotify : true,
              reportsTo: data.reportsTo ?? undefined,
              mcp: data.mcp ?? undefined,
              sshHost,
              remoteCwd: sshHost && typeof data.remoteCwd === "string" ? data.remoteCwd : undefined,
              provides: Array.isArray(data.provides)
                ? data.provides.filter((s: unknown) => s && typeof s === "object" && typeof (s as any).name === "string" && typeof (s as any).description === "string")
                  .map((s: any) => ({ name: s.name as string, description: s.description as string }))
                : undefined,
            };
            registry.set(employee.name, employee);
          }
        } catch (err) {
          logger.warn(`Failed to parse employee file ${fullPath}: ${err}`);
        }
      }
    }
  }

  scan(ORG_DIR);
  return registry;
}

/**
 * Find the YAML file for an employee by name.
 * Searches ORG_DIR recursively.
 */
function findEmployeeYamlPath(name: string): string | undefined {
  if (!fs.existsSync(ORG_DIR)) return undefined;

  function search(dir: string): string | undefined {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = search(fullPath);
        if (found) return found;
      } else if (
        (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
        entry.name !== "department.yaml"
      ) {
        try {
          const raw = fs.readFileSync(fullPath, "utf-8");
          const data = yaml.load(raw) as any;
          if (data?.name === name) return fullPath;
        } catch {
          // skip unreadable files
        }
      }
    }
    return undefined;
  }

  return search(ORG_DIR);
}

/**
 * Update an employee's YAML file. Only alwaysNotify can be changed.
 * Returns true on success, false if employee not found.
 */
export function updateEmployeeYaml(
  name: string,
  updates: { alwaysNotify?: boolean },
): boolean {
  const filePath = findEmployeeYamlPath(name);
  if (!filePath) return false;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = yaml.load(raw) as Record<string, unknown>;
    if (!data || typeof data !== "object") return false;

    if (typeof updates.alwaysNotify === "boolean") {
      data.alwaysNotify = updates.alwaysNotify;
    }

    fs.writeFileSync(filePath, yaml.dump(data, { lineWidth: -1 }), "utf-8");
    return true;
  } catch (err) {
    logger.warn(`Failed to update employee YAML for ${name}: ${err}`);
    return false;
  }
}

export function findEmployee(
  name: string,
  registry: Map<string, Employee>,
): Employee | undefined {
  return registry.get(name);
}

export function extractMention(
  text: string,
  registry: Map<string, Employee>,
): Employee | undefined {
  for (const [name, employee] of registry) {
    if (text.includes(`@${name}`)) {
      return employee;
    }
  }
  return undefined;
}

/**
 * Extract ALL mentioned employees from text (e.g. "@jinn-dev @jinn-qa do X").
 * Returns an array of matched employees (can be empty).
 */
export function extractMentions(
  text: string,
  registry: Map<string, Employee>,
): Employee[] {
  const mentioned: Employee[] = [];
  for (const [name, employee] of registry) {
    if (text.includes(`@${name}`)) {
      mentioned.push(employee);
    }
  }
  return mentioned;
}
