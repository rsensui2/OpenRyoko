import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Employee,
  Engine,
  EngineResult,
  JinnConfig,
  ModelRegistry,
  WorkflowAttemptCommand,
} from "../../shared/types.js";
import { getSession } from "../../sessions/registry.js";
import { SessionManager } from "../../sessions/manager.js";
import type { WorkflowDefinition } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

/* A rework round is its own node, so it used to dispatch a session that knew
 * nothing and re-derived the whole brief. These are the two halves of the fix:
 * round two resumes round one's engine thread, and when there is nothing
 * resumable it dispatches exactly as it did before. */

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-continuation-vertical-"));
process.env.JINN_HOME = home;

const employee: Employee = {
  name: "worker", displayName: "Worker", department: "platform", rank: "employee",
  engine: "claude", model: "opus", effortLevel: "high", persona: "Do the work.",
};
const config = {
  gateway: { port: 0, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: process.execPath, model: "opus" }, codex: { bin: process.execPath, model: "gpt" } },
  connectors: {}, logging: { file: false, stdout: false, level: "error" },
  mcp: { gateway: { enabled: false }, browser: { enabled: false } },
} as unknown as JinnConfig;
const models: ModelRegistry = {
  claude: { name: "claude", available: true, defaultModel: "opus", effortMechanism: "claude-flag",
    models: [{ id: "opus", label: "Opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] }] },
  codex: { name: "codex", available: true, defaultModel: "gpt", effortMechanism: "none",
    models: [{ id: "gpt", label: "GPT", supportsEffort: false, effortLevels: [] }] },
};

class DeferredEngine implements Engine {
  constructor(readonly name: string) {}
  readonly calls: Parameters<Engine["run"]>[0][] = [];
  private readonly pending: Array<(result: EngineResult) => void> = [];
  run(opts: Parameters<Engine["run"]>[0]): Promise<EngineResult> {
    this.calls.push(opts);
    return new Promise((resolve) => this.pending.push(resolve));
  }
  resolve(result: EngineResult): void { this.pending.shift()!(result); }
  kill(): void {}
  isAlive(): boolean { return true; }
  killAll(): void {}
  killIdle(): void {}
}

/** The real executor, with the dispatch commands kept for inspection. */
class RecordingExecutor extends WorkflowSessionExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  override startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return super.startAttempt(command);
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let engine: DeferredEngine;
let executor: RecordingExecutor;
let service: WorkflowService;

function definition(engineName: "claude" | "codex", delta = "Fix only what the review flagged."): WorkflowDefinition {
  const created = repository.createDefinition({ id: `flow-${engineName}`, title: `Flow ${engineName}` });
  const saved = repository.saveDefinition({
    ...created,
    nodes: [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "first", type: "employee", name: "First", config: {
        employee: { source: "fixed", value: "worker" }, engine: { source: "fixed", value: engineName },
        prompt: "Build the thing.", output: { fields: {}, allowAdditionalFields: true } } },
      { id: "second", type: "employee", name: "Second", config: {
        employee: { source: "fixed", value: "worker" }, engine: { source: "fixed", value: engineName },
        prompt: "Build the thing, and here is the whole brief again.",
        continueFrom: { nodeId: "first", prompt: delta },
        output: { fields: {}, allowAdditionalFields: true } } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ],
    edges: [
      { id: "e1", from: { nodeId: "start", port: "success" }, to: { nodeId: "first", port: "input" } },
      { id: "e2", from: { nodeId: "first", port: "success" }, to: { nodeId: "second", port: "input" } },
      { id: "e3", from: { nodeId: "second", port: "success" }, to: { nodeId: "finish", port: "input" } },
    ],
  }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-continuation-run-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  engine = new DeferredEngine("claude");
  const engines = new Map<string, Engine>([["claude", engine], ["codex", engine]]);
  // Fork adaptation: jimmy's SessionManager takes (config, engines, connectorNames)
  // and wires the employee roster through a setter instead of the constructor.
  const manager = new SessionManager(config, engines);
  manager.setEmployeeProvider((id) => id === employee.name ? employee : undefined);
  executor = new RecordingExecutor(manager);
  service = new WorkflowService({ repository, executor, employees: () => new Map([[employee.name, employee]]), models: () => models });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function runBothPhases(authored: WorkflowDefinition): Promise<string> {
  const started = await service.startManual({ workflowId: authored.id, input: {}, idempotencyKey: `run-${authored.id}` });
  await vi.waitFor(() => expect(engine.calls).toHaveLength(1));
  engine.resolve({ sessionId: "native-round-1", result: "Done.\n```jinn-output\n{}\n```", durationMs: 1 });
  await vi.waitFor(() => expect(engine.calls).toHaveLength(2));
  await vi.waitFor(() => expect(
    repository.getRun(authored.id, started.id)?.attempts.some((attempt) => attempt.nodeId === "second"),
  ).toBe(true));
  return started.id;
}

describe("a second round on the session the first round left behind", () => {
  it("dispatches with the first round's engine session and only the delta prompt", async () => {
    const authored = definition("claude");
    const runId = await runBothPhases(authored);

    const attempts = repository.getRun(authored.id, runId)!.attempts;
    const first = attempts.find((attempt) => attempt.nodeId === "first")!;
    const second = attempts.find((attempt) => attempt.nodeId === "second")!;

    expect(second.resolvedConfig.continuedFrom).toEqual({ sessionId: first.sessionId, engineSessionId: "native-round-1" });
    expect(executor.commands[1]).toMatchObject({
      owner: { nodeId: "second" },
      continueFrom: { engine: "claude", engineSessionId: "native-round-1", sourceSessionId: first.sessionId },
    });
    // The session the round runs in, and the resume the engine is actually asked
    // for: the same thread, not a new one.
    expect(getSession(second.sessionId!)?.engineSessionId).toBe("native-round-1");
    expect(engine.calls[1]?.resumeSessionId).toBe("native-round-1");
    expect(second.sessionId).not.toBe(first.sessionId);

    expect(second.promptText?.startsWith("Fix only what the review flagged.")).toBe(true);
    expect(second.promptText).toContain("Workflow step completion contract");
    expect(second.promptText).not.toContain("here is the whole brief again");

    engine.resolve({ sessionId: "native-round-1", result: "Fixed.\n```jinn-output\n{}\n```", durationMs: 1 });
    await vi.waitFor(() => expect(service.getRun(authored.id, runId)?.status).toBe("completed"));
  });

  it("dispatches cold on its own brief when the first round's thread cannot be resumed", async () => {
    // codex resumes out of a per-session home, and this run wrote no rollout —
    // so the candidate exists and is rejected, which is the fallback path.
    const authored = definition("codex");
    const runId = await runBothPhases(authored);

    const second = repository.getRun(authored.id, runId)!.attempts.find((attempt) => attempt.nodeId === "second")!;
    expect(second.resolvedConfig.continuedFrom).toBeUndefined();
    expect(executor.commands[1]?.continueFrom).toBeUndefined();
    expect(getSession(second.sessionId!)?.engineSessionId).toBeNull();
    expect(second.promptText?.startsWith("Build the thing, and here is the whole brief again.")).toBe(true);

    engine.resolve({ sessionId: "native-round-2", result: "Done.\n```jinn-output\n{}\n```", durationMs: 1 });
    await vi.waitFor(() => expect(service.getRun(authored.id, runId)?.status).toBe("completed"));
  });

  it("dispatches cold over a delta whose bindings this run cannot resolve", async () => {
    // codex again, so the candidate is rejected and the delta never goes out. A
    // binding only the unused prompt reads must not fail the round reading the
    // other one.
    const authored = definition("codex", "Fix {{ input.reviewNote }} and nothing else.");
    const runId = await runBothPhases(authored);

    const second = repository.getRun(authored.id, runId)!.attempts.find((attempt) => attempt.nodeId === "second")!;
    expect(second.resolvedConfig.continuedFrom).toBeUndefined();
    expect(second.promptText?.startsWith("Build the thing, and here is the whole brief again.")).toBe(true);

    engine.resolve({ sessionId: "native-round-2", result: "Done.\n```jinn-output\n{}\n```", durationMs: 1 });
    await vi.waitFor(() => expect(service.getRun(authored.id, runId)?.status).toBe("completed"));
  });
});
