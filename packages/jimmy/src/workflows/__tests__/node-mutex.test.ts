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
import { workflowNodeSchema } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

const employee: Employee = {
  name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work.",
};
const models: ModelRegistry = {
  "test-engine": {
    name: "test-engine", available: true, defaultModel: "test-model", effortMechanism: "codex-config",
    models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }],
  },
};
const KEY = "shared-resource";

class Executor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> { /* nothing to stop in this harness */ }
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  readTerminalCompletion(): null { return null; }
  private async emit(command: WorkflowAttemptCommand, event: Partial<WorkflowAttemptCompletion>): Promise<void> {
    const completion = {
      sessionId: `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}`,
      owner: command.owner, terminalVersion: 1, turn: 1, outcome: "succeeded",
      completedAt: "2026-08-05T12:05:00.000Z", ...event,
    } as WorkflowAttemptCompletion;
    await Promise.all([...this.listeners].map((listener) => listener(completion)));
  }
  async settle(command: WorkflowAttemptCommand, fields: Record<string, JsonValue> = {}): Promise<void> {
    await this.emit(command, { finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\`` });
  }
  async fail(command: WorkflowAttemptCommand): Promise<void> {
    await this.emit(command, { outcome: "failed", error: "The phase reported failure." });
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: Executor;
let service: WorkflowService;

function buildService(): WorkflowService {
  return new WorkflowService({
    repository,
    executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]),
    models: () => models,
    now: () => "2026-08-05T12:00:00.000Z",
  });
}

function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}

function save(id: string, nodes: WorkflowNode[], edges: WorkflowDefinition["edges"]): WorkflowDefinition {
  const created = service.createDefinition({ id, title: id });
  const saved = service.saveDefinition({ ...created, nodes, edges }, created.revision);
  return service.setEnabled({ id, enabled: true, expectedRevision: saved.revision });
}

/** One employee node between a manual trigger and a success End. `mutex` absent leaves
 *  it exactly as any other Workflow authors it, which is what the untouched case needs. */
function guardedWorkflow(id: string, mutex?: string): WorkflowDefinition {
  return save(id, [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "work", type: "employee", name: "Work", config: {
      employee: { source: "fixed", value: "worker" }, prompt: "Do the guarded work.",
      retry: { attempts: 1, delaySeconds: 0, backoff: "fixed" },
      ...(mutex ? { mutex } : {}),
    } },
    { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
  ], [edge("start-work", "start", "success", "work"), edge("work-finish", "work", "success", "finish")]);
}

/** A woken run advances through a fired-and-forgotten promise, so the dispatch it
 *  makes lands a few ticks after the holder settles rather than inside that call. */
async function woken(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));
}

function workNode(workflowId: string, runId: string) {
  return service.getRun(workflowId, runId)!.nodeRuns.find((node) => node.nodeId === "work")!;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-node-mutex-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database, () => "2026-08-05T12:00:00.000Z");
  executor = new Executor();
  service = buildService();
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("mutex as an authored value", () => {
  const node = (mutex: unknown) => ({
    id: "work", type: "employee", name: "Work",
    config: { employee: { source: "fixed", value: "worker" }, prompt: "Do the guarded work.", mutex },
  });

  it("accepts a key on an employee node", () => {
    for (const mutex of ["shared-resource", "a", "k".repeat(60)]) {
      expect(workflowNodeSchema.parse(node(mutex))).toEqual(node(mutex));
    }
  });

  it("rejects a key outside the authored bounds", () => {
    for (const mutex of ["", "k".repeat(61), 4, null]) {
      expect(workflowNodeSchema.safeParse(node(mutex)).success).toBe(false);
    }
  });
});

describe("nodes sharing a mutex key", () => {
  async function twoRuns(): Promise<{ holder: string; waiter: string }> {
    guardedWorkflow("guarded-flow", KEY);
    const holder = await service.startManual({ workflowId: "guarded-flow", input: {} });
    const waiter = await service.startManual({ workflowId: "guarded-flow", input: {} });
    return { holder: holder.id, waiter: waiter.id };
  }

  it("dispatches one and leaves the other standing off", async () => {
    const { holder, waiter } = await twoRuns();

    expect(executor.commands).toHaveLength(1);
    expect(executor.commands[0]!.owner.runId).toBe(holder);
    expect(workNode("guarded-flow", waiter).status).toBe("pending");
    expect(service.getRun("guarded-flow", waiter)!.attempts).toEqual([]);
  });

  it("records the key it wants and who is holding it", async () => {
    const { holder, waiter } = await twoRuns();

    expect(workNode("guarded-flow", waiter).resolvedConfig).toMatchObject({
      mutexKey: KEY, mutexHeldBy: `${holder}:work`,
    });
  });

  it("wakes the waiter when the holder succeeds, with no external poke", async () => {
    const { waiter } = await twoRuns();

    await executor.settle(executor.commands[0]!);
    await woken();

    expect(executor.commands).toHaveLength(2);
    expect(executor.commands[1]!.owner.runId).toBe(waiter);
    expect(workNode("guarded-flow", waiter).status).toBe("running");
  });

  it("frees the key when the holder fails, because a failure is not a claim", async () => {
    const { holder, waiter } = await twoRuns();

    await executor.fail(executor.commands[0]!);
    await woken();

    expect(service.getRun("guarded-flow", holder)!.status).toBe("failed");
    expect(executor.commands).toHaveLength(2);
    expect(executor.commands[1]!.owner.runId).toBe(waiter);
  });

  it("keeps no lock a rebuilt service could inherit", async () => {
    guardedWorkflow("guarded-flow", KEY);
    const holder = await service.startManual({ workflowId: "guarded-flow", input: {} });
    await executor.settle(executor.commands[0]!);
    expect(service.getRun("guarded-flow", holder.id)!.status).toBe("completed");

    service.dispose();
    service = buildService();
    const next = await service.startManual({ workflowId: "guarded-flow", input: {} });

    expect(executor.commands).toHaveLength(2);
    expect(executor.commands[1]!.owner.runId).toBe(next.id);
    expect(workNode("guarded-flow", next.id).status).toBe("running");
  });

  it("leaves a node that authors no key dispatching while another holds one", async () => {
    guardedWorkflow("guarded-flow", KEY);
    guardedWorkflow("open-flow");
    await service.startManual({ workflowId: "guarded-flow", input: {} });

    const open = await service.startManual({ workflowId: "open-flow", input: {} });

    expect(executor.commands).toHaveLength(2);
    expect(executor.commands[1]!.owner.runId).toBe(open.id);
    expect(workNode("open-flow", open.id).status).toBe("running");
    expect(workNode("open-flow", open.id).resolvedConfig).not.toHaveProperty("mutexKey");
  });
});
