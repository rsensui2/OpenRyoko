import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Employee, ModelRegistry } from "../../shared/types.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";
import { type WorkflowTodoApprovalMirror } from "../runner.js";

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

/** Most of these workflows park on an Approval before any Employee node, so the
 *  executor only has to exist. The description-binding cases run one step first,
 *  and reach it back through `submitAttemptOutput` by this session id. */
const STEP_SESSION = "session:step";

function idleExecutor(): WorkflowSessionExecutor {
  return {
    async startAttempt() { return { sessionId: STEP_SESSION }; },
    async stopAttempt() {},
    subscribe() { return () => {}; },
    readTerminalCompletion() { return null; },
  } as unknown as WorkflowSessionExecutor;
}

class RecordingMirror implements WorkflowTodoApprovalMirror {
  readonly requests: Array<Parameters<WorkflowTodoApprovalMirror["request"]>[0]> = [];
  readonly parked: Array<Parameters<WorkflowTodoApprovalMirror["notifyParked"]>[0]> = [];
  request(input: Parameters<WorkflowTodoApprovalMirror["request"]>[0]): void { this.requests.push(input); }
  notifyParked(input: Parameters<WorkflowTodoApprovalMirror["notifyParked"]>[0]): void { this.parked.push(input); }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let mirror: RecordingMirror;
let service: WorkflowService;
const now = new Date("2026-07-21T10:00:00.000Z");

function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}

function saveDefinition(id: string, nodes: WorkflowNode[], edges: WorkflowDefinition["edges"]): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({ ...created, inputs: [], nodes, edges }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

/** A workflow that parks on one Approval node and ends either way. */
function gateDefinition(id: string, config: Record<string, unknown>): WorkflowDefinition {
  return saveDefinition(id, [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "review", type: "approval", name: "Review", config } as WorkflowNode,
    { id: "accepted", type: "end", name: "Accepted", config: { result: "success" } },
    { id: "declined", type: "end", name: "Declined", config: { result: "success" } },
  ], [
    edge("start-review", "start", "success", "review"),
    edge("review-approved", "review", "approved", "accepted"),
    edge("review-rejected", "review", "rejected", "declined"),
  ]);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-gate-description-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  mirror = new RecordingMirror();
  service = new WorkflowService({
    repository, executor: idleExecutor(),
    employees: () => new Map([[employee.name, employee]]), models: () => models,
    now: () => now.toISOString(), todoApprovals: mirror,
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("interpolating the description an operator reads at the gate", () => {
  const SHOT = "attachment:OPS-20:wia_ab12cd34ef56:image/png";

  /** step (produces `shot`) → approval. The gate's description is authored as a
   *  template over that step's output. */
  function stepThenGate(id: string, description: string): WorkflowDefinition {
    return saveDefinition(id, [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "step", type: "employee", name: "Step", config: {
        employee: { source: "fixed", value: employee.name },
        prompt: "Capture the screen.",
        output: { fields: { shot: { type: "attachment", required: true } }, allowAdditionalFields: false },
      } },
      { id: "review", type: "approval", name: "Review", config: { description } },
      { id: "accepted", type: "end", name: "Accepted", config: { result: "success" } },
      { id: "declined", type: "end", name: "Declined", config: { result: "success" } },
    ], [
      edge("start-step", "start", "success", "step"),
      edge("step-review", "step", "success", "review"),
      edge("review-approved", "review", "approved", "accepted"),
      edge("review-rejected", "review", "rejected", "declined"),
    ]);
  }

  async function parkOnGate(definition: WorkflowDefinition, todoId: string): Promise<void> {
    await service.startManual({ workflowId: definition.id, input: {}, todoId });
    await service.submitAttemptOutput({ sessionId: STEP_SESSION, fields: { shot: SHOT } });
  }

  it("resolves an upstream field into the request the Todo shows", async () => {
    const definition = stepThenGate("described", "Ship this? {{ node.step.fields.shot }}");
    await parkOnGate(definition, "OPS-20");

    expect(mirror.requests[0]!.request).toBe(`Ship this? ${SHOT}`);
    expect(mirror.parked[0]!.request).toBe(`Ship this? ${SHOT}`);
  });

  it("leaves a description with no template exactly as authored", async () => {
    const definition = gateDefinition("plain", { description: "Approve?" });
    await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-21" });

    expect(mirror.requests[0]!.request).toBe("Approve?");
  });

  it("falls back to the raw description, and still parks a decidable gate, when the template cannot resolve", async () => {
    const definition = stepThenGate("unresolvable", "Ship this? {{ node.step.fields.missing }}");
    await parkOnGate(definition, "OPS-22");

    expect(mirror.requests[0]!.request).toBe("Ship this? {{ node.step.fields.missing }}");
    const run = service.listRuns(definition.id, {}).items[0]!;
    expect(service.getRun(definition.id, run.id)!.status).toBe("waiting");
    const decided = await service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "approve", decidedBy: "operator", expectedRevision: service.getRun(definition.id, run.id)!.revision });
    expect(decided.status).toBe("completed");
  });
});
