import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener } from "../../shared/types.js";
import type { SessionManager } from "../../sessions/manager.js";
import { resumableEngineSession } from "../../sessions/attempt-continuation.js";
import type { EmployeeNode, JsonValue, WorkflowDefinition } from "../model.js";
import { resolveDispatch } from "../node-dispatch.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

/* A gateway restart is not an attempt at the work. Before PLA-154 it was charged
 * as one: the boot sweep left the interruption unexplained, the runtime read it
 * as an operator stopping the attempt, and one restart spent the whole default
 * budget of `attempts: 1` — terminal-failing three live runs at once. */

const sessionHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restart-redispatch-sessions-"));
process.env.JINN_HOME = sessionHome;
const RESTART_ERROR = "Interrupted: gateway restarted while workflow attempt was running";
const employee: Employee = { name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work." };
const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "test-model",
  effortMechanism: "codex-config", models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }] } };

class RestartExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  readonly sessions = new Map<string, string>();
  terminalReader?: (sessionId: string) => WorkflowAttemptCompletion | null;
  onStop?: () => Promise<void>;
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    const sessionId = `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}`;
    this.sessions.set(`${command.owner.nodeId}:${command.owner.attempt}`, sessionId);
    return { sessionId };
  }
  async stopAttempt(): Promise<void> { await this.onStop?.(); }
  attemptState(): { idle: boolean; runningChildren: number } { return { idle: true, runningChildren: 0 }; }
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(sessionId: string): WorkflowAttemptCompletion | null { return this.terminalReader?.(sessionId) ?? null; }
  // Delegated to the real implementation: whether the killed session still holds
  // a usable thread is the whole gate on carrying one forward.
  resumableEngineSession(sessionId: string, engine: string): string | null { return resumableEngineSession(sessionId, engine); }

  /** The completion a gateway restart leaves behind for the attempt that died with it. */
  restart(nodeId: string, at: string): Promise<void> {
    return this.deliver({ ...this.terminalOf(nodeId, at), outcome: "interrupted",
      interruptionCause: "gateway-restart", error: RESTART_ERROR });
  }
  /** An engine turn that reported a transport fault of its own. */
  fail(nodeId: string, at: string): Promise<void> {
    return this.deliver({ ...this.terminalOf(nodeId, at), outcome: "failed", error: "Interactive turn failed: server_error" });
  }
  succeed(nodeId: string, at: string): Promise<void> {
    return this.deliver({ ...this.terminalOf(nodeId, at), outcome: "succeeded", finalText: "Done.\n```jinn-output\n{}\n```" });
  }
  async deliver(event: WorkflowAttemptCompletion): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
  private terminalOf(nodeId: string, at: string): WorkflowAttemptCompletion {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    return { sessionId: this.sessions.get(`${nodeId}:${command.owner.attempt}`)!, owner: command.owner,
      turn: 1, terminalVersion: 1, outcome: "interrupted", completedAt: at };
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: RestartExecutor;
let service: WorkflowService;
let now: Date;

/** trigger → work → end. Omitting `attempts` authors NO retry on the node, so
 *  the budget is whatever node-dispatch resolves as the default. */
function definitionWith(id: string, attempts?: number): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({ ...created, nodes: [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "work", type: "employee", name: "work", config: { employee: { source: "fixed", value: "worker" },
      prompt: "Run work.", timeoutMinutes: 180,
      ...(attempts === undefined ? {} : { retry: { attempts, delaySeconds: 0, backoff: "fixed" as const } }) } },
    { id: "done", type: "end", name: "Done", config: { result: "success" } },
  ], edges: [
    { id: "start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
    { id: "work-done", from: { nodeId: "work", port: "success" }, to: { nodeId: "done", port: "input" } },
  ] }, created.revision);
  return repository.setEnabled(id, true, saved.revision);
}

function attemptsOf(definition: WorkflowDefinition, runId: string) {
  return service.getRun(definition.id, runId)!.attempts.map((attempt) => ({ attempt: attempt.attempt, status: attempt.status }));
}

/**
 * A phase session and its attempt left `running` by a gateway that died under
 * them — the state a boot actually finds. `engineSessionId` is the thread that
 * session still holds; omit it for one that holds nothing resumable.
 */
