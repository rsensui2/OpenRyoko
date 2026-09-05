import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener } from "../../shared/types.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

/**
 * ICI-733: a manual retry is exactly when someone has just moved a stuck Todo
 * onto another engine, so the retry has to RESOLVE the override rather than
 * copy the config off the attempt that kept failing.
 */

const sessionHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-retry-override-"));
process.env.JINN_HOME = sessionHome;

const employee: Employee = { name: "worker", displayName: "Worker", department: "platform", rank: "employee",
  engine: "codex", model: "gpt-5.6-sol", persona: "Complete work." };
const models: ModelRegistry = {
  codex: { name: "codex", available: true, defaultModel: "gpt-5.6-sol",
    models: [{ id: "gpt-5.6-sol", label: "Sol", supportsEffort: false, effortLevels: [] }] },
  claude: { name: "claude", available: true, defaultModel: "opus",
    models: [{ id: "opus", label: "Opus", supportsEffort: false, effortLevels: [] }] },
} as unknown as ModelRegistry;

class StubExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    const { runId, nodeId, attempt } = command.owner;
    return { sessionId: `session:${runId}:${nodeId}:${attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): WorkflowAttemptCompletion | null { return null; }
  async failLatest(nodeId: string): Promise<void> {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    const event: WorkflowAttemptCompletion = {
      sessionId: `session:${command.owner.runId}:${nodeId}:${command.owner.attempt}`, owner: command.owner,
      turn: 1, terminalVersion: 1, outcome: "failed", error: "Interactive turn failed: server_error",
      completedAt: now.toISOString(),
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: StubExecutor;
let service: WorkflowService;
let now: Date;
/** What the bound Todo currently says, re-read on every resolution. */
let override: { engine: string | null; model: string | null } | undefined;

function definition(): WorkflowDefinition {
  const work: WorkflowNode = { id: "work", type: "employee", name: "Work", config: {
    employee: { source: "fixed", value: "worker" }, prompt: "Run the work.",
    // A retry budget that never elapses inside the test, so the only second
    // attempt is the manual one.
    retry: { attempts: 3, delaySeconds: 3600, backoff: "fixed" }, timeoutMinutes: 60 } };
  const created = repository.createDefinition({ id: "retry-override", title: "Retry override" });
  const saved = repository.saveDefinition({ ...created, nodes: [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } }, work,
    { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
  ], edges: [
    { id: "start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
    { id: "work-finish", from: { nodeId: "work", port: "success" }, to: { nodeId: "finish", port: "input" } },
  ] }, created.revision);
  return repository.setEnabled("retry-override", true, saved.revision);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-retry-"));
  now = new Date("2026-08-13T10:00:00.000Z");
  override = undefined;
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database, () => now.toISOString());
  executor = new StubExecutor();
  service = new WorkflowService({ repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString(),
    todoDispatch: { read: () => override } });
});

afterEach(() => { service.dispose(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
afterAll(async () => {
  (await import("../../shared/db.js")).__closeDbForTest();
  fs.rmSync(sessionHome, { recursive: true, force: true });
});

/** A bound run whose first attempt has dispatched and failed. */
async function failedFirstAttempt(): Promise<{ workflowId: string; runId: string }> {
  const flow = definition();
  const run = await service.startManual({ workflowId: flow.id, input: {}, todoId: "JIN-1" });
  expect(executor.commands).toHaveLength(1);
  expect(executor.commands[0]).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
  await executor.failLatest("work");
  return { workflowId: flow.id, runId: run.id };
}

describe("a manual retry of a Todo-bound Employee node", () => {
  it("runs on the override set while the failing attempt was in flight", async () => {
    const { workflowId, runId } = await failedFirstAttempt();

    override = { engine: "claude", model: "opus" };
    const retried = await service.retryNode({ workflowId, runId, nodeId: "work", idempotencyKey: "retry-1" });

    expect(executor.commands.at(-1)).toMatchObject({ engine: "claude", model: "opus" });
    expect(retried.attempts.at(-1)?.resolvedConfig).toMatchObject({ engine: "claude", model: "opus" });
  });

  it("takes the engine's default model when the override names only an engine", async () => {
    const { workflowId, runId } = await failedFirstAttempt();

    override = { engine: "claude", model: null };
    await service.retryNode({ workflowId, runId, nodeId: "work", idempotencyKey: "retry-2" });

    expect(executor.commands.at(-1)).toMatchObject({ engine: "claude", model: "opus" });
  });

  it("keeps the employee's own engine when the Todo says nothing", async () => {
    const { workflowId, runId } = await failedFirstAttempt();

    await service.retryNode({ workflowId, runId, nodeId: "work", idempotencyKey: "retry-3" });

    expect(executor.commands.at(-1)).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
  });
});
