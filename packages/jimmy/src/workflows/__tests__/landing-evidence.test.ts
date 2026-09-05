import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletion, WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import type { JsonValue, WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";
import type { WorkflowTodoLifecycle } from "../runner.js";
import { endRequirementIssues } from "../validation.js";

/* PLA-180: the operator approved the landing, the land phase then aborted on five
 * rebase conflicts and reported that it had merged nothing — and the Todo closed
 * `done` anyway, because reaching a success End behind an approved gate was the
 * whole test. A success End can now demand the evidence, and an End that demands
 * it and does not get it blocks the Todo instead of closing it. */

const MERGED = "a5a56ba8c0ffee1234567890abcdef1234567890";
const PHANTOM = "0123456789abcdef0123456789abcdef01234567";
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
    return { sessionId: `session:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): WorkflowAttemptCompletion | null { return null; }
  attemptState(): { idle: boolean; runningChildren: number } { return { idle: true, runningChildren: 0 }; }

  async succeed(nodeId: string, fields: Record<string, JsonValue> = {}): Promise<void> {
    await this.emit(nodeId, { outcome: "succeeded", finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\`` });
  }
  async report(nodeId: string, error: string): Promise<void> {
    await this.emit(nodeId, { outcome: "failed", error });
  }
  private async emit(nodeId: string, outcome: Partial<WorkflowAttemptCompletion>): Promise<void> {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    await Promise.all([...this.listeners].map((listener) => listener({
      sessionId: `session:${nodeId}:${command.owner.attempt}`, owner: command.owner,
      terminalVersion: 1, turn: 1, completedAt: now.toISOString(), outcome: "succeeded", ...outcome,
    } as WorkflowAttemptCompletion)));
  }
}

