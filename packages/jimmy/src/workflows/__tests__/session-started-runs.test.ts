import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Employee,
  ModelRegistry,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import type { JsonValue, TriggerNode, WorkflowDefinition } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { ResolvedEmployeeConfig, WorkflowRunDetail } from "../runtime.js";
import { assertCallableCaller } from "../session-caller.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

const NOW = "2026-08-18T12:00:00.000Z";
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
  readonly stopped: string[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    return { sessionId: attemptSession(command.owner.runId) };
  }
  async stopAttempt(input: { sessionId: string }): Promise<void> { this.stopped.push(input.sessionId); }
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  readTerminalCompletion(): null { return null; }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: Executor;
let service: WorkflowService;

/** Every Workflow here has the same shape, so a run's only attempt session is
 *  addressable from its run id alone. */
function attemptSession(runId: string): string { return `session:${runId}:work`; }

function save(id: string, trigger: TriggerNode["config"] = { kind: "manual" }): WorkflowDefinition {
  const created = service.createDefinition({ id, title: id });
  const saved = service.saveDefinition({ ...created, nodes: [
    { id: "start", type: "trigger", name: "Start", config: trigger },
    { id: "work", type: "employee", name: "Work", config: {
      employee: { source: "fixed", value: "worker" }, prompt: "Do the work.",
    } },
    { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
  ], edges: [
    { id: "start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
    { id: "work-finish", from: { nodeId: "work", port: "success" }, to: { nodeId: "finish", port: "input" } },
  ] }, created.revision);
  return service.setEnabled({ id, enabled: true, expectedRevision: saved.revision });
}

/** A run sitting on a live attempt of its Employee node, whose trigger payload
 *  carries a `caller` key — ancestry on a manual fire, business data on an event. */
function runWithCallerPayload(definition: WorkflowDefinition, config: ResolvedEmployeeConfig,
  caller: JsonValue, kind: "manual" | "event"): string {
  const created = repository.createRun({ workflowId: definition.id, input: {},
    trigger: { nodeId: "start", kind, payload: { caller } } });
  const run = repository.getRun(definition.id, created.id)!;
  repository.mutateRun(run.id, run.revision, (tx) => {
    tx.setNodeStatus("work", "running", { activated: true, startedAt: NOW });
    const attempt = tx.createAttempt({ nodeId: "work", resolvedConfig: config, input: {} });
    tx.settleAttempt("work", attempt.attempt, { status: "running", sessionId: attemptSession(run.id) });
  });
  return run.id;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-session-started-runs-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database, () => NOW);
  executor = new Executor();
  service = new WorkflowService({
    repository,
    executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]),
    models: () => models,
    now: () => NOW,
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Workflow runs started from an attempt session", () => {
  it("refuses a run of the Workflow the calling attempt is itself running", async () => {
    const alpha = save("alpha-flow");
    const run = await service.startManual({ workflowId: alpha.id, input: {} });

    await expect(service.startManual({
      workflowId: alpha.id, input: {}, callerSessionId: attemptSession(run.id),
    })).rejects.toMatchObject({ code: "bad-input", message: "Workflow call recursion is not allowed." });
    expect(service.listRuns(alpha.id, {}).items).toHaveLength(1);
  });

  it("walks the ancestry through a session-started hop, not only Workflow Calls", async () => {
    const alpha = save("alpha-flow");
    const beta = save("beta-flow");
    const alphaRun = await service.startManual({ workflowId: alpha.id, input: {} });
    const betaRun = await service.startManual({
      workflowId: beta.id, input: {}, callerSessionId: attemptSession(alphaRun.id),
    });

    await expect(service.startManual({
      workflowId: alpha.id, input: {}, callerSessionId: attemptSession(betaRun.id),
    })).rejects.toMatchObject({ code: "bad-input", message: "Workflow call recursion is not allowed." });
  });

  it("refuses an ancestry that loops back on itself", async () => {
    const chain = save("chain-flow");
    const target = save("target-flow");
    const seed = await service.startManual({ workflowId: chain.id, input: {} });
    const resolvedConfig = service.getRun(chain.id, seed.id)!.attempts[0]!.resolvedConfig;
    const first = repository.createRun({ workflowId: chain.id, input: {},
      trigger: { nodeId: "start", kind: "manual", payload: {} } }).id;
    const second = runWithCallerPayload(chain, resolvedConfig,
      { workflowId: chain.id, runId: first, nodeId: "work" }, "manual");

    // `createRun` mints its own run id, so no run can name a successor at the
    // moment it is written. The loop is closed over the read instead — the shape
    // a hand-edited or half-restored ledger would hand the guard.
    const looped: Parameters<typeof assertCallableCaller>[0] = {
      findAttemptBySessionId: (sessionId) => repository.findAttemptBySessionId(sessionId),
      listRecoverableRuns: () => repository.listRecoverableRuns(),
      getRun: (workflowId, runId): WorkflowRunDetail | null => {
        const run = repository.getRun(workflowId, runId);
        if (!run || run.id !== first) return run;
        return { ...run, trigger: { ...run.trigger,
          payload: { caller: { workflowId: chain.id, runId: second, nodeId: "work" } } } };
      },
    };

    expect(() => assertCallableCaller(looped, target.id,
      { workflowId: chain.id, runId: second, nodeId: "work" }))
      .toThrow("Workflow caller ancestry contains a cycle.");
  });

  it("refuses an ancestry nested deeper than the cap", async () => {
    const chain = save("chain-flow");
    const target = save("target-flow");
    const seed = await service.startManual({ workflowId: chain.id, input: {} });
    const resolvedConfig = service.getRun(chain.id, seed.id)!.attempts[0]!.resolvedConfig;
    let runId = seed.id;
    for (let depth = 0; depth < 129; depth += 1) {
      const caller = { workflowId: chain.id, runId, nodeId: "work" };
      runId = repository.createRun({ workflowId: chain.id, input: {},
        trigger: { nodeId: "start", kind: "manual", payload: { caller } } }).id;
    }
    const leaf = repository.getRun(chain.id, runId)!;
    repository.mutateRun(leaf.id, leaf.revision, (tx) => {
      tx.setNodeStatus("work", "running", { activated: true, startedAt: NOW });
      const attempt = tx.createAttempt({ nodeId: "work", resolvedConfig, input: {} });
      tx.settleAttempt("work", attempt.attempt, { status: "running", sessionId: attemptSession(leaf.id) });
    });

    await expect(service.startManual({
      workflowId: target.id, input: {}, callerSessionId: attemptSession(leaf.id),
    })).rejects.toMatchObject({ code: "bad-input", message: "Workflow caller ancestry is too deep." });
  }, 30_000);

  it("links a sanctioned spawn under the calling node and cancels it with the parent", async () => {
    const alpha = save("alpha-flow");
    const beta = save("beta-flow");
    const alphaRun = await service.startManual({ workflowId: alpha.id, input: {} });
    const betaRun = await service.startManual({
      workflowId: beta.id, input: {}, callerSessionId: attemptSession(alphaRun.id),
    });

    // The spawn is still running, so its session comes off its own attempt row rather than a node output.
    expect(service.getRun(alpha.id, alphaRun.id)!.childRuns).toEqual([{
      runId: betaRun.id, workflowId: beta.id, nodeId: "work", status: "running", startedAt: NOW,
      sessionId: attemptSession(betaRun.id),
    }]);

    await service.cancelRun({ workflowId: alpha.id, runId: alphaRun.id, reason: "Parent stopped." });

    expect(service.getRun(beta.id, betaRun.id)!.status).toBe("cancelled");
  });

  it("does not mistake an event payload's own caller field for ancestry", async () => {
    const alpha = save("alpha-flow");
    const beta = save("beta-flow");
    const events = save("event-flow", { kind: "event", eventName: "thing.happened" });
    const seed = await service.startManual({ workflowId: alpha.id, input: {} });
    const config = service.getRun(alpha.id, seed.id)!.attempts[0]!.resolvedConfig;
    const fired = runWithCallerPayload(events, config,
      { workflowId: alpha.id, runId: "run_11111111-2222-4333-8444-555555555555", nodeId: "work" }, "event");

    const spawned = await service.startManual({
      workflowId: beta.id, input: {}, callerSessionId: attemptSession(fired),
    });

    expect(service.getRun(events.id, fired)!.childRuns.map((child) => child.runId)).toEqual([spawned.id]);
  });

  it("does not list an event-fired run as a child of the run its payload names", async () => {
    const alpha = save("alpha-flow");
    const events = save("event-flow", { kind: "event", eventName: "thing.happened" });
    const parent = await service.startManual({ workflowId: alpha.id, input: {} });
    const config = service.getRun(alpha.id, parent.id)!.attempts[0]!.resolvedConfig;

    runWithCallerPayload(events, config, { workflowId: alpha.id, runId: parent.id, nodeId: "work" }, "event");

    expect(service.getRun(alpha.id, parent.id)!.childRuns).toEqual([]);
  });

  it("leaves a run started outside an attempt exactly as it was", async () => {
    const alpha = save("alpha-flow");
    const lookup = vi.spyOn(repository, "findAttemptBySessionId");

    const operator = await service.startManual({ workflowId: alpha.id, input: {} });
    expect(lookup).not.toHaveBeenCalled();
    expect(operator.trigger).toEqual({ nodeId: "start", kind: "manual", payload: {} });

    const outsider = await service.startManual({
      workflowId: alpha.id, input: {}, callerSessionId: "session-of-nobody", todoId: "PLA-1",
    });
    expect(outsider.trigger).toEqual({ nodeId: "start", kind: "manual", payload: {}, todoId: "PLA-1" });
    expect(service.getRun(alpha.id, operator.id)!.childRuns).toEqual([]);
  });
});
