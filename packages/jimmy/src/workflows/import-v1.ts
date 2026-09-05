import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { logger } from "../shared/logger.js";
import { resolveJinnHome } from "../shared/paths.js";
import { workflowDefinitionSchema, type WorkflowDefinition, type WorkflowEdge, type WorkflowNode } from "./model.js";

type LogLevel = "info" | "warn";
type LegacyRecord = Record<string, unknown>;

export interface LegacyWorkflowImportOptions {
  legacyDirectory?: string;
  legacyRunsDirectory?: string;
  reportPath?: string;
  now?: () => string;
  log?: (level: LogLevel, message: string) => void;
}

export interface LegacyWorkflowImportResult {
  imported: number;
  failed: number;
  skipped: boolean;
}

function record(value: unknown, subject: string): LegacyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${subject} must be an object`);
  return value as LegacyRecord;
}

function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${subject} must be a non-empty string`);
  return value;
}

function fixed<T extends string>(value: T) {
  return { source: "fixed" as const, value };
}

function keysOutside(value: LegacyRecord, allowed: readonly string[]): string[] {
  const accepted = new Set(allowed);
  return Object.keys(value).filter((key) => !accepted.has(key));
}

function position(value: unknown): { x: number; y: number } {
  const item = record(value, "node position");
  if (typeof item.x !== "number" || !Number.isFinite(item.x)
    || typeof item.y !== "number" || !Number.isFinite(item.y)) {
    throw new Error("node position must contain finite x/y coordinates");
  }
  return { x: item.x, y: item.y };
}

function node(value: unknown): { node: WorkflowNode; position: { x: number; y: number } } {
  const item = record(value, "node");
  const id = text(item.id, "node id");
  const name = text(item.label, `node ${id} label`);
  const coordinates = position(item.position);
  if (item.type === "trigger") {
    const trigger = record(item.trigger, `trigger ${id}`);
    if (trigger.kind !== "manual") throw new Error(`trigger ${id} uses unsupported kind ${String(trigger.kind)}`);
    const unsupportedTriggerKeys = keysOutside(trigger, ["kind"]);
    if (unsupportedTriggerKeys.length > 0) throw new Error(`trigger ${id} has unsupported fields: ${unsupportedTriggerKeys.join(", ")}`);
    return { node: { id, type: "trigger", name, config: { kind: "manual" } }, position: coordinates };
  }
  if (item.type !== "step") throw new Error(`node ${id} uses unsupported type ${String(item.type)}`);
  if (Array.isArray(item.gates) && item.gates.length > 0) throw new Error(`step ${id} has legacy gates that require manual review`);
  if (item.optional !== undefined) throw new Error(`step ${id} uses unsupported optional semantics`);
  if (item.switchMode !== undefined) throw new Error(`step ${id} uses unsupported switch semantics`);
  const actor = record(item.actor, `step ${id} actor`);
  const actorKind = text(actor.kind, `step ${id} actor kind`);
  const actorRef = text(actor.ref, `step ${id} actor ref`);
  if (actorKind !== "employee" && actorKind !== "engine") throw new Error(`step ${id} uses unsupported actor kind ${actorKind}`);
  const options = item.options === undefined ? {} : record(item.options, `step ${id} options`);
  const unsupportedOptions = keysOutside(options, ["model", "effort", "retry", "timeoutMinutes"]);
  if (unsupportedOptions.length > 0) throw new Error(`step ${id} uses unsupported options: ${unsupportedOptions.join(", ")}`);
  const retry = options.retry === undefined ? undefined : record(options.retry, `step ${id} retry`);
  if (retry) {
    const unsupportedRetry = keysOutside(retry, ["maxAttempts"]);
    if (unsupportedRetry.length > 0) throw new Error(`step ${id} uses unsupported retry fields: ${unsupportedRetry.join(", ")}`);
  }
  const maxAttempts = retry?.maxAttempts;
  const timeoutMinutes = options.timeoutMinutes;
  if (options.effort !== undefined
    && (typeof options.effort !== "string" || !["low", "medium", "high", "xhigh"].includes(options.effort))) {
    throw new Error(`step ${id} uses unsupported effort ${String(options.effort)}`);
  }
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || (maxAttempts as number) < 1)) {
    throw new Error(`step ${id} has invalid retry maxAttempts`);
  }
  if (timeoutMinutes !== undefined && (!Number.isInteger(timeoutMinutes) || (timeoutMinutes as number) < 1)) {
    throw new Error(`step ${id} has invalid timeoutMinutes`);
  }
  const effort = options.effort as "low" | "medium" | "high" | "xhigh" | undefined;
  const config = {
    employee: fixed(actorRef),
    prompt: typeof item.instructions === "string" && item.instructions ? item.instructions : `Run ${name}.`,
    ...(actorKind === "engine" ? { engine: fixed(actorRef) } : {}),
    ...(typeof options.model === "string" ? { model: fixed(options.model) } : {}),
    ...(effort ? { effort: fixed(effort) } : {}),
    ...(Number.isInteger(maxAttempts) ? { retry: { attempts: maxAttempts as number, delaySeconds: 0, backoff: "fixed" as const } } : {}),
    ...(Number.isInteger(timeoutMinutes) ? { timeoutMinutes: timeoutMinutes as number } : {}),
  };
  return { node: { id, type: "employee", name, config }, position: coordinates };
}