async function orphanRunningAttempt(definition: WorkflowDefinition, engineSessionId?: string):
Promise<{ runId: string; sessionId: string }> {
  const registry = await import("../../sessions/registry.js");
  const created = repository.createRun({ workflowId: definition.id, input: {},
    trigger: { nodeId: "start", kind: "manual", payload: {} } });
  const key = `workflow:${definition.id}:${created.id}:work:1`;
  const session = registry.getOrCreateWorkflowAttemptSession({
    engine: "test-engine", source: "workflow", sourceRef: key, connector: "workflow", sessionKey: key,
    employee: "worker", model: "test-model", effortLevel: "high", prompt: "Run work.",
    workflowProvenance: { kind: "phase", workflowId: definition.id, workflowName: definition.id, runId: created.id,
      triggerSource: "manual", phase: { nodeId: "work", name: "work", index: 1, round: 1, attempt: 1 } },
  });
  registry.updateSession(session.id, { status: "running" });
  if (engineSessionId) registry.recordEngineSessionId(session.id, "test-engine", engineSessionId);
  const detail = repository.getRun(definition.id, created.id)!;
  // Resolved by the real dispatcher, so an unconfigured node carries exactly the
  // budget node-dispatch gives it rather than one the fixture made up.
  const config = resolveDispatch(detail, detail.definition.nodes.find((item) => item.id === "work") as EmployeeNode, {
    repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models,
  });
  repository.mutateRun(detail.id, detail.revision, (tx) => {
    tx.setRunStatus("running");
    tx.setNodeStatus("start", "completed", { activated: true, startedAt: now.toISOString(), endedAt: now.toISOString() });
    tx.setNodeStatus("work", "running", { activated: true, input: {}, startedAt: now.toISOString(),
      resolvedConfig: config as unknown as Record<string, JsonValue> });
    const attempt = tx.createAttempt({ nodeId: "work", resolvedConfig: config, input: {} });
    tx.settleAttempt("work", attempt.attempt, { status: "running", sessionId: session.id });
  });
  const { WorkflowSessionExecutor: ReceiptReader } = await import("../session-executor.js");
  const reader = new ReceiptReader({} as SessionManager, (id) => {
    const stored = registry.getSession(id);
    return stored ? { session: stored } : null;
  });
  executor.terminalReader = (id) => reader.readTerminalCompletion(id);
  return { runId: created.id, sessionId: session.id };
}