class RecordingLifecycle implements WorkflowTodoLifecycle {
  readonly reflections: Array<{ status: string; nodeId: string }> = [];
  readonly failures: Array<{ nodeId: string; code: string; message: string }> = [];
  readonly completions: Array<Parameters<WorkflowTodoLifecycle["complete"]>[0]> = [];
  reflect(input: Parameters<WorkflowTodoLifecycle["reflect"]>[0]): void {
    this.reflections.push({ status: input.status, nodeId: input.nodeId });
  }
  recordFailure(input: Parameters<WorkflowTodoLifecycle["recordFailure"]>[0]): void {
    this.failures.push({ nodeId: input.nodeId, code: input.error.code, message: input.error.message });
  }
  requestRevision(): void {}
  recordApprovalDecision(): void {}
  complete(input: typeof this.completions[number]): void { this.completions.push(input); }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let lifecycle: RecordingLifecycle;
let service: WorkflowService;
let asked: Array<{ commit: string; checkout: string }>;
let onMain: boolean | Error;
const now = new Date("2026-08-22T19:59:00.000Z");

function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}
function worker(id: string, field: string): WorkflowNode {
  return {
    id, type: "employee", name: id, config: {
      employee: { source: "fixed", value: "worker" }, prompt: `Run ${id}.`,
      output: { fields: { [field]: { type: "string", required: false } }, allowAdditionalFields: true },
    },
  };
}
function save(id: string, nodes: WorkflowNode[], edges: ReturnType<typeof edge>[]): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({ ...created, inputs: [], nodes, edges }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

/** trigger → plan → operator gate → land, where the success End demands the
 *  commit `land` says it produced, in the checkout `plan` named. */
function landingPipeline(id: string, errorRoute = false): WorkflowDefinition {
  const requires = { nodeId: "land", field: "mergeCommit", commitIn: { nodeId: "plan", field: "worktree" } };
  return save(id, [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    worker("plan", "worktree"),
    { id: "gate", type: "approval", name: "Gate", config: { description: "Approving merges this branch.", operatorOnly: true } },
    worker("land", "mergeCommit"),
    { id: "done", type: "end", name: "Done", config: { result: "success", requires } },
    { id: "not-merged", type: "end", name: "Not merged", config: { result: "failure" } },
    ...(errorRoute ? [{ id: "handled", type: "end", name: "Handled", config: { result: "success", requires } } as WorkflowNode] : []),
  ], [
    edge("start-plan", "start", "success", "plan"),
    edge("plan-gate", "plan", "success", "gate"),
    edge("gate-land", "gate", "approved", "land"),
    edge("gate-stop", "gate", "rejected", "not-merged"),
    edge("land-done", "land", "success", "done"),
    ...(errorRoute ? [edge("land-handled", "land", "error", "handled")] : []),
  ]);
}

/** Run the PLA-180 sequence up to the point where the landing reports back. */
async function approvedLanding(id: string, errorRoute = false): Promise<{ definition: WorkflowDefinition; runId: string }> {
  const definition = landingPipeline(id, errorRoute);
  const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "PLA-180" });
  await executor.succeed("plan", { worktree: "/checkouts/pla-180" });
  await service.decideApproval({ workflowId: definition.id, runId: run.id, nodeId: "gate", decision: "approve",
    decidedBy: "operator", expectedRevision: service.getRun(definition.id, run.id)!.revision });
  return { definition, runId: run.id };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-landing-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  executor = new FakeExecutor();
  lifecycle = new RecordingLifecycle();
  asked = [];
  onMain = true;
  service = new WorkflowService({
    repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString(),
    todoLifecycle: lifecycle,
    landingEvidence: { mergedIntoMain: async (input) => {
      asked.push(input);
      if (onMain instanceof Error) throw onMain;
      return onMain;
    } },
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a success End that demands landing evidence", () => {
  it("blocks the Todo when the landing reported no merge commit", async () => {
    const { definition, runId } = await approvedLanding("landing-absent");
    await executor.succeed("land", { summary: "Landing blocked: 5 conflicts, nothing merged." });

    expect(service.getRun(definition.id, runId)!.status).toBe("failed");
    expect(lifecycle.completions).toEqual([]);
    expect(lifecycle.reflections.at(-1)).toEqual({ status: "blocked", nodeId: "done" });
    expect(lifecycle.failures.at(-1)).toMatchObject({ code: "workflow-landing-unverified" });
    expect(lifecycle.failures.at(-1)!.message).toContain("reported no mergeCommit");
    expect(asked).toEqual([]);
  });

  it("blocks the Todo when the landing reported a blank merge commit", async () => {
    const { definition, runId } = await approvedLanding("landing-blank");
    await executor.succeed("land", { mergeCommit: "  " });

    expect(service.getRun(definition.id, runId)!.status).toBe("failed");
    expect(lifecycle.completions).toEqual([]);
    expect(lifecycle.failures.at(-1)!.message).toContain("reported no mergeCommit");
  });

  it("blocks the Todo and names the SHA when the commit is not on main", async () => {
    onMain = false;
    const { definition, runId } = await approvedLanding("landing-phantom");
    await executor.succeed("land", { mergeCommit: PHANTOM });

    expect(service.getRun(definition.id, runId)!.status).toBe("failed");
    expect(lifecycle.completions).toEqual([]);
    expect(lifecycle.reflections.at(-1)).toEqual({ status: "blocked", nodeId: "done" });
    expect(lifecycle.failures.at(-1)!.message).toContain(PHANTOM);
    expect(asked).toEqual([{ commit: PHANTOM, checkout: "/checkouts/pla-180" }]);
  });

  it("blocks the Todo when canonical delivery cannot be checked", async () => {
    onMain = new Error("origin is unavailable");
    const { definition, runId } = await approvedLanding("landing-unreadable");
    await executor.succeed("land", { mergeCommit: PHANTOM });

    expect(service.getRun(definition.id, runId)!.status).toBe("failed");
    expect(lifecycle.completions).toEqual([]);
    expect(lifecycle.failures.at(-1)!.message).toContain("could not be verified on the canonical branch");
  });

  it("completes the Todo when the reported commit is on main", async () => {
    const { definition, runId } = await approvedLanding("landing-merged");
    await executor.succeed("land", { mergeCommit: MERGED });

    expect(service.getRun(definition.id, runId)!.status).toBe("completed");
    expect(asked).toEqual([{ commit: MERGED, checkout: "/checkouts/pla-180" }]);
    expect(lifecycle.completions).toEqual([{
      todoId: "PLA-180", workflowId: definition.id, runId, nodeId: "gate",
      approvedBy: "operator", approvedAt: now.toISOString(),
    }]);
  });

  it("does not let a submitted failure launder into done down an error edge", async () => {
    const { definition, runId } = await approvedLanding("landing-error-route", true);
    await service.submitAttemptOutput({ sessionId: "session:land:1", outcome: "failure", summary: "Landing blocked: 5 conflicts." });

    expect(service.getRun(definition.id, runId)!.status).toBe("failed");
    expect(lifecycle.completions).toEqual([]);
    expect(lifecycle.reflections.at(-1)).toEqual({ status: "blocked", nodeId: "handled" });
  });
});

describe("a requirement is refused at save time when it names nothing", () => {
  const end = (requires: JsonValue): WorkflowNode =>
    ({ id: "done", type: "end", name: "Done", config: { result: "success", requires } } as unknown as WorkflowNode);
  const definition = (requires: JsonValue): WorkflowDefinition =>
    ({ nodes: [worker("land", "mergeCommit"), end(requires)] } as unknown as WorkflowDefinition);

  it("names the node and the field when the node does not exist", () => {
    expect(endRequirementIssues(definition({ nodeId: "ship", field: "mergeCommit" }))).toEqual([{
      code: "unknown-required-node", nodeId: "done", path: "nodes.1.config.requires.nodeId",
      message: "An End requires field `mergeCommit` from node `ship`, which this Workflow does not define.",
    }]);
  });

  it("names the node and the field when the node declares no such output", () => {
    expect(endRequirementIssues(definition({ nodeId: "land", field: "sha" }))).toEqual([{
      code: "unknown-required-field", nodeId: "done", path: "nodes.1.config.requires.field",
      message: "An End requires field `sha` from node `land`, which that node does not declare as an output field.",
    }]);
  });

  it("checks the checkout reference too", () => {
    expect(endRequirementIssues(definition({
      nodeId: "land", field: "mergeCommit", commitIn: { nodeId: "plan", field: "worktree" },
    }))).toMatchObject([{ code: "unknown-required-node", path: "nodes.1.config.requires.commitIn.nodeId" }]);
  });
});
