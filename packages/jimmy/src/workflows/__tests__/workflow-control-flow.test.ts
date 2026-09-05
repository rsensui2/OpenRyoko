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
import { validateExecutableWorkflow } from "../validation.js";

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
    return { sessionId: this.sessionId(command.owner.nodeId, command.owner.attempt) };
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
      sessionId: this.sessionId(nodeId, command.owner.attempt), owner: command.owner, terminalVersion: 1, turn: 1,
      outcome: "succeeded", finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\``,
      completedAt: new Date().toISOString(),
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
  private sessionId(nodeId: string, attempt: number): string { return `session:${nodeId}:${attempt}`; }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let service: WorkflowService;
let now: Date;

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

function saveDefinition(id: string, nodes: WorkflowNode[], edges: WorkflowDefinition["edges"]): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({
    ...created,
    inputs: [
      { key: "score", label: "Score", type: "number", required: false },
      { key: "labels", label: "Labels", type: "string", required: false },
    ],
    nodes,
    edges,
  }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-control-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  executor = new FakeExecutor();
  now = new Date("2026-07-21T10:00:00.000Z");
  service = new WorkflowService({
    repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models,
    now: () => now.toISOString(),
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Workflow durable control flow", () => {
  it("resolves an End output binding into the completed node fields", async () => {
    const definition = saveDefinition("end-output", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "finish", type: "end", name: "Finish", config: {
        result: "success", output: { source: "fixed", value: { result: "shipped", count: 2 } },
      } },
    ], [edge("start-finish", "start", "success", "finish")]);

    const run = await service.startManual({ workflowId: definition.id, input: {} });

    expect(run.status).toBe("completed");
    expect(run.nodeRuns.find((node) => node.nodeId === "finish")?.output).toEqual({
      text: "",
      fields: { result: "shipped", count: 2 },
    });
  });

  it("fails an End whose output binding resolves to a non-object value", async () => {
    const definition = saveDefinition("invalid-end-output", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "finish", type: "end", name: "Finish", config: {
        result: "success", output: { source: "fixed", value: "not-an-object" },
      } },
    ], [edge("start-finish", "start", "success", "finish")]);

    const run = await service.startManual({ workflowId: definition.id, input: {} });

    expect(run.status).toBe("failed");
    expect(run.nodeRuns.find((node) => node.nodeId === "finish")).toMatchObject({
      status: "failed",
      error: { message: expect.stringMatching(/End finish output must resolve to a JSON object/) },
    });
  });

  it.each([
    [{ score: 9, labels: ["urgent", "release"] }, "first", "chosen"],
    [{ score: 7, labels: ["release"] }, "second", "chosen-second"],
    [{ score: 1, labels: [] }, "otherwise", "defaulted"],
  ] as const)("evaluates ordered Condition cases with all predicates and selects %s", async (input, expectedPort, expectedEnd) => {
    const definition = saveDefinition(`condition-${expectedPort}`, [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "choose", type: "condition", name: "Choose", config: {
        cases: [
          { port: "first", label: "First", all: [
            { left: { source: "input", path: "score" }, operator: "gte", right: { source: "fixed", value: 8 } },
            { left: { source: "input", path: "labels" }, operator: "contains", right: { source: "fixed", value: "urgent" } },
          ] },
          { port: "second", label: "Second", all: [
            { left: { source: "input", path: "score" }, operator: "gte", right: { source: "fixed", value: 5 } },
          ] },
        ],
        defaultPort: "otherwise",
      } },
      { id: "chosen", type: "end", name: "Chosen", config: { result: "success" } },
      { id: "chosen-second", type: "end", name: "Second", config: { result: "success" } },
      { id: "defaulted", type: "end", name: "Default", config: { result: "success" } },
    ], [
      edge("start-choice", "start", "success", "choose"),
      edge("choice-first", "choose", "first", "chosen"),
      edge("choice-second", "choose", "second", "chosen-second"),
      edge("choice-default", "choose", "otherwise", "defaulted"),
    ]);

    const canonicalInput = { score: input.score, labels: [...input.labels] };
    const first = await service.startManual({ workflowId: definition.id, input: canonicalInput, idempotencyKey: "same-run" });
    const replay = await service.startManual({ workflowId: definition.id, input: canonicalInput, idempotencyKey: "same-run" });

    expect(first.status).toBe("completed");
    expect(first.nodeRuns.find((node) => node.nodeId === expectedEnd)?.status).toBe("completed");
    expect(first.nodeRuns.filter((node) => node.nodeType === "end" && node.nodeId !== expectedEnd)
      .every((node) => node.status === "skipped")).toBe(true);
    expect(first.nodeRuns.find((node) => node.nodeId === "choose")?.output?.fields).toEqual({ port: expectedPort });
    expect(replay).toEqual(first);
  });

  it("waits for every activated Merge predecessor, exposes outputs by node id, and replays once", async () => {
    const definition = saveDefinition("parallel-merge", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      employeeNode("alpha"), employeeNode("beta"),
      { id: "join", type: "merge", name: "Join", config: { mode: "wait-all" } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ], [
      edge("start-alpha", "start", "success", "alpha"), edge("start-beta", "start", "success", "beta"),
      edge("alpha-join", "alpha", "success", "join"), edge("beta-join", "beta", "success", "join"),
      edge("join-finish", "join", "success", "finish"),
    ]);
    const started = await service.startManual({ workflowId: definition.id, input: {} });
    expect(executor.commands.map((command) => command.owner.nodeId)).toEqual(["alpha", "beta"]);
    expect(executor.commands[0]?.prompt).toContain("Run alpha.\n\n---\n");
    expect(executor.commands[0]?.prompt).toContain("Calling `workflow_submit_output` is what completes this workflow step");

    await executor.succeed("alpha", { value: "A" });
    expect(service.getRun(definition.id, started.id)).toMatchObject({ status: "running" });
    expect(service.getRun(definition.id, started.id)?.nodeRuns.find((node) => node.nodeId === "join"))
      .toMatchObject({ activated: true, status: "pending" });

    await executor.succeed("beta", { value: "B" });
    const completed = service.getRun(definition.id, started.id)!;
    const join = completed.nodeRuns.find((node) => node.nodeId === "join")!;
    expect(completed.status).toBe("completed");
    expect(join).toMatchObject({ status: "completed", output: { fields: { byNode: {
      alpha: { text: "Done.\n", fields: { value: "A" }, employeeId: "worker", engine: "test-engine", model: "test-model", sessionId: "session:alpha:1" },
      beta: { text: "Done.\n", fields: { value: "B" }, employeeId: "worker", engine: "test-engine", model: "test-model", sessionId: "session:beta:1" },
    } } } });
    const revision = completed.revision;
    await executor.succeed("beta", { value: "B" });
    expect(service.getRun(definition.id, started.id)).toMatchObject({ revision, status: "completed" });
  });

  it("waits for deep fanout predecessors that remain reachable before freezing Merge output", async () => {
    const definition = saveDefinition("deep-parallel-merge", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      employeeNode("alpha"), employeeNode("alpha-two"), employeeNode("beta"), employeeNode("beta-two"),
      { id: "join", type: "merge", name: "Join", config: { mode: "wait-all" } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ], [
      edge("start-alpha", "start", "success", "alpha"), edge("alpha-two", "alpha", "success", "alpha-two"),
      edge("start-beta", "start", "success", "beta"), edge("beta-two", "beta", "success", "beta-two"),
      edge("alpha-join", "alpha-two", "success", "join"), edge("beta-join", "beta-two", "success", "join"),
      edge("join-finish", "join", "success", "finish"),
    ]);
    const started = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.succeed("alpha", { value: "A1" });
    expect(executor.commands.find((item) => item.owner.nodeId === "alpha-two")?.prompt)
      .toContain("`alpha: session:alpha:1`");
    await executor.succeed("alpha-two", { value: "A2" });

    const half = service.getRun(definition.id, started.id)!;
    expect(half.status).toBe("running");
    expect(half.nodeRuns.find((node) => node.nodeId === "join")).toMatchObject({ activated: true, status: "pending" });
    expect(half.nodeRuns.find((node) => node.nodeId === "finish")?.status).toBe("pending");

    await executor.succeed("beta", { value: "B1" });
    await executor.succeed("beta-two", { value: "B2" });
    const completed = service.getRun(definition.id, started.id)!;
    expect(completed.status).toBe("completed");
    expect(completed.nodeRuns.find((node) => node.nodeId === "join")?.output?.fields.byNode)
      .toMatchObject({ "alpha-two": { fields: { value: "A2" } }, "beta-two": { fields: { value: "B2" } } });
  });

  it("rejects invalid Condition node bindings while preserving legitimate missing-value predicates", async () => {
    const created = repository.createDefinition({ id: "condition-bindings", title: "Condition bindings" });
    const nodes: WorkflowNode[] = [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      employeeNode("source"), employeeNode("sibling"),
      { id: "choose", type: "condition", name: "Choose", config: { cases: [{ port: "found", label: "Found", all: [{
        left: { source: "node", nodeId: "source", path: "fields.value" }, operator: "exists",
      }] }], defaultPort: "absent" } },
      { id: "found", type: "end", name: "Found", config: { result: "success" } },
      { id: "absent", type: "end", name: "Absent", config: { result: "success" } },
      { id: "sibling-end", type: "end", name: "Sibling", config: { result: "success" } },
    ];
    const edges = [
      edge("start-source", "start", "success", "source"), edge("source-choose", "source", "success", "choose"),
      edge("choose-found", "choose", "found", "found"), edge("choose-absent", "choose", "absent", "absent"),
      edge("start-sibling", "start", "success", "sibling"), edge("sibling-end", "sibling", "success", "sibling-end"),
    ];
    const definition = { ...created, nodes, edges };
    const binding = definition.nodes.find((node) => node.id === "choose")! as Extract<WorkflowNode, { type: "condition" }>;
    const withLeft = (left: typeof binding.config.cases[number]["all"][number]["left"]): WorkflowDefinition => ({
      ...definition, nodes: nodes.map((node) => node.id === "choose" ? {
        ...binding, config: { ...binding.config, cases: [{ ...binding.config.cases[0]!, all: [{ ...binding.config.cases[0]!.all[0]!, left }] }] },
      } : node),
    });

    expect(validateExecutableWorkflow(withLeft({ source: "node", nodeId: "ghost", path: "fields.value" })).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "unknown-node-binding", nodeId: "choose" })]));
    expect(validateExecutableWorkflow(withLeft({ source: "node", nodeId: "sibling", path: "fields.value" })).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "non-predecessor-binding", nodeId: "choose" })]));
    expect(validateExecutableWorkflow(withLeft({ source: "node", nodeId: "source", path: "fields..value" })).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "invalid-definition" })]));

    const absent = saveDefinition("legitimate-absence", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "choose", type: "condition", name: "Choose", config: { cases: [{ port: "present", label: "Present", all: [{
        left: { source: "input", path: "score" }, operator: "exists",
      }] }], defaultPort: "missing" } },
      { id: "present", type: "end", name: "Present", config: { result: "success" } },
      { id: "missing", type: "end", name: "Missing", config: { result: "success" } },
    ], [edge("start-choose", "start", "success", "choose"), edge("present", "choose", "present", "present"),
      edge("missing", "choose", "missing", "missing")]);
    const run = await service.startManual({ workflowId: absent.id, input: {} });
    expect(run.nodeRuns.find((node) => node.nodeId === "missing")?.status).toBe("completed");
  });

  it("persists Wait resumeAt, reconstructs, resumes once when due, and stays cancelled", async () => {
    const definition = saveDefinition("durable-wait", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "pause", type: "wait", name: "Pause", config: { mode: "duration", minutes: 5 } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ], [edge("start-pause", "start", "success", "pause"), edge("pause-finish", "pause", "success", "finish")]);
    const waiting = await service.startManual({ workflowId: definition.id, input: {} });
    expect(waiting).toMatchObject({ status: "waiting" });
    expect(waiting.nodeRuns.find((node) => node.nodeId === "pause")).toMatchObject({
      activated: true, status: "waiting", resumeAt: "2026-07-21T10:05:00.000Z",
    });

    service.dispose();
    now = new Date("2026-07-21T10:05:00.000Z");
    service = new WorkflowService({
      repository, executor: executor as unknown as WorkflowSessionExecutor,
      employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString(),
    });
    await expect(service.recover(now.toISOString())).resolves.toEqual({ resumedRuns: 0, resumedWaits: 1, resumedComments: 0 });
    const completed = service.getRun(definition.id, waiting.id)!;
    expect(completed.status).toBe("completed");
    expect(completed.nodeRuns.find((node) => node.nodeId === "pause")).toMatchObject({ status: "completed" });
    const revision = completed.revision;
    await expect(service.recover(now.toISOString())).resolves.toEqual({ resumedRuns: 0, resumedWaits: 0, resumedComments: 0 });
    expect(service.getRun(definition.id, waiting.id)?.revision).toBe(revision);

    now = new Date("2026-07-21T11:00:00.000Z");
    const another = await service.startManual({ workflowId: definition.id, input: {} });
    const cancelled = await service.cancelRun({ workflowId: definition.id, runId: another.id, reason: "no longer needed" });
    now = new Date("2026-07-21T12:00:00.000Z");
    await expect(service.recover(now.toISOString())).resolves.toEqual({ resumedRuns: 0, resumedWaits: 0, resumedComments: 0 });
    expect(service.getRun(definition.id, another.id)).toEqual(cancelled);
  });

  it.each(["approve", "reject"] as const)("persists and reconstructs an authorized Approval %s audit", async (decision) => {
    const definition = saveDefinition(`durable-${decision}`, [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "review", type: "approval", name: "Review", config: {
        description: "Approve the result", approver: { source: "fixed", value: "reviewer" },
      } },
      { id: "accepted", type: "end", name: "Accepted", config: { result: "success" } },
      { id: "declined", type: "end", name: "Declined", config: { result: "success" } },
    ], [
      edge("start-review", "start", "success", "review"), edge("review-approved", "review", "approved", "accepted"),
      edge("review-rejected", "review", "rejected", "declined"),
    ]);
    const waiting = await service.startManual({ workflowId: definition.id, input: {} });
    expect(waiting).toMatchObject({ status: "waiting", approvals: [{
      nodeId: "review", status: "pending", requestedAt: now.toISOString(), approverRef: "reviewer",
    }] });
    await expect(service.decideApproval({ workflowId: definition.id, runId: waiting.id, nodeId: "review",
      decision, decidedBy: "intruder", expectedRevision: waiting.revision })).rejects.toThrow(/not authorized/i);

    service.dispose();
    service = new WorkflowService({
      repository, executor: executor as unknown as WorkflowSessionExecutor,
      employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString(),
    });
    const decided = await service.decideApproval({ workflowId: definition.id, runId: waiting.id, nodeId: "review",
      decision, decidedBy: "reviewer", reason: decision === "reject" ? "Needs changes" : undefined,
      expectedRevision: waiting.revision });
    expect(decided.status).toBe("completed");
    expect(decided.approvals).toEqual([expect.objectContaining({
      nodeId: "review", status: decision === "approve" ? "approved" : "rejected", decision,
      decidedBy: "reviewer", decidedAt: now.toISOString(), ...(decision === "reject" ? { reason: "Needs changes" } : {}),
    })]);
    expect(decided.nodeRuns.find((node) => node.nodeId === (decision === "approve" ? "accepted" : "declined"))?.status)
      .toBe("completed");
    await expect(service.decideApproval({ workflowId: definition.id, runId: waiting.id, nodeId: "review",
      decision, decidedBy: "reviewer", expectedRevision: decided.revision })).rejects.toThrow(/already decided/i);
  });

  it("fails an Approval and its run atomically when the selected authored port has no route", async () => {
    const definition = saveDefinition("approval-missing-route", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "review", type: "approval", name: "Review", config: {
        description: "Approve the result", approver: { source: "fixed", value: "reviewer" },
      } },
      { id: "accepted", type: "end", name: "Accepted", config: { result: "success" } },
    ], [edge("start-review", "start", "success", "review"), edge("approved", "review", "approved", "accepted")]);
    const waiting = await service.startManual({ workflowId: definition.id, input: {} });
    const rejected = await service.decideApproval({ workflowId: definition.id, runId: waiting.id, nodeId: "review",
      decision: "reject", decidedBy: "reviewer", reason: "No", expectedRevision: waiting.revision });

    expect(rejected).toMatchObject({ status: "failed", error: { code: "workflow-approval-route-missing", nodeId: "review" } });
    expect(rejected.approvals).toEqual([expect.objectContaining({ status: "rejected", decision: "reject", reason: "No" })]);
    expect(rejected.nodeRuns.find((node) => node.nodeId === "review"))
      .toMatchObject({ status: "failed", error: { code: "workflow-approval-route-missing" } });
  });
});
