import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Employee,
  ModelRegistry,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import type { Binding, JsonValue, WorkflowDefinition, WorkflowNode } from "../model.js";
import { workflowNodeSchema } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";
import { validateExecutableWorkflow } from "../validation.js";

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
  async settle(command: WorkflowAttemptCommand, fields: Record<string, JsonValue>): Promise<void> {
    const event: WorkflowAttemptCompletion = {
      sessionId: `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}`,
      owner: command.owner, terminalVersion: 1, turn: 1, outcome: "succeeded",
      finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\``,
      completedAt: "2026-08-05T12:05:00.000Z",
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: Executor;
let service: WorkflowService;

/** `activeEngineSessions` absent leaves the fan-out unclamped, so a test that is
 *  about the authored degree never depends on the machine it runs on. A large
 *  count drives the ceiling to its floor of 1 on any machine, which is what
 *  makes the clamped case deterministic too. */
function buildService(activeEngineSessions?: () => number): WorkflowService {
  return new WorkflowService({
    repository,
    executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]),
    models: () => models,
    now: () => "2026-08-05T12:00:00.000Z",
    ...(activeEngineSessions ? { activeEngineSessions } : {}),
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

function childWorkflow(): WorkflowDefinition {
  return save("child-flow", [
    { id: "start", type: "trigger", name: "Called", config: { kind: "workflow-call" } },
    { id: "work", type: "employee", name: "Work", config: {
      employee: { source: "fixed", value: "worker" }, prompt: "Process {{ input.topic }}.",
    } },
    { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
  ], [edge("start-work", "start", "success", "work"), edge("work-finish", "work", "success", "finish")]);
}

/** A planner node that names the degree of parallelism, then a fan-out that takes
 *  its width from what the planner emitted. */
function plannedParent(concurrency: number | Binding<number>, items = 5): WorkflowDefinition {
  return save("planned-parent", [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "plan", type: "employee", name: "Plan", config: {
      employee: { source: "fixed", value: "worker" }, prompt: "Decide the degree.",
    } },
    { id: "children", type: "workflow-call", name: "Children", config: {
      workflowId: { source: "fixed", value: "child-flow" },
      items: { source: "fixed", value: Array.from({ length: items }, (_, index) => ({ topic: index + 1 })) },
      input: { topic: { source: "trigger", path: "item.topic" } },
      concurrency,
    } },
    { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
  ], [
    edge("start-plan", "start", "success", "plan"),
    edge("plan-children", "plan", "success", "children"),
    edge("children-finish", "children", "success", "finish"),
  ]);
}

const DEGREE_FROM_PLAN: Binding<number> = { source: "node", nodeId: "plan", path: "fields.degree" };

async function runWithPlannedDegree(degree: JsonValue): Promise<string> {
  childWorkflow();
  const parent = plannedParent(DEGREE_FROM_PLAN);
  const run = await service.startManual({ workflowId: parent.id, input: {} });
  await executor.settle(executor.commands[0]!, { degree });
  return run.id;
}

function fanoutNode(runId: string) {
  return service.getRun("planned-parent", runId)!.nodeRuns.find((node) => node.nodeId === "children")!;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-fanout-concurrency-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database, () => "2026-08-05T12:00:00.000Z");
  executor = new Executor();
  service = buildService();
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Fix the machine the ceiling is read from, so a scheduling test says the same
 *  thing on a busy laptop as on a CI box. */
function pinMachine(cpuHeadroom: number): void {
  vi.spyOn(os, "availableParallelism").mockReturnValue(cpuHeadroom + 1);
  vi.spyOn(os, "freemem").mockReturnValue(cpuHeadroom * 512 * 1024 * 1024);
}

function liveChildren(runId: string): number {
  return repository.listChildRuns(runId, "children")
    .filter((child) => !["completed", "failed", "cancelled"].includes(child.status)).length;
}

/** A child run ends by waking its caller through a fired-and-forgotten advance, so
 *  the parent's refill lands a few ticks after the child settles. */
async function refilled(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("adaptive fan-out concurrency", () => {
  it("runs the number of children a planner node asked for, not the authored default", async () => {
    const runId = await runWithPlannedDegree(4);

    expect(repository.listChildRuns(runId, "children")).toHaveLength(4);
    expect(fanoutNode(runId).resolvedConfig).toMatchObject({
      concurrency: 4, concurrencyEffective: 4, concurrencyLimitedBy: "requested",
    });
  });

  it("clamps to what the machine can serve and records both numbers", async () => {
    service.dispose();
    service = buildService(() => 1_000);
    const runId = await runWithPlannedDegree(4);

    expect(repository.listChildRuns(runId, "children")).toHaveLength(1);
    expect(fanoutNode(runId).resolvedConfig).toMatchObject({
      concurrency: 4, concurrencyEffective: 1, concurrencyLimitedBy: "system-ceiling",
    });
  });

  it("refills a drained wave without charging itself for its own children", async () => {
    pinMachine(8);
    let started: string | undefined;
    service.dispose();
    service = buildService(() => (started ? liveChildren(started) : 0));
    childWorkflow();
    const parent = plannedParent(DEGREE_FROM_PLAN, 12);
    const run = await service.startManual({ workflowId: parent.id, input: {} });
    started = run.id;
    await executor.settle(executor.commands[0]!, { degree: 8 });
    expect(repository.listChildRuns(run.id, "children")).toHaveLength(8);

    // The gateway's session count is these eight children; a ceiling that reads it
    // whole leaves the fan-out competing with itself and the last four items never start.
    for (const command of executor.commands.slice(1, 5)) await executor.settle(command, {});
    await refilled();

    expect(repository.listChildRuns(run.id, "children")).toHaveLength(12);
    expect(fanoutNode(run.id).resolvedConfig).toMatchObject({
      concurrency: 8, concurrencyEffective: 8, concurrencyLimitedBy: "requested",
    });
  });

  it("keeps a bare number scheduling exactly as it always has", async () => {
    childWorkflow();
    const parent = plannedParent(3);
    const run = await service.startManual({ workflowId: parent.id, input: {} });
    await executor.settle(executor.commands[0]!, { degree: 5 });

    expect(repository.listChildRuns(run.id, "children")).toHaveLength(3);
  });

  for (const [label, degree] of [
    ["zero", 0], ["a negative", -2], ["a fraction", 1.5], ["a string", "four"], ["null", null],
  ] as [string, JsonValue][]) {
    it(`fails the run, naming the node, when the planner emits ${label}`, async () => {
      const runId = await runWithPlannedDegree(degree);

      const run = service.getRun("planned-parent", runId)!;
      expect(run.status).toBe("failed");
      expect(fanoutNode(runId)).toMatchObject({
        status: "failed",
        error: { message: expect.stringContaining("Workflow Call children concurrency") },
      });
      expect(repository.listChildRuns(runId, "children")).toEqual([]);
    });
  }

  it("fails the run when the bound path is missing rather than falling back to a default", async () => {
    childWorkflow();
    const parent = plannedParent({ source: "node", nodeId: "plan", path: "fields.absent" });
    const run = await service.startManual({ workflowId: parent.id, input: {} });
    await executor.settle(executor.commands[0]!, { degree: 3 });

    expect(service.getRun(parent.id, run.id)?.status).toBe("failed");
    expect(fanoutNode(run.id).error?.message).toContain("Workflow Call children concurrency");
    expect(repository.listChildRuns(run.id, "children")).toEqual([]);
  });
});

describe("concurrency as an authored value", () => {
  const node = (concurrency: unknown) => ({
    id: "children", type: "workflow-call", name: "Children",
    config: { workflowId: { source: "fixed", value: "child-flow" }, concurrency },
  });

  it("accepts a bare number and every binding source", () => {
    for (const concurrency of [1, 16, DEGREE_FROM_PLAN, { source: "fixed", value: 4 }, { source: "input", path: "degree" }]) {
      expect(workflowNodeSchema.parse(node(concurrency))).toEqual(node(concurrency));
    }
  });

  it("rejects a value outside the authored bounds in either arm", () => {
    for (const concurrency of [0, 17, 2.5, "4", null, { source: "fixed", value: 0 }, { source: "fixed", value: 17 }]) {
      expect(workflowNodeSchema.safeParse(node(concurrency)).success).toBe(false);
    }
  });

  it("reports a concurrency binding that does not point at a predecessor", () => {
    const definition: WorkflowDefinition = {
      ...service.createDefinition({ id: "unreachable-degree", title: "Unreachable degree" }),
      nodes: [
        { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
        { id: "children", type: "workflow-call", name: "Children", config: {
          workflowId: { source: "fixed", value: "child-flow" },
          concurrency: { source: "node", nodeId: "finish", path: "fields.degree" },
        } },
        { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
      ],
      edges: [edge("start-children", "start", "success", "children"), edge("children-finish", "children", "success", "finish")],
    };

    const result = validateExecutableWorkflow(definition);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues).toContainEqual(expect.objectContaining({
      code: "non-predecessor-binding", nodeId: "children", path: "nodes.1.config.concurrency",
    }));
  });
});
