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
import { parseTodoApprovalRef } from "../todo-approval-ref.js";

/* Gap 2 (choice approvals decided ON the Todo) + Gap 4 (the run ↔ Todo binding
 * that gives a mirrored gate somewhere to land). */

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
const VARIANTS = ["variant-a", "variant-b", "variant-c"];

/** These workflows park on an Approval before any Employee node, so the
 *  executor only has to exist. */
function idleExecutor(): WorkflowSessionExecutor {
  return {
    async startAttempt() { return { sessionId: "unused" }; },
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-choice-"));
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

describe("run ↔ Todo binding", () => {
  it("carries the bound Todo id on the run's trigger", async () => {
    const definition = gateDefinition("bound", { description: "Approve?" });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-1" });
    expect(run.trigger.todoId).toBe("OPS-1");
    expect(service.getRun(definition.id, run.id)!.trigger.todoId).toBe("OPS-1");
  });

  it("leaves an unbound run's trigger without a Todo id", async () => {
    const definition = gateDefinition("unbound", { description: "Approve?" });
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    expect(run.trigger.todoId).toBeUndefined();
  });

  it("does NOT mirror a parked gate when the run is unbound", async () => {
    const definition = gateDefinition("unbound-gate", { description: "Approve?" });
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    expect(run.status).toBe("waiting");
    expect(mirror.requests).toEqual([]);
  });
});

describe("mirroring a parked gate onto the bound Todo", () => {
  it("mirrors the description, a run-scoped ref, and the offered options", async () => {
    const definition = gateDefinition("mirrored", { description: "Which variant ships?", options: VARIANTS });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-2" });
    expect(mirror.requests).toEqual([{
      todoId: "OPS-2", request: "Which variant ships?", options: VARIANTS,
      ref: `workflow:${definition.id}:${run.id}:review`,
    }]);
  });

  it("routes the mirrored gate to the node's resolved approver", async () => {
    const definition = gateDefinition("mirrored-approver", {
      description: "Approve?", approver: { source: "fixed", value: "reviewer" },
    });
    await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-3" });
    expect(mirror.requests[0]).toMatchObject({ approver: "reviewer" });
  });

  it("the ref round-trips back to the workflow, run, and node that parked", async () => {
    const definition = gateDefinition("roundtrip", { description: "Approve?" });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-4" });
    expect(parseTodoApprovalRef(mirror.requests[0]!.ref))
      .toEqual({ workflowId: definition.id, runId: run.id, nodeId: "review" });
  });

  it("ignores refs that did not come from a workflow mirror", () => {
    expect(parseTodoApprovalRef(null)).toBeNull();
    expect(parseTodoApprovalRef("delegate:abc:123")).toBeNull();
    expect(parseTodoApprovalRef("workflow:wf:run")).toBeNull();
  });

  it("a mirror that throws still leaves the gate parked and decidable", async () => {
    const definition = gateDefinition("mirror-throws", { description: "Approve?" });
    service.dispose();
    service = new WorkflowService({
      repository, executor: idleExecutor(),
      employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString(),
      todoApprovals: { request: () => { throw new Error("Todo is gone"); }, notifyParked: () => {} },
    });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-5" });
    expect(run.status).toBe("waiting");
    expect(run.approvals).toEqual([expect.objectContaining({ nodeId: "review", status: "pending" })]);
  });
});

/** The same gate, but each port leads to a step that reads the decision's own words back out of it. */
function reasonDefinition(id: string): WorkflowDefinition {
  const reader = (nodeId: string): WorkflowNode => ({ id: nodeId, type: "employee", name: nodeId,
    config: { employee: { source: "fixed", value: "worker" }, prompt: "Act on: {{ node.review.fields.reason }}",
      output: { fields: {}, allowAdditionalFields: true } } });
  return saveDefinition(id, [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "review", type: "approval", name: "Review", config: { description: "Approve?" } } as WorkflowNode,
    reader("on-approve"), reader("on-reject"),
    { id: "shipped", type: "end", name: "Shipped", config: { result: "success" } },
    { id: "revised", type: "end", name: "Revised", config: { result: "success" } },
  ], [
    edge("start-review", "start", "success", "review"),
    edge("review-approved", "review", "approved", "on-approve"),
    edge("review-rejected", "review", "rejected", "on-reject"),
    edge("approve-end", "on-approve", "success", "shipped"),
    edge("reject-end", "on-reject", "success", "revised"),
  ]);
}

describe("reading the decision's reason back into the run", () => {
  it.each(["approve", "reject"] as const)("carries a %s reason into the gate's output fields", async (decision) => {
    const definition = reasonDefinition(`reason-${decision}`);
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    const decided = await service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision, decidedBy: "operator", reason: "  The staging soak was clean.  ", expectedRevision: run.revision });

    expect(decided.nodeRuns.find((node) => node.nodeId === "review")?.output)
      .toMatchObject({ fields: { port: decision === "approve" ? "approved" : "rejected",
        reason: "The staging soak was clean." } });
    // The whole point of putting it in `fields`: the next step can read it.
    expect(decided.attempts.at(-1)?.promptText).toContain("Act on: The staging soak was clean.");
  });

  it("leaves no reason field when the decision carried none", async () => {
    const definition = gateDefinition("no-reason", { description: "Approve?" });
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    const decided = await service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "approve", decidedBy: "operator", expectedRevision: run.revision });
    expect(decided.nodeRuns.find((node) => node.nodeId === "review")?.output?.fields).toEqual({ port: "approved" });
  });
});