/** Kill everything the old gateway was running, the way a boot does, then boot. */
async function reboot(): Promise<void> {
  const registry = await import("../../sessions/registry.js");
  registry.recoverStaleWorkflowAttemptSessions();
  await service.recover(now.toISOString());
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-restart-redispatch-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  now = new Date("2026-08-19T16:01:00.000Z");
  repository = new WorkflowRepository(database, () => now.toISOString());
  executor = new RestartExecutor();
  service = new WorkflowService({ repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString() });
});
afterEach(() => { service.dispose(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
afterAll(async () => {
  (await import("../../shared/db.js")).__closeDbForTest();
  fs.rmSync(sessionHome, { recursive: true, force: true });
});

describe("Replacing a workflow attempt a gateway restart killed", () => {
  it("re-dispatches an attempt with NO retry budget left, and the run completes", async () => {
    const definition = definitionWith("default-budget");
    const { runId, sessionId } = await orphanRunningAttempt(definition, "engine-thread-1");

    now = new Date("2026-08-19T16:05:00.000Z");
    await reboot();

    expect(service.getRun(definition.id, runId)!.attempts[0]!.resolvedConfig.retry)
      .toEqual({ attempts: 1, delaySeconds: 0, backoff: "fixed" });
    expect(service.getRun(definition.id, runId)!.status).not.toBe("failed");
    expect(attemptsOf(definition, runId)).toEqual([
      { attempt: 1, status: "cancelled" }, { attempt: 2, status: "running" },
    ]);
    expect(service.getRun(definition.id, runId)!.attempts[0]!.error)
      .toMatchObject({ code: "workflow-attempt-restart-interrupted", message: RESTART_ERROR });
    // The replacement picks up the thread the killed session still held.
    expect(executor.commands.at(-1)).toMatchObject({ owner: { nodeId: "work", attempt: 2 },
      continueFrom: { engine: "test-engine", engineSessionId: "engine-thread-1", sourceSessionId: sessionId } });

    await executor.succeed("work", now.toISOString());
    expect(service.getRun(definition.id, runId)!.status).toBe("completed");
  });

  it("dispatches the replacement cold when the killed session held no usable thread", async () => {
    const definition = definitionWith("cold-replacement");
    const { runId } = await orphanRunningAttempt(definition);

    now = new Date("2026-08-19T16:05:00.000Z");
    await reboot();

    expect(executor.commands.at(-1)).toMatchObject({ owner: { nodeId: "work", attempt: 2 } });
    expect(executor.commands.at(-1)!.continueFrom).toBeUndefined();
    expect(attemptsOf(definition, runId)).toEqual([
      { attempt: 1, status: "cancelled" }, { attempt: 2, status: "running" },
    ]);
  });

  it("leaves the retry budget whole, so a genuine fault after the restart still retries", async () => {
    const definition = definitionWith("budget-intact", 2);
    const { runId } = await orphanRunningAttempt(definition);

    now = new Date("2026-08-19T16:05:00.000Z");
    await reboot();
    expect(attemptsOf(definition, runId)).toHaveLength(2);

    // The restart spent nothing, so this transport fault is the FIRST call on the
    // two-attempt budget and still earns its own retry.
    await executor.fail("work", now.toISOString());
    await service.recover(now.toISOString());
    expect(attemptsOf(definition, runId)).toEqual([
      { attempt: 1, status: "cancelled" }, { attempt: 2, status: "failed" }, { attempt: 3, status: "running" },
    ]);
    expect(service.getRun(definition.id, runId)!.status).not.toBe("failed");
  });

  it("replays one terminal completion and one boot into exactly one replacement", async () => {
    const definition = definitionWith("idempotent");
    const { runId, sessionId } = await orphanRunningAttempt(definition);

    now = new Date("2026-08-19T16:05:00.000Z");
    const registry = await import("../../sessions/registry.js");
    registry.recoverStaleWorkflowAttemptSessions();
    const completion = executor.terminalReader!(sessionId)!;
    await service.recover(now.toISOString());
    // The same boot state read twice, and the same terminal event delivered
    // again: neither may open a second replacement.
    await service.recover(now.toISOString());
    await executor.deliver(completion);

    expect(attemptsOf(definition, runId)).toEqual([
      { attempt: 1, status: "cancelled" }, { attempt: 2, status: "running" },
    ]);
  });

  it("stops re-dispatching at the cap and fails the run truthfully", async () => {
    const definition = definitionWith("restart-storm");
    const run = await service.startManual({ workflowId: definition.id, input: {} });

    for (let boot = 0; boot < 6; boot += 1) {
      if (service.getRun(definition.id, run.id)!.status === "failed") break;
      await executor.restart("work", now.toISOString());
    }

    const stormed = service.getRun(definition.id, run.id)!;
    expect(stormed.status).toBe("failed");
    expect(stormed.error).toMatchObject({ code: "workflow-attempt-restart-exhausted", retryable: false });
    expect(stormed.error!.message).toContain("4 gateway restarts");
    // Every one of them was interrupted rather than judged, so they settle the
    // way an interrupted attempt always has; the RUN is what fails.
    expect(attemptsOf(definition, run.id).map((attempt) => attempt.status))
      .toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
  });

  it("settles the RUN, not just the attempt, when the gateway died inside the cancel", async () => {
    const definition = definitionWith("cancel-crash-window");
    const { runId } = await orphanRunningAttempt(definition);
    // The window cancelRun opens: `cancelRequestedAt` is durable on the run row,
    // and the gateway dies before the drain that would have settled it.
    const detail = repository.getRun(definition.id, runId)!;
    repository.mutateRun(detail.id, detail.revision, (tx) => tx.setRunStatus("running", { cancelRequestedAt: now.toISOString() }));

    now = new Date("2026-08-19T16:05:00.000Z");
    await reboot();

    expect(service.getRun(definition.id, runId)!.status).toBe("cancelled");
    expect(attemptsOf(definition, runId)).toEqual([{ attempt: 1, status: "cancelled" }]);
    expect(executor.commands).toHaveLength(0);

    // And a second boot has nothing left to repair.
    await service.recover(now.toISOString());
    expect(attemptsOf(definition, runId)).toEqual([{ attempt: 1, status: "cancelled" }]);
    expect(service.getRun(definition.id, runId)!.status).toBe("cancelled");
  });

  it("settles cancelled, never a replacement, when the run was cancelled first", async () => {
    const definition = definitionWith("cancel-wins");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    // The restart lands mid-cancel, after `cancelRequestedAt` is durable: the
    // operator's decision owns the attempt, not the gateway that died on it.
    executor.onStop = () => executor.restart("work", now.toISOString());

    const cancelled = await service.cancelRun({ workflowId: definition.id, runId: run.id, reason: "stop" });

    expect(cancelled.status).toBe("cancelled");
    expect(attemptsOf(definition, run.id)).toEqual([{ attempt: 1, status: "cancelled" }]);
    expect(executor.commands.map((command) => command.owner.attempt)).toEqual([1]);
  });
});
