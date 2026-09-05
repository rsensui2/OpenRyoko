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
import { isTransportFailure, workflowError } from "../failure.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

/* A node's retry budget exists for attempts that never landed. Spending it on an
 * employee that ran and reported failure pays twice for a verdict already
 * reached — and once re-ran a phase that had deliberately refused to proceed,
 * which then implemented and parked a merge gate for work already on main. */

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
  failStarts = 0;
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    if (this.failStarts > 0) { this.failStarts -= 1; throw new Error("engine spawn refused"); }
    this.commands.push(command);
    return { sessionId: `session:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): WorkflowAttemptCompletion | null { return null; }
  // No session registry behind these fixtures, so nothing is ever resumable and
  // every replacement here dispatches cold.
  resumableEngineSession(): string | null { return null; }
  attemptState(): { idle: boolean; runningChildren: number } { return { idle: true, runningChildren: 0 }; }

  /** An engine turn that reported an error — the one path whose only account of
   *  itself is its message. */
  async failTurn(nodeId: string, error: string): Promise<void> {
    await this.emit(nodeId, { outcome: "failed", error });
  }
  /** An attempt killed under the runtime with no cause on the row — a legacy
   *  interruption, which the classifier reads as an operator stopping it. */
  async interrupt(nodeId: string, error: string): Promise<void> {
    await this.emit(nodeId, { outcome: "interrupted", error });
  }
  /** An attempt the operator stopped; the session manager forces this cause. */
  async stop(nodeId: string): Promise<void> {
    await this.emit(nodeId, { outcome: "interrupted", interruptionCause: "attempt-stop", error: "Interrupted: stopped" });
  }
  /** An attempt killed by a gateway restart, named as such by the boot sweep. */
  async restart(nodeId: string): Promise<void> {
    await this.emit(nodeId, { outcome: "interrupted", interruptionCause: "gateway-restart",
      error: "Interrupted: gateway restarted while workflow attempt was running" });
  }
  private async emit(nodeId: string,
    outcome: Pick<WorkflowAttemptCompletion, "outcome" | "error" | "interruptionCause">): Promise<void> {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    const event: WorkflowAttemptCompletion = {
      sessionId: `session:${nodeId}:${command.owner.attempt}`, owner: command.owner,
      terminalVersion: 1, turn: 1, completedAt: new Date("2026-07-30T10:00:00.000Z").toISOString(), ...outcome,
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let service: WorkflowService;
const now = new Date("2026-07-30T10:00:00.000Z");

function worker(id: string): WorkflowNode {
  return {
    id, type: "employee", name: id, config: {
      employee: { source: "fixed", value: "worker" }, prompt: `Run ${id}.`,
      retry: { attempts: 2, delaySeconds: 0, backoff: "fixed" },
      output: { fields: {}, allowAdditionalFields: true },
    },
  };
}

/** trigger → work → end, `work` carrying a two-attempt retry budget. */
function definitionWith(id: string): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({
    ...created,
    inputs: [],
    nodes: [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      worker("work"),
      { id: "done", type: "end", name: "Done", config: { result: "success" } },
    ],
    edges: [
      { id: "start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
      { id: "work-done", from: { nodeId: "work", port: "success" }, to: { nodeId: "done", port: "input" } },
    ],
  }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

function attemptsOf(workflowId: string, runId: string) {
  return service.getRun(workflowId, runId)!.attempts.map((attempt) => attempt.attempt);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-retry-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  executor = new FakeExecutor();
  service = new WorkflowService({
    repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString(),
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("isTransportFailure — the message-matched half of the boundary", () => {
  it("accepts provider fault codes, 5xx in status context, and socket faults", () => {
    expect(isTransportFailure("Interactive turn failed: server_error")).toBe(true);
    expect(isTransportFailure("api_error")).toBe(true);
    expect(isTransportFailure("overloaded_error: please retry")).toBe(true);
    expect(isTransportFailure("HTTP 503 from upstream")).toBe(true);
    expect(isTransportFailure("status: 502")).toBe(true);
    expect(isTransportFailure("Bad Gateway")).toBe(true);
    expect(isTransportFailure("connect ECONNRESET 1.2.3.4:443")).toBe(true);
    expect(isTransportFailure("socket hang up")).toBe(true);
    expect(isTransportFailure("fetch failed")).toBe(true);
  });

  it("refuses faults a retry cannot fix, and rate limits the manager already owns", () => {
    expect(isTransportFailure("Interactive turn failed: rate_limit")).toBe(false);
    expect(isTransportFailure("Interactive turn failed: billing_error")).toBe(false);
    expect(isTransportFailure("Interactive turn failed: invalid_request")).toBe(false);
    expect(isTransportFailure("Interactive turn failed: permission_error")).toBe(false);
  });

  it("refuses anything unrecognised — the default is deny, because guessing spends money", () => {
    expect(isTransportFailure("the tests did not pass")).toBe(false);
    expect(isTransportFailure("")).toBe(false);
    // A bare number is not a status code. Matching one would retry a real failure
    // whose summary happened to mention a count.
    expect(isTransportFailure("503 files changed")).toBe(false);
  });
});

describe("workflowError — a model id we got wrong is not a verdict on the work", () => {
  // The live break: a tab-joined composite reached `--model`, the CLI refused it, and
  // the attempt died `retryable: false` with its work already committed.
  it("retries an engine that refused the model id it was handed", () => {
    expect(workflowError(new Error("invalid model selection"), "build").retryable).toBe(true);
  });

  it("still refuses a verdict the employee actually reached", () => {
    expect(workflowError(new Error("the tests did not pass"), "build").retryable).toBe(false);
  });
});

describe("what earns a retry budget", () => {
  it("does NOT retry a submitted failure — the employee ran and reported a verdict", async () => {
    const definition = definitionWith("submitted-failure");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await service.submitAttemptOutput({
      sessionId: "session:work:1", outcome: "failure",
      summary: "Stopping: this work is already merged; advancing would run two pipelines in one worktree.",
    });

    const settled = service.getRun(definition.id, run.id)!;
    expect(attemptsOf(definition.id, run.id)).toEqual([1]);
    expect(settled.status).toBe("failed");
    expect(settled.error).toMatchObject({ code: "workflow-submitted-failure", retryable: false });
  });

  it("retries an engine transport fault and consumes the budget", async () => {
    const definition = definitionWith("transport-fault");
    const run = await service.startManual({ workflowId: definition.id, input: {} });

    await executor.failTurn("work", "Interactive turn failed: server_error");
    expect(service.getRun(definition.id, run.id)!.status).toBe("waiting");
    await service.recover(now.toISOString()); // the wake the runner's timer performs live
    expect(attemptsOf(definition.id, run.id)).toEqual([1, 2]);

    await executor.failTurn("work", "Interactive turn failed: server_error");
    expect(attemptsOf(definition.id, run.id)).toEqual([1, 2]);
    expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
  });

  it("does NOT retry an engine failure that is not a transport fault", async () => {
    const definition = definitionWith("engine-verdict");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.failTurn("work", "Interactive turn failed: invalid_request");

    expect(attemptsOf(definition.id, run.id)).toEqual([1]);
    expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
  });

  it("retries a dispatch that never reached a session, whatever its message says", async () => {
    const definition = definitionWith("dispatch-throw");
    executor.failStarts = 1;
    const run = await service.startManual({ workflowId: definition.id, input: {} });

    expect(service.getRun(definition.id, run.id)!.attempts[0]!.error)
      .toMatchObject({ code: "workflow-dispatch-failed", retryable: true });
    await service.recover(now.toISOString());
    expect(attemptsOf(definition.id, run.id)).toEqual([1, 2]);
  });

  it("retries an attempt interrupted with no recorded cause, and spends the budget", async () => {
    const definition = definitionWith("restart-interrupt");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.interrupt("work", "Interrupted: gateway restarted while workflow attempt was running");

    expect(service.getRun(definition.id, run.id)!.attempts[0]!.error)
      .toMatchObject({ code: "workflow-attempt-interrupted", retryable: true });
    await service.recover(now.toISOString());
    expect(attemptsOf(definition.id, run.id)).toEqual([1, 2]);

    // The budget WAS spent: a stop is a decision about this attempt, so the
    // second interruption exhausts it.
    await executor.interrupt("work", "Interrupted: stopped");
    await service.recover(now.toISOString());
    expect(attemptsOf(definition.id, run.id)).toEqual([1, 2]);
    expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
  });

  it("does NOT retry a forced attempt-stop — the operator decided about this attempt", async () => {
    const definition = definitionWith("operator-stop");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.stop("work");

    expect(service.getRun(definition.id, run.id)!.attempts[0])
      .toMatchObject({ status: "cancelled", error: { code: "workflow-attempt-interrupted", retryable: false } });
    // Two attempts were authored and one is untouched: a stop is a decision, and
    // re-dispatching would overrule it.
    await service.recover(now.toISOString());
    expect(attemptsOf(definition.id, run.id)).toEqual([1]);
    expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
  });

  it("spends NO budget on a gateway restart — it replaces the attempt instead", async () => {
    const definition = definitionWith("gateway-restart");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.restart("work");

    expect(service.getRun(definition.id, run.id)!.attempts[0]!.error)
      .toMatchObject({ code: "workflow-attempt-restart-interrupted", retryable: true });
    // Replaced at once: no backoff to wake, so no recover() in between.
    expect(attemptsOf(definition.id, run.id)).toEqual([1, 2]);

    // And the two-attempt budget is still whole for a fault that IS about the work.
    await executor.failTurn("work", "Interactive turn failed: server_error");
    await service.recover(now.toISOString());
    expect(attemptsOf(definition.id, run.id)).toEqual([1, 2, 3]);
  });

  it("records the error as CLASSIFIED, never rewriting the flag to mean 'we retried'", async () => {
    const definition = definitionWith("honest-flag");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.failTurn("work", "Interactive turn failed: server_error");
    await service.recover(now.toISOString());
    await executor.failTurn("work", "Interactive turn failed: server_error");

    // Same fault, both attempts: the stored flag describes the ERROR, so it reads
    // the same on the attempt that retried and the one that exhausted the budget.
    expect(service.getRun(definition.id, run.id)!.attempts.map((attempt) => attempt.error?.retryable))
      .toEqual([true, true]);
  });
});