function edge(value: unknown): WorkflowEdge {
  const item = record(value, "edge");
  const id = text(item.id, "edge id");
  if (item.when !== undefined) throw new Error(`edge ${id} uses a legacy condition that requires manual review`);
  if (item.kind === "loop") throw new Error(`edge ${id} uses legacy loop semantics that require manual review`);
  if (item.kind !== "sequence" && item.kind !== "handoff") {
    throw new Error(`edge ${id} uses unsupported kind ${String(item.kind)}`);
  }
  const unsupported = keysOutside(item, ["id", "from", "to", "kind"]);
  if (unsupported.length > 0) throw new Error(`edge ${id} uses unsupported fields: ${unsupported.join(", ")}`);
  return {
    id,
    from: { nodeId: text(item.from, `edge ${id} source`), port: "success" },
    to: { nodeId: text(item.to, `edge ${id} target`), port: "input" },
  };
}

function convert(value: unknown): WorkflowDefinition {
  const legacy = record(value, "legacy Workflow definition");
  const id = text(legacy.id, "Workflow id");
  const title = text(legacy.title, `Workflow ${id} title`);
  if (!Array.isArray(legacy.nodes) || !Array.isArray(legacy.edges)) throw new Error("nodes and edges must be arrays");
  const converted = legacy.nodes.map(node);
  const stamp = typeof legacy.updatedAt === "string" ? legacy.updatedAt : new Date().toISOString();
  const revision = Number.isInteger(legacy.version) && (legacy.version as number) > 0 ? legacy.version as number : 1;
  const definition = {
    schemaVersion: 1,
    id,
    title,
    ...(typeof legacy.description === "string" ? { description: legacy.description } : {}),
    revision,
    enabled: false,
    nodes: converted.map((item) => item.node),
    edges: legacy.edges.map(edge),
    // The v1 canvas was a hand-arranged surface, so its coordinates carry over
    // as manual and the imported graph opens exactly where its author left it.
    ui: { positions: Object.fromEntries(converted.map((item) => [item.node.id, item.position])), layout: "manual" as const },
    createdAt: stamp,
    updatedAt: stamp,
  };
  const parsed = workflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "converted definition is invalid");
  return parsed.data;
}

interface DefinitionImportRecord {
  file: string;
  id: string;
  sourceSha256: string;
  outcome: "imported" | "preserved";
  reason?: string;
  definition?: WorkflowDefinition;
}

interface LegacyRunRecord {
  file: string;
  workflowId: string;
  runId: string;
  status: string;
}

