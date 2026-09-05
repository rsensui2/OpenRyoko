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
import type { JsonValue, WorkflowCallNode, WorkflowDefinition, WorkflowNode } from "../model.js";
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

class Executor {
  readonly commands: WorkflowAttemptCommand[] = [];
  readonly stopped: string[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: this.sessionId(command) };
  }
  async stopAttempt(input: { sessionId: string }): Promise<void> { this.stopped.push(input.sessionId); }
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  readTerminalCompletion(): null { return null; }
  async settle(command: WorkflowAttemptCommand, outcome: "succeeded" | "failed", fields: Record<string, JsonValue> = {}): Promise<void> {
    const event: WorkflowAttemptCompletion = {
      sessionId: this.sessionId(command),
      owner: command.owner,
      terminalVersion: 1,
      turn: 1,
      outcome,
      ...(outcome === "succeeded"
        ? { finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\`` }
        : { error: "Child failed." }),
      completedAt: "2026-08-05T12:05:00.000Z",
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
  private sessionId(command: WorkflowAttemptCommand): string {
    return `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}`;
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

function childWorkflow(id = "child-flow"): WorkflowDefinition {
  return save(id, [
    { id: "start", type: "trigger", name: "Called", config: { kind: "workflow-call" } },
    { id: "work", type: "employee", name: "Work", config: {
      employee: { source: "fixed", value: "worker" }, prompt: "Process {{ input.topic }}.",
      retry: { attempts: 1, delaySeconds: 0, backoff: "fixed" },
    } },
    { id: "finish", type: "end", name: "Finish", config: {
      result: "success", output: { source: "node", nodeId: "work", path: "fields" },
    } },
  ], [edge("start-work", "start", "success", "work"), edge("work-finish", "work", "success", "finish")]);
}

function parentWorkflow(id = "parent-flow", options: { items?: JsonValue[]; concurrency?: number } = {}): WorkflowDefinition {
  const items = options.items ?? [
    { topic: "alpha" }, { topic: "beta" }, { topic: "gamma" }, { topic: "delta" },
  ];
  const call: WorkflowNode = { id: "children", type: "workflow-call", name: "Children", config: {
    workflowId: { source: "fixed", value: "child-flow" },
    items: { source: "fixed", value: items },
    input: {
      topic: { source: "trigger", path: "item.topic" },
      ordinal: { source: "trigger", path: "itemIndex" },
    },
    concurrency: options.concurrency ?? 2,
  } };
  return save(id, [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    call,
    { id: "route", type: "condition", name: "Route", config: {
      cases: [{ port: "partial", label: "Partial", all: [{
        left: { source: "node", nodeId: "children", path: "fields.summary" },
        operator: "equals", right: { source: "fixed", value: "partial" },
      }] }],
      defaultPort: "other",
    } },
    { id: "partial", type: "end", name: "Partial", config: {
      result: "success", output: { source: "fixed", value: { route: "partial" } },
    } },
    { id: "other", type: "end", name: "Other", config: {
      result: "success", output: { source: "fixed", value: { route: "other" } },
    } },
  ], [
    edge("start-children", "start", "success", "children"),
    edge("children-route", "children", "success", "route"),
    edge("route-partial", "route", "partial", "partial"),
    edge("route-other", "route", "other", "other"),
  ]);
}

function todoCallParent(id: string, workflowId: string, input: NonNullable<WorkflowCallNode["config"]["input"]>,
  item: JsonValue): WorkflowDefinition {
  return save(id, [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "children", type: "workflow-call", name: "Children", config: {
      workflowId: { source: "fixed", value: workflowId },
      items: { source: "fixed", value: [item] },
      input,
      concurrency: 1,
    } },
    { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
  ], [edge("call", "start", "success", "children"), edge("finish", "children", "success", "finish")]);
}

function nonTerminalChildren(parentRunId: string): number {
  return repository.listChildRuns(parentRunId, "children")
    .filter((child) => !["completed", "failed", "cancelled"].includes(child.status)).length;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-fanout-"));
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

describe("Workflow Call fan-out", () => {
  it("binds a direct call to a validated Todo and includes it in idempotency", async () => {
    const target = childWorkflow("todo-call-target");
    const callerDefinition = save("todo-call-caller", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "work", type: "employee", name: "Work", config: {
        employee: { source: "fixed", value: "worker" }, prompt: "Call the child.",
      } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ], [edge("work", "start", "success", "work"), edge("finish", "work", "success", "finish")]);
    const callerRun = await service.startManual({ workflowId: callerDefinition.id, input: {} });
    const call = {
      workflowId: target.id,
      caller: { workflowId: callerDefinition.id, runId: callerRun.id, nodeId: "work" },
      input: { topic: "bound" },
      idempotencyKey: "todo-bound-call",
      itemIndex: 4,
    };

    const first = await service.callWorkflow({ ...call, todoId: "PLA-9" });
    const replay = await service.callWorkflow({ ...call, todoId: "PLA-9" });

    expect(first.trigger.todoId).toBe("PLA-9");
    expect(replay.id).toBe(first.id);
    await expect(service.callWorkflow({ ...call, todoId: "PLA-10" })).rejects.toMatchObject({
      code: "idempotency-conflict",
    });

    const runCount = service.listRuns(target.id, {}).items.length;
    for (const [index, todoId] of ["pla-9", "PLA-0", "NOTATODO", 9].entries()) {
      await expect(service.callWorkflow({
        ...call,
        idempotencyKey: `invalid-todo-${index}`,
        todoId: todoId as string,
      })).rejects.toMatchObject({ code: "bad-input" });
      expect(service.listRuns(target.id, {}).items).toHaveLength(runCount);
    }
  });

  it("lifts a mapped Todo id onto the child trigger without removing it from input", async () => {
    const child = childWorkflow("mapped-todo-child");
    const parent = todoCallParent("mapped-todo-parent", child.id, {
      todoId: { source: "trigger", path: "item.todoId" },
      topic: { source: "trigger", path: "item.topic" },
    }, { todoId: "OPS-7", topic: "mapped" });

    const run = await service.startManual({ workflowId: parent.id, input: {} });
    const childSummary = repository.listChildRuns(run.id, "children")[0]!;
    const childRun = service.getRun(childSummary.workflowId, childSummary.runId)!;

    expect(childRun.trigger.todoId).toBe("OPS-7");
    expect(childRun.input).toEqual({ todoId: "OPS-7", topic: "mapped" });
  });

  it("keeps a child unbound when its input mapping has no Todo id", async () => {
    const child = childWorkflow("unbound-todo-child");
    const parent = todoCallParent("unbound-todo-parent", child.id, {
      topic: { source: "trigger", path: "item.topic" },
    }, { topic: "unbound" });

    const run = await service.startManual({ workflowId: parent.id, input: {} });
    const childSummary = repository.listChildRuns(run.id, "children")[0]!;
    const childRun = service.getRun(childSummary.workflowId, childSummary.runId)!;

    expect(childRun.trigger).not.toHaveProperty("todoId");
    expect(childRun.input).toEqual({ topic: "unbound" });
  });

  it("fails the Workflow Call node when its mapped Todo id is malformed", async () => {
    const child = childWorkflow("invalid-todo-child");
    const parent = todoCallParent("invalid-todo-parent", child.id, {
      todoId: { source: "trigger", path: "item.todoId" },
      topic: { source: "trigger", path: "item.topic" },
    }, { todoId: "not-a-todo", topic: "invalid" });

    const run = await service.startManual({ workflowId: parent.id, input: {} });

    expect(run.status).toBe("failed");
    expect(run.nodeRuns.find((node) => node.nodeId === "children")).toMatchObject({
      status: "failed",
      error: { message: expect.stringMatching(/Workflow Call children.*AAA-123/) },
    });
    expect(repository.listChildRuns(run.id, "children")).toEqual([]);
  });

  it("bounds concurrency, maps each item, joins failures, and routes on summary", async () => {
    childWorkflow();
    const parent = parentWorkflow();

    const started = await service.startManual({ workflowId: parent.id, input: {} });

    expect(executor.commands).toHaveLength(2);
    expect(nonTerminalChildren(started.id)).toBe(2);
    expect(repository.listChildRuns(started.id, "children").map((child) => ({
      itemIndex: child.itemIndex,
      caller: service.getRun(child.workflowId, child.runId)?.trigger.payload.caller,
      input: service.getRun(child.workflowId, child.runId)?.input,
    }))).toEqual([
      { itemIndex: 0, caller: { workflowId: parent.id, runId: started.id, nodeId: "children" }, input: { topic: "alpha", ordinal: 0 } },
      { itemIndex: 1, caller: { workflowId: parent.id, runId: started.id, nodeId: "children" }, input: { topic: "beta", ordinal: 1 } },
    ]);

    await executor.settle(executor.commands[0]!, "succeeded", { result: "done-alpha" });
    await vi.waitFor(() => expect(executor.commands).toHaveLength(3));
    expect(nonTerminalChildren(started.id)).toBeLessThanOrEqual(2);

    await executor.settle(executor.commands[1]!, "failed");
    await vi.waitFor(() => expect(executor.commands).toHaveLength(4));
    expect(nonTerminalChildren(started.id)).toBeLessThanOrEqual(2);

    await executor.settle(executor.commands[2]!, "succeeded", { result: "done-gamma" });
    await executor.settle(executor.commands[3]!, "succeeded", { result: "done-delta" });
    await vi.waitFor(() => expect(service.getRun(parent.id, started.id)?.status).toBe("completed"));

    const completed = service.getRun(parent.id, started.id)!;
    expect(completed.nodeRuns.find((node) => node.nodeId === "children")?.output?.fields).toEqual({
      total: 4,
      succeeded: 3,
      failed: 1,
      cancelled: 0,
      summary: "partial",
      outcomes: [
        expect.objectContaining({ index: 0, workflowId: "child-flow", status: "succeeded", fields: { result: "done-alpha" } }),
        expect.objectContaining({ index: 1, workflowId: "child-flow", status: "failed", fields: {} }),
        expect.objectContaining({ index: 2, workflowId: "child-flow", status: "succeeded", fields: { result: "done-gamma" } }),
        expect.objectContaining({ index: 3, workflowId: "child-flow", status: "succeeded", fields: { result: "done-delta" } }),
      ],
    });
    expect(completed.nodeRuns.find((node) => node.nodeId === "partial")?.output?.fields).toEqual({ route: "partial" });
    expect(completed.nodeRuns.find((node) => node.nodeId === "other")?.status).toBe("skipped");
  });

  it("starts exactly one child when items is absent", async () => {
    const child = save("single-child", [
      { id: "start", type: "trigger", name: "Called", config: { kind: "workflow-call" } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ], [edge("finish", "start", "success", "finish")]);
    const parent = save("single-parent", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "children", type: "workflow-call", name: "Child", config: {
        workflowId: { source: "fixed", value: child.id }, concurrency: 2,
      } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ], [edge("call", "start", "success", "children"), edge("finish", "children", "success", "finish")]);

    const run = await service.startManual({ workflowId: parent.id, input: {} });

    expect(run.status).toBe("completed");
    expect(repository.listChildRuns(run.id, "children")).toHaveLength(1);
    expect(repository.listChildRuns(run.id, "children")[0]).toMatchObject({ itemIndex: 0, status: "completed" });
  });

  it("cancels every non-terminal child when its parent is cancelled", async () => {
    childWorkflow();
    const parent = parentWorkflow("cancel-parent", { items: [{ topic: "one" }, { topic: "two" }, { topic: "three" }] });
    const run = await service.startManual({ workflowId: parent.id, input: {} });
    expect(repository.listChildRuns(run.id, "children")).toHaveLength(2);

    await service.cancelRun({ workflowId: parent.id, runId: run.id, reason: "Stop the batch." });

    expect(service.getRun(parent.id, run.id)?.status).toBe("cancelled");
    expect(repository.listChildRuns(run.id, "children").map((child) => child.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("does not leave a child running when fan-out creation races parent cancellation", async () => {
    childWorkflow();
    const parent = parentWorkflow("racing-cancel-parent", {
      items: [{ topic: "one" }, { topic: "two" }, { topic: "three" }],
      concurrency: 2,
    });
    const originalCallWorkflow = service.callWorkflow.bind(service);
    const originalCancelRun = service.cancelRun.bind(service);
    let releaseSecondCall!: () => void;
    let secondCallEntered!: () => void;
    let releaseChildCancellation!: () => void;
    let childCancellationEntered!: () => void;
    const secondCallBlocked = new Promise<void>((resolve) => { secondCallEntered = resolve; });
    const secondCallReleased = new Promise<void>((resolve) => { releaseSecondCall = resolve; });
    const childCancellationBlocked = new Promise<void>((resolve) => { childCancellationEntered = resolve; });
    const childCancellationReleased = new Promise<void>((resolve) => { releaseChildCancellation = resolve; });
    let calls = 0;
    vi.spyOn(service, "callWorkflow").mockImplementation(async (input) => {
      calls += 1;
      if (calls === 2) {
        secondCallEntered();
        await secondCallReleased;
      }
      return originalCallWorkflow(input);
    });
    vi.spyOn(service, "cancelRun").mockImplementation(async (input) => {
      if (input.workflowId === "child-flow") {
        childCancellationEntered();
        await childCancellationReleased;
      }
      return originalCancelRun(input);
    });

    const starting = service.startManual({ workflowId: parent.id, input: {} });
    await secondCallBlocked;
    const started = repository.listRuns(parent.id, { limit: 10 }).items[0]!;
    const cancelling = service.cancelRun({ workflowId: parent.id, runId: started.id, reason: "Stop the batch." });
    await childCancellationBlocked;
    releaseSecondCall();
    await starting;
    releaseChildCancellation();
    await cancelling;

    expect(service.getRun(parent.id, started.id)?.status).toBe("cancelled");
    expect(repository.listChildRuns(started.id, "children").every((child) => child.status === "cancelled")).toBe(true);
    expect(nonTerminalChildren(started.id)).toBe(0);
  });

  it("fails the node with the recursion error for a dynamic self target", async () => {
    const created = service.createDefinition({ id: "dynamic-recursion", title: "Dynamic recursion" });
    const saved = service.saveDefinition({
      ...created,
      inputs: [{ key: "target", label: "Target", type: "string", required: true }],
      nodes: [
        { id: "start", type: "trigger", name: "Start", config: { kind: "workflow-call" } },
        { id: "children", type: "workflow-call", name: "Children", config: {
          workflowId: { source: "input", path: "target" }, concurrency: 1,
        } },
        { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
      ],
      edges: [edge("call", "start", "success", "children"), edge("finish", "children", "success", "finish")],
    }, created.revision);
    const enabled = service.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision });
    const bootstrap = save("recursion-bootstrap", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "work", type: "employee", name: "Work", config: {
        employee: { source: "fixed", value: "worker" }, prompt: "Start child.",
      } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ], [edge("work", "start", "success", "work"), edge("finish", "work", "success", "finish")]);
    const bootstrapRun = await service.startManual({ workflowId: bootstrap.id, input: {} });

    const run = await service.callWorkflow({
      workflowId: enabled.id,
      caller: { workflowId: bootstrap.id, runId: bootstrapRun.id, nodeId: "work" },
      input: { target: enabled.id },
      idempotencyKey: "recursive-entry",
    });

    expect(run.status).toBe("failed");
    expect(run.nodeRuns.find((node) => node.nodeId === "children")).toMatchObject({
      status: "failed",
      error: { message: expect.stringMatching(/recursion/i) },
    });
  });

  it("recovers a parent after its children settle while the service is down without duplicates", async () => {
    const child = save("parked-child", [
      { id: "start", type: "trigger", name: "Called", config: { kind: "workflow-call" } },
      { id: "pause", type: "wait", name: "Pause", config: { mode: "duration", minutes: 60 } },
      { id: "finish", type: "end", name: "Finish", config: {
        result: "success", output: { source: "fixed", value: { recovered: true } },
      } },
    ], [edge("pause", "start", "success", "pause"), edge("finish", "pause", "success", "finish")]);
    const parent = save("recover-parent", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "children", type: "workflow-call", name: "Children", config: {
        workflowId: { source: "fixed", value: child.id },
        items: { source: "fixed", value: ["one", "two"] },
        concurrency: 2,
      } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ], [edge("children", "start", "success", "children"), edge("finish", "children", "success", "finish")]);
    const run = await service.startManual({ workflowId: parent.id, input: {} });
    const children = repository.listChildRuns(run.id, "children");
    expect(children).toHaveLength(2);
    expect(children.map((item) => item.status)).toEqual(["waiting", "waiting"]);

    service.dispose();
    for (const childRun of children) {
      const detail = repository.getRun(childRun.workflowId, childRun.runId)!;
      repository.mutateRun(detail.id, detail.revision, (tx) => {
        tx.setNodeStatus("pause", "completed", { output: { text: "", fields: {} }, endedAt: "2026-08-05T12:05:00.000Z" });
        tx.setNodeStatus("finish", "completed", { activated: true,
          output: { text: "", fields: { recovered: true } }, startedAt: "2026-08-05T12:05:00.000Z", endedAt: "2026-08-05T12:05:00.000Z" });
        tx.setRunStatus("completed", { endedAt: "2026-08-05T12:05:00.000Z" });
      });
    }

    service = buildService();
    await service.recover("2026-08-05T12:05:00.000Z");

    expect(service.getRun(parent.id, run.id)?.status).toBe("completed");
    expect(repository.listChildRuns(run.id, "children")).toHaveLength(2);
    expect(service.getRun(parent.id, run.id)?.nodeRuns.find((node) => node.nodeId === "children")?.output?.fields)
      .toMatchObject({ total: 2, succeeded: 2, failed: 0, cancelled: 0, summary: "all-succeeded" });
  });
});