describe("reading the pick back into the run", () => {
  it("exposes the choice as the Approval node's output", async () => {
    const definition = gateDefinition("reads-back", { description: "Which?", options: VARIANTS });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-6" });
    const decided = await service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "approve", decidedBy: "operator", choice: "variant-b", expectedRevision: run.revision });
    expect(decided.nodeRuns.find((node) => node.nodeId === "review")?.output)
      .toMatchObject({ choice: "variant-b", fields: { port: "approved" } });
    expect(decided.status).toBe("completed");
  });

  it("refuses approving a choice gate with no pick", async () => {
    const definition = gateDefinition("needs-pick", { description: "Which?", options: VARIANTS });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-7" });
    await expect(service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "approve", decidedBy: "operator", expectedRevision: run.revision }))
      .rejects.toThrow(/requires choosing one of/i);
  });

  it("refuses a pick that was never offered", async () => {
    const definition = gateDefinition("bad-pick", { description: "Which?", options: VARIANTS });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-8" });
    await expect(service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "approve", decidedBy: "operator", choice: "variant-z", expectedRevision: run.revision }))
      .rejects.toThrow(/does not offer that choice/i);
  });

  it("refuses a pick on a node that offers no options", async () => {
    const definition = gateDefinition("no-options", { description: "Approve?" });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-9" });
    await expect(service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "approve", decidedBy: "operator", choice: "variant-a", expectedRevision: run.revision }))
      .rejects.toThrow(/does not offer that choice/i);
  });

  it("still allows rejecting a choice gate without a pick", async () => {
    const definition = gateDefinition("reject-no-pick", { description: "Which?", options: VARIANTS });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-10" });
    const decided = await service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "reject", decidedBy: "operator", expectedRevision: run.revision });
    expect(decided.approvals).toEqual([expect.objectContaining({ status: "rejected" })]);
  });
});

/* An operator-only gate. Default routing sends an approval to the org
 * hierarchy root, so the COO can approve a pipeline the COO started — a
 * governance hole when the gate authorizes something irreversible. */
describe("operator-only approval gates", () => {
  it("refuses an employee decision, including the COO's", async () => {
    const definition = gateDefinition("operator-gate", { description: "Merge to main?", operatorOnly: true });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-11" });

    await expect(service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "approve", decidedBy: "Jimbo", expectedRevision: run.revision }))
      .rejects.toThrow(/operator-only/i);

    expect(service.getRun(definition.id, run.id)!.approvals[0]!.status).toBe("pending");
  });

  it("lets the operator decide it and the run advances", async () => {
    const definition = gateDefinition("operator-gate-ok", { description: "Merge to main?", operatorOnly: true });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-12" });
    const decided = await service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "approve", decidedBy: "operator", expectedRevision: run.revision });
    expect(decided.status).toBe("completed");
  });

  it("leaves an ordinary gate decidable by an employee", async () => {
    const definition = gateDefinition("ordinary-gate", {
      description: "Approve?", approver: { source: "fixed", value: "worker" },
    });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-13" });
    const decided = await service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "review",
      decision: "approve", decidedBy: "worker", expectedRevision: run.revision });
    expect(decided.status).toBe("completed");
  });

  it("refuses a definition that is both operator-only and approver-routed, naming why", () => {
    let issues: unknown;
    expect(() => {
      try {
        gateDefinition("contradictory", {
          description: "Approve?", operatorOnly: true, approver: { source: "fixed", value: "worker" },
        });
      } catch (error) {
        issues = (error as { issues?: unknown }).issues;
        throw error;
      }
    }).toThrow(/Workflow definition is invalid/i);
    expect(issues).toContainEqual(expect.objectContaining({
      message: "An operator-only approval cannot also name an approver.",
    }));
  });
});