function scanLegacyRuns(directory: string): { count: number; active: LegacyRunRecord[] } {
  if (!existsSync(directory)) return { count: 0, active: [] };
  const records: LegacyRunRecord[] = [];
  let count = 0;
  for (const workflow of readdirSync(directory, { withFileTypes: true })) {
    if (!workflow.isDirectory()) continue;
    const workflowDirectory = path.join(directory, workflow.name);
    for (const file of readdirSync(workflowDirectory).filter((name) => name.endsWith(".json")).sort()) {
      count += 1;
      try {
        const value = record(JSON.parse(readFileSync(path.join(workflowDirectory, file), "utf8")), "legacy run");
        const status = typeof value.status === "string" ? value.status : "unknown";
        if (!["running", "parked", "dispatched"].includes(status)) continue;
        records.push({
          file: `${workflow.name}/${file}`,
          workflowId: typeof value.workflowId === "string" ? value.workflowId : workflow.name,
          runId: typeof value.runId === "string" ? value.runId : file.replace(/\.json$/, ""),
          status,
        });
      } catch {
        // Malformed legacy evidence is still counted and remains untouched.
      }
    }
  }
  return { count, active: records };
}

function writeImportReport(reportPath: string, report: unknown): void {
  mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  const temporary = `${reportPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, reportPath);
}

export function importLegacyWorkflowDefinitions(
  db: Database.Database,
  options: LegacyWorkflowImportOptions = {},
): LegacyWorkflowImportResult {
  const home = resolveJinnHome();
  const directory = options.legacyDirectory ?? path.join(home, "workflow-evidence", "workflows");
  const legacyRunsDirectory = options.legacyRunsDirectory ?? path.join(home, "workflow-evidence", "reports", "runs");
  const reportPath = options.reportPath ?? path.join(home, "workflows", "legacy-v1-import-report.json");
  if (existsSync(reportPath)) return { imported: 0, failed: 0, skipped: true };
  if (!existsSync(directory)) return { imported: 0, failed: 0, skipped: true };
  const files = readdirSync(directory).filter((name) => name.endsWith(".definition.json")).sort();
  if (files.length === 0) return { imported: 0, failed: 0, skipped: true };
  const log = options.log ?? ((level: LogLevel, message: string) => logger[level](message));
  const records: DefinitionImportRecord[] = files.map((file) => {
    const fallbackId = file.slice(0, -".definition.json".length);
    const source = readFileSync(path.join(directory, file));
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    try {
      const definition = convert(JSON.parse(source.toString("utf8")));
      return { file, id: definition.id, sourceSha256, outcome: "imported", definition };
    } catch (error) {
      return {
        file,
        id: fallbackId,
        sourceSha256,
        outcome: "preserved",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const insert = db.prepare(`INSERT INTO workflow_definitions
    (id,title,revision,enabled,retired_at,definition_json,created_at,updated_at)
    VALUES (@id,@title,@revision,0,NULL,@json,@createdAt,@updatedAt)`);
  const existing = db.prepare("SELECT 1 FROM workflow_definitions WHERE id = ?");
  db.transaction(() => {
    for (const item of records) {
      if (!item.definition) continue;
      if (existing.get(item.definition.id)) {
        item.outcome = "preserved";
        item.reason = "a v2 Workflow with this id already exists";
        delete item.definition;
        continue;
      }
      const definition = item.definition;
      insert.run({
        id: definition.id,
        title: definition.title,
        revision: definition.revision,
        json: JSON.stringify(definition),
        createdAt: definition.createdAt,
        updatedAt: definition.updatedAt,
      });
    }
  }).immediate();
  const legacyRuns = scanLegacyRuns(legacyRunsDirectory);
  writeImportReport(reportPath, {
    schemaVersion: 1,
    createdAt: (options.now ?? (() => new Date().toISOString()))(),
    legacyDefinitionDirectory: directory,
    legacyRunDirectory: legacyRunsDirectory,
    definitions: records.map(({ definition: _definition, ...item }) => item),
    legacyRuns,
  });
  for (const item of records) {
    if (item.outcome === "imported") log("info", `[workflows] imported legacy Workflow ${item.id} as a disabled v2 draft`);
    else log("warn", `[workflows] preserved unsupported legacy Workflow ${item.id}: ${item.reason}`);
  }
  if (legacyRuns.active.length > 0) {
    log("warn", `[workflows] found ${legacyRuns.active.length} active legacy Workflow run(s); source evidence remains unchanged and requires operator review`);
  }
  log("info", `[workflows] legacy Workflow import report written to ${reportPath}`);
  const imported = records.filter((item) => item.outcome === "imported").length;
  const failed = records.length - imported;
  return { imported, failed, skipped: false };
}
