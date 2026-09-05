import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletionListener } from "../../shared/types.js";
import type { Binding, WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository, WorkflowRepositoryError } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService, WorkflowServiceError } from "../service.js";

class Executor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: `session:${command.owner.runId}:${command.owner.nodeId}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  readTerminalCompletion(): null { return null; }
}

const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } };
const scheduleTrigger: WorkflowNode = { id: "start", type: "trigger", name: "Start",
  config: { kind: "schedule", cron: "0 * * * *", timezone: "UTC" } };
const eventTrigger: WorkflowNode = { id: "start", type: "trigger", name: "Start",
  config: { kind: "event", eventName: "build.finished" } };
const poisonSchedule: WorkflowNode = { id: "start", type: "trigger", name: "Start",
  config: { kind: "schedule", cron: "every weekday please", timezone: "UTC" } };
const todoTrigger: WorkflowNode = { id: "start", type: "trigger", name: "Start",
  config: { kind: "todo-status", status: "assigned" } };
const commentWait: WorkflowNode = { id: "hold", type: "wait", name: "Ask operator",
  config: { mode: "todo-comment", timeoutMinutes: 60 } };
const todoStatusTrigger: WorkflowNode = { id: "start", type: "trigger", name: "Start",
  config: { kind: "todo-status", status: "in_review", label: "build" } };
const conflictingTodoFilters: WorkflowNode = { id: "start", type: "trigger", name: "Start",
  config: { kind: "todo-status", status: "in_review", label: "build", unlabeled: true } };
const finish: WorkflowNode = { id: "finish", type: "end", name: "Finish", config: { result: "success" } };
const employee: Employee = { name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work." };
const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "test-model",
  effortMechanism: "codex-config", models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }] } };
const edge = (id: string, from: string, to: string) => ({
  id,
  from: { nodeId: from, port: "success" as const },
  to: { nodeId: to, port: "input" as const },
});

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: Executor;
let definitionChanges: Array<{ workflowId: string; revision: number }>;
let runChanges: Array<{ workflowId: string; runId: string }>;
let service: WorkflowService;

function save(id: string, nodes: WorkflowNode[], edges: ReturnType<typeof edge>[]): WorkflowDefinition {
  const created = service.createDefinition({ id, title: id });
  definitionChanges.length = 0;
  return service.saveDefinition({ ...created, nodes, edges }, created.revision);
}

function worker(employee: Binding<string> = { source: "fixed", value: "worker" }): WorkflowNode {
  return { id: "work", type: "employee", name: "Work", config: { employee, prompt: "Do work." } };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-service-validation-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database, () => "2026-07-22T10:00:00.000Z");
  executor = new Executor();
  definitionChanges = [];
  runChanges = [];
  service = new WorkflowService({
    repository,
    executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]),
    models: () => models,
    onDefinitionChange: (change) => definitionChanges.push(change),
    onChange: (change) => runChanges.push(change),
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Workflow executable service boundaries", () => {
  it("refuses a fixed self-targeting workflow-call before saving the draft", () => {
    const created = service.createDefinition({ id: "self-call", title: "Self call" });
    const call: WorkflowNode = { id: "children", type: "workflow-call", name: "Children", config: {
      workflowId: { source: "fixed", value: created.id }, concurrency: 2,
    } };
    const draft = { ...created, nodes: [trigger, call, finish], edges: [
      edge("start-call", "start", "children"), edge("call-finish", "children", "finish"),
    ] };

    expect(() => service.saveDefinition(draft, created.revision)).toThrow(expect.objectContaining({
      code: "invalid-definition",
      issues: [expect.objectContaining({ code: "workflow-call-self-reference", nodeId: "children" })],
    }));
    expect(repository.getDefinition(created.id)).toEqual(created);
  });

  it("rejects zero-node enable without changing the stored definition", () => {
    const created = service.createDefinition({ id: "empty-flow", title: "Empty flow" });
    definitionChanges.length = 0;
    let caught: unknown;

    expect(() => service.setEnabled({ id: created.id, enabled: true, expectedRevision: created.revision + 1 }))
      .toThrow(expect.objectContaining<Partial<WorkflowRepositoryError>>({ code: "revision-conflict" }));
    try { service.setEnabled({ id: created.id, enabled: true, expectedRevision: created.revision }); }
    catch (error) { caught = error; }

    expect(caught).toEqual(new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", [
      { code: "missing-end-path", message: "A Trigger must have a directed path to an End." },
      { code: "trigger-count", message: "Workflow must contain at least one Trigger." },
    ]));
    expect(repository.getDefinition(created.id)).toEqual(created);
    expect(definitionChanges).toEqual([]);
    expect(service.listRuns(created.id, {}).items).toEqual([]);
    expect(executor.commands).toEqual([]);
    expect(runChanges).toEqual([]);
  });

  it("rejects manual-trigger-only run before creating a run or dispatching a session", async () => {
    const saved = save("manual-only", [trigger], []);
    const enabled = repository.setEnabled(saved.id, true, saved.revision);
    definitionChanges.length = 0;
    let caught: unknown;

    try { await service.startManual({ workflowId: enabled.id, input: {} }); }
    catch (error) { caught = error; }

    expect(caught).toEqual(new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", [
      { code: "dead-node", message: "Reachable non-End node has no path to an End.", nodeId: "start" },
      { code: "missing-end-path", message: "A Trigger must have a directed path to an End." },
    ]));
    expect(service.listRuns(enabled.id, {}).items).toEqual([]);
    expect(executor.commands).toEqual([]);
    expect(runChanges).toEqual([]);
    expect(repository.getDefinition(enabled.id)).toEqual(enabled);
  });

  it("validates an enabled revision that deleted its Manual trigger before requiring that trigger", async () => {
    const authored = save("deleted-manual", [trigger, finish], [edge("start-finish", "start", "finish")]);
    const enabled = service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision });
    const revised = service.saveDefinition({ ...enabled, nodes: [finish], edges: [] }, enabled.revision);
    definitionChanges.length = 0;

    await expect(service.startManual({ workflowId: revised.id, input: {} })).rejects.toEqual(
      new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", [
        { code: "unreachable-node", message: "Node is not reachable from a Trigger.", nodeId: "finish" },
        { code: "missing-end-path", message: "A Trigger must have a directed path to an End." },
        { code: "trigger-count", message: "Workflow must contain at least one Trigger." },
      ]),
    );
    expect(revised).toMatchObject({ enabled: true, revision: enabled.revision + 1 });
    expect(repository.getDefinition(revised.id)).toEqual(revised);
    expect(definitionChanges).toEqual([]);
    expect(service.listRuns(revised.id, {}).items).toEqual([]);
    expect(executor.commands).toEqual([]);
    expect(runChanges).toEqual([]);
  });

  it.each([
    ["Schedule", scheduleTrigger],
    ["Event", eventTrigger],
  ])("keeps valid %s-only workflows executable before returning the no-Manual-trigger error", async (label, authoredTrigger) => {
    const authored = save(`valid-${label.toLowerCase()}`, [authoredTrigger, finish], [edge("start-finish", "start", "finish")]);
    const enabled = service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision });
    definitionChanges.length = 0;

    await expect(service.startManual({ workflowId: enabled.id, input: {} })).rejects.toEqual(
      new WorkflowRepositoryError("bad-input", "Workflow does not have an enabled manual trigger."),
    );
    expect(repository.getDefinition(enabled.id)).toEqual(enabled);
    expect(definitionChanges).toEqual([]);
    expect(service.listRuns(enabled.id, {}).items).toEqual([]);
    expect(executor.commands).toEqual([]);
    expect(runChanges).toEqual([]);
  });

  it("keeps disabled and absent workflow manual-start errors unchanged", async () => {
    const disabled = save("disabled-flow", [trigger, finish], [edge("start-finish", "start", "finish")]);
    definitionChanges.length = 0;

    for (const workflowId of [disabled.id, "missing-flow"]) {
      await expect(service.startManual({ workflowId, input: {} })).rejects.toEqual(
        new WorkflowRepositoryError("bad-input", "Workflow does not have an enabled manual trigger."),
      );
    }
    expect(repository.getDefinition(disabled.id)).toEqual(disabled);
    expect(definitionChanges).toEqual([]);
    expect(service.listRuns(disabled.id, {}).items).toEqual([]);
    expect(executor.commands).toEqual([]);
    expect(runChanges).toEqual([]);
  });

  it("preserves canonical field issue order, path, code, and message", () => {
    const authored = save("invalid-field", [
      trigger,
      worker({ source: "input", path: "assignee" }),
      finish,
    ], [edge("start-work", "start", "work"), edge("work-finish", "work", "finish")]);
    const expected = [{
      code: "undeclared-input",
      message: "Input binding references an undeclared Workflow input.",
      nodeId: "work",
      path: "nodes.1.config.employee",
    }];

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let caught: unknown;
      try { service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision }); }
      catch (error) { caught = error; }
      expect(caught).toEqual(new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", expected));
    }
    expect(repository.getDefinition(authored.id)).toEqual(authored);
    expect(definitionChanges).toEqual([{ workflowId: authored.id, revision: authored.revision }]);
  });

  it("refuses an unparseable Schedule cron expression on save and on enable", () => {
    const created = service.createDefinition({ id: "poison-schedule", title: "Poison schedule" });
    const poison = { ...created, nodes: [poisonSchedule, finish], edges: [edge("start-finish", "start", "finish")] };
    const expected = new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.",
      [{ code: "invalid-schedule", message: "schedule must be a valid cron expression", nodeId: "start", path: "config.cron" }]);
    definitionChanges.length = 0;
    let saveError: unknown;
    let enableError: unknown;

    try { service.saveDefinition(poison, created.revision); } catch (error) { saveError = error; }
    expect(saveError).toEqual(expected);
    expect(repository.getDefinition(created.id)).toEqual(created);

    // Seeded past the gate, exactly as a row authored before it existed would be.
    const stored = repository.saveDefinition(poison, created.revision);
    try { service.setEnabled({ id: stored.id, enabled: true, expectedRevision: stored.revision }); }
    catch (error) { enableError = error; }

    expect(enableError).toEqual(expected);
    expect(repository.getDefinition(stored.id)).toMatchObject({ enabled: false, revision: stored.revision });
    expect(definitionChanges).toEqual([]);
  });

  it("refuses a conflicting unlabeled+label revision of an already-enabled todo-status Workflow", () => {
    const authored = save("todo-filters", [todoStatusTrigger, finish], [edge("start-finish", "start", "finish")]);
    const enabled = service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision });
    definitionChanges.length = 0;
    let caught: unknown;

    try {
      service.saveDefinition({ ...enabled, nodes: [conflictingTodoFilters, finish] }, enabled.revision);
    } catch (error) { caught = error; }

    expect(caught).toEqual(new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", [{
      code: "conflicting-todo-filters",
      message: "A todo-status trigger cannot set both unlabeled and label: a Todo carrying no labels"
        + " can never carry the one named. Set only one.",
      nodeId: "start",
      path: "nodes.0.config.unlabeled",
    }]));
    expect(repository.getDefinition(enabled.id)).toEqual(enabled);
    expect(definitionChanges).toEqual([]);
  });

  it("cannot carry a Schedule trigger into createDefinition in the first place", () => {
    expect(() => service.createDefinition(
      { id: "created-with-nodes", title: "Created", nodes: [poisonSchedule] } as unknown as { id: string; title: string },
    )).toThrow(expect.objectContaining<Partial<WorkflowRepositoryError>>({ code: "bad-input" }));
    expect(repository.getDefinition("created-with-nodes")).toBeNull();
  });

  it("keeps valid enable, revision conflicts, and manual dispatch behavior unchanged", async () => {
    const authored = save("valid-flow", [trigger, worker(), finish], [
      edge("start-work", "start", "work"),
      edge("work-finish", "work", "finish"),
    ]);

    expect(() => service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision + 1 }))
      .toThrow(expect.objectContaining<Partial<WorkflowRepositoryError>>({ code: "revision-conflict" }));
    expect(repository.getDefinition(authored.id)).toEqual(authored);
    const enabled = service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision });
    expect(enabled).toMatchObject({ enabled: true, revision: authored.revision + 1 });

    const run = await service.startManual({ workflowId: enabled.id, input: {}, idempotencyKey: "valid-1" });
    const replay = await service.startManual({ workflowId: enabled.id, input: {}, idempotencyKey: "valid-1" });
    expect(run).toMatchObject({ workflowId: enabled.id, status: "running", definitionRevision: enabled.revision });
    expect(replay.id).toBe(run.id);
    expect(service.listRuns(enabled.id, {}).items).toHaveLength(1);
    expect(executor.commands).toHaveLength(1);
  });

  it.each([["schedule", scheduleTrigger], ["event", eventTrigger]] as const)(
    "refuses to save a Todo-comment Wait that only a %s Trigger reaches", (_kind, poisonTrigger) => {
      const created = service.createDefinition({ id: `${_kind}-comment-wait`, title: "Comment wait" });
      const poison = { ...created, nodes: [poisonTrigger, commentWait, finish],
        edges: [edge("start-hold", "start", "hold"), edge("hold-finish", "hold", "finish")] };

      let saveError: unknown;
      try { service.saveDefinition(poison, created.revision); } catch (error) { saveError = error; }
      expect(saveError).toEqual(new WorkflowServiceError("invalid-definition", "Workflow definition is invalid.", [{
        code: "todo-comment-wait-trigger",
        message: "A Wait node that waits for a Todo comment must be reachable from a Trigger that binds a Todo.",
        nodeId: "hold", path: "nodes.1.config.mode",
      }]));
      expect(repository.getDefinition(created.id)).toEqual(created);
    });

  it("saves and enables a Todo-comment Wait behind a todo-status Trigger", () => {
    const authored = save("todo-comment-wait", [todoTrigger, commentWait, finish], [
      edge("start-hold", "start", "hold"),
      edge("hold-finish", "hold", "finish"),
    ]);

    expect(service.setEnabled({ id: authored.id, enabled: true, expectedRevision: authored.revision }))
      .toMatchObject({ enabled: true });
  });

  it("leaves a disconnected Todo-comment Wait draft saveable", () => {
    const authored = save("draft-comment-wait", [scheduleTrigger, worker(), commentWait, finish], [
      edge("start-work", "start", "work"),
      edge("work-finish", "work", "finish"),
    ]);

    expect(authored.nodes.map((node) => node.id)).toContain("hold");
  });
});
