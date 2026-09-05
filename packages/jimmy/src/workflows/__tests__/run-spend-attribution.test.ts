import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Employee,
  ModelRegistry,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import type { JsonValue, WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";
import type { WorkflowTodoSessionLink } from "../runner.js";

/* A run bound to a Todo must attribute what it spent to THAT Todo: every phase
 * session is linked to it, so the Todo's derived spend covers the pipeline. */

const employee: Employee = {
  name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete the task.",
};
const models: ModelRegistry = {
  "test-engine": {
    name: "test-engine", available: true, defaultModel: "test-model", effortMechanism: "codex-config",
    models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }],
  },
};

class FakeExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: sessionIdFor(command.owner.nodeId, command.owner.attempt) };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): WorkflowAttemptCompletion | null { return null; }
  async succeed(nodeId: string, fields: Record<string, JsonValue>): Promise<void> {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    const event: WorkflowAttemptCompletion = {
      sessionId: sessionIdFor(nodeId, command.owner.attempt), owner: command.owner, terminalVersion: 1, turn: 1,
      outcome: "succeeded", finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\``,
      completedAt: new Date().toISOString(),
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

function sessionIdFor(nodeId: string, attempt: number): string { return `session:${nodeId}:${attempt}`; }

class RecordingLink implements WorkflowTodoSessionLink {
  readonly links: Array<{ todoId: string; sessionId: string }> = [];
  link(input: { todoId: string; sessionId: string }): void { this.links.push(input); }
  // Spend attribution is what this suite is about; the run ledger has its own.
  openRun(): void {}
  closeRun(): void {}
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let todoSessions: RecordingLink;
let service: WorkflowService;
const now = new Date("2026-07-21T10:00:00.000Z");

function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}

function employeeNode(id: string): WorkflowNode {
  return {
    id, type: "employee", name: id, config: {
      employee: { source: "fixed", value: "worker" }, prompt: `Run ${id}.`,
      output: { fields: { value: { type: "string", required: true } }, allowAdditionalFields: false },
    },
  };
}

/** trigger → plan → verify → end: two phases, so attribution must cover both. */
function twoPhaseDefinition(id: string): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({
    ...created,
    inputs: [],
    nodes: [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      employeeNode("plan"),
      employeeNode("verify"),
      { id: "done", type: "end", name: "Done", config: { result: "success" } },
    ],
    edges: [
      edge("start-plan", "start", "success", "plan"),
      edge("plan-verify", "plan", "success", "verify"),
      edge("verify-done", "verify", "success", "done"),
    ],
  }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

function serviceWith(
  link: WorkflowTodoSessionLink | undefined,
  sessionSpend?: (sessionIds: string[]) => number,
): WorkflowService {
  return new WorkflowService({
    repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models,
    now: () => now.toISOString(),
    ...(link ? { todoSessions: link } : {}),
    ...(sessionSpend ? { sessionSpend } : {}),
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-spend-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  executor = new FakeExecutor();
  todoSessions = new RecordingLink();
  service = serviceWith(todoSessions);
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("attributing a run's spend to the Todo it is bound to", () => {
  it("links EVERY phase session of a bound run to that Todo", async () => {
    const definition = twoPhaseDefinition("bound-run");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-1" });
    expect(todoSessions.links).toEqual([{ todoId: "OPS-1", sessionId: "session:plan:1" }]);

    await executor.succeed("plan", { value: "planned" });
    expect(todoSessions.links).toEqual([
      { todoId: "OPS-1", sessionId: "session:plan:1" },
      { todoId: "OPS-1", sessionId: "session:verify:1" },
    ]);

    await executor.succeed("verify", { value: "verified" });
    expect(service.getRun(definition.id, run.id)!.status).toBe("completed");
  });

  it("links nothing when the run is not bound to a Todo", async () => {
    const definition = twoPhaseDefinition("unbound-run");
    await service.startManual({ workflowId: definition.id, input: {} });
    await executor.succeed("plan", { value: "planned" });
    expect(todoSessions.links).toEqual([]);
  });

  it("sums the costs of every attempt session in the run", async () => {
    service.dispose();
    const costs = new Map([
      ["session:plan:1", 1.25],
      ["session:verify:1", 0.75],
    ]);
    const seen: string[][] = [];
    service = serviceWith(undefined, (sessionIds) => {
      seen.push(sessionIds);
      return sessionIds.reduce((sum, id) => sum + (costs.get(id) ?? 0), 0);
    });
    const definition = twoPhaseDefinition("costed-run");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.succeed("plan", { value: "planned" });

    expect(service.getRunSpend(definition.id, run.id)).toBe(2);
    expect(seen).toEqual([["session:plan:1", "session:verify:1"]]);
  });

  it("runs the workflow to completion when the bound Todo no longer exists", async () => {
    service.dispose();
    service = serviceWith({
      link: ({ todoId }) => { throw new Error(`linkSession: work item ${todoId} not found`); },
      openRun: () => {}, closeRun: () => {},
    });
    const definition = twoPhaseDefinition("missing-todo");
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-404" });
    expect(run.status).toBe("running");

    await executor.succeed("plan", { value: "planned" });
    await executor.succeed("verify", { value: "verified" });
    const final = service.getRun(definition.id, run.id)!;
    expect(final.status).toBe("completed");
    expect(final.attempts.every((attempt) => attempt.status === "completed")).toBe(true);
  });
});
