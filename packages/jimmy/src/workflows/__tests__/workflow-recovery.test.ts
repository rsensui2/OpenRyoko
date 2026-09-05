import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, Engine, JinnConfig, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener } from "../../shared/types.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import type { SessionManager } from "../../sessions/manager.js";
import { resumableEngineSession } from "../../sessions/attempt-continuation.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

const sessionHome = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-recovery-sessions-"));
process.env.JINN_HOME = sessionHome;
const employee: Employee = { name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work." };
const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "test-model",
  effortMechanism: "codex-config", models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }] } };

class DurableExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  readonly sessions = new Map<string, string>();
  readonly stopped: string[] = [];
  failStops = false;
  failStarts = 0;
  terminalReader?: (sessionId: string) => WorkflowAttemptCompletion | null;
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  private readonly receipts = new Map<string, WorkflowAttemptCompletion>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    if (this.failStarts > 0) { this.failStarts -= 1; throw new Error("dispatch unavailable"); }
    this.commands.push(command);
    const key = `${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}`;
    const sessionId = this.sessions.get(key) ?? `session:${key}`;
    this.sessions.set(key, sessionId);
    return { sessionId };
  }
  async stopAttempt(input: { sessionId: string }): Promise<void> {
    this.stopped.push(input.sessionId);
    if (this.failStops) throw new Error("stop unavailable");
  }
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(sessionId: string): WorkflowAttemptCompletion | null {
    return this.terminalReader?.(sessionId) ?? this.receipts.get(sessionId) ?? null;
  }
  resumableEngineSession(sessionId: string, engine: string): string | null { return resumableEngineSession(sessionId, engine); }
  async settle(nodeId: string, outcome: "succeeded" | "failed", at: string): Promise<void> {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    const key = `${command.owner.runId}:${nodeId}:${command.owner.attempt}`;
    const event: WorkflowAttemptCompletion = { sessionId: this.sessions.get(key)!, owner: command.owner, turn: 1, terminalVersion: 1,
      outcome, ...(outcome === "succeeded"
        ? { finalText: "Done.\n```jinn-output\n{}\n```" }
        // A transport diagnostic on purpose: these tests exercise the retry
        // MECHANISM, and only an undelivered attempt earns a retry budget.
        : { error: "Interactive turn failed: server_error" }), completedAt: at };
    this.receipts.set(event.sessionId, event);
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}
let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: DurableExecutor;
let service: WorkflowService;
let now: Date;
function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}
function worker(id: string, attempts = 3, delaySeconds = 60): Extract<WorkflowNode, { type: "employee" }> {
  return { id, type: "employee", name: id, config: { employee: { source: "fixed", value: "worker" }, prompt: `Run ${id}.`,
    retry: { attempts, delaySeconds, backoff: "exponential" }, timeoutMinutes: 1 } };
}
function workerWithoutTimeout(id: string): Extract<WorkflowNode, { type: "employee" }> {
  const node = worker(id);
  const { timeoutMinutes: _timeoutMinutes, ...config } = node.config;
  return { ...node, config };
}
function save(id: string, nodes: WorkflowNode[], edges: WorkflowDefinition["edges"]): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({ ...created, nodes, edges }, created.revision);
  return repository.setEnabled(id, true, saved.revision);
}
function linear(id: string, work = worker("work", 2, 0), result: "success" | "failure" = "success") {
  const finish = result === "success" ? "finish" : "failed";
  return save(id, [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } }, work,
    { id: finish, type: "end", name: finish, config: { result } },
  ], [edge("start-work", "start", "success", "work"), edge("work-finish", "work", result === "success" ? "success" : "error", finish)]);
}
function buildService(): WorkflowService {
  return new WorkflowService({ repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString() });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-recovery-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  now = new Date("2026-07-21T10:00:00.000Z");
  repository = new WorkflowRepository(database, () => now.toISOString()); executor = new DurableExecutor(); service = buildService();
});
afterEach(() => { service.dispose(); vi.useRealTimers(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
afterAll(async () => {
  await import("../../sessions/registry.js");
  (await import("../../shared/db.js")).__closeDbForTest();
  fs.rmSync(sessionHome, { recursive: true, force: true });
});
describe("Workflow retry, cancellation, and restart recovery", () => {
  it("persists failure before bounded exponential retry and never duplicates the next attempt", async () => {
    const definition = linear("retry-flow", worker("work"));
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.settle("work", "failed", now.toISOString());
    let failed = service.getRun(definition.id, run.id)!;
    expect(failed.attempts).toMatchObject([{ attempt: 1, status: "failed" }]);
    expect(failed.nodeRuns.find((node) => node.nodeId === "work")).toMatchObject({
      status: "waiting", resumeAt: "2026-07-21T10:01:00.000Z",
    });
    const secondDatabase = openWorkflowDatabase(path.join(root, "workflows.db"));
    const secondExecutor = new DurableExecutor();
    const secondService = new WorkflowService({ repository: new WorkflowRepository(secondDatabase, () => now.toISOString()),
      executor: secondExecutor as unknown as WorkflowSessionExecutor, employees: () => new Map([[employee.name, employee]]),
      models: () => models, now: () => now.toISOString() });
    const [retried, replayed] = await Promise.all([
      service.retryNode({ workflowId: definition.id, runId: run.id, nodeId: "work", idempotencyKey: "retry-1" }),
      secondService.retryNode({ workflowId: definition.id, runId: run.id, nodeId: "work", idempotencyKey: "retry-1" }),
    ]);
    expect(retried.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(replayed.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(executor.sessions).toHaveLength(2);
    now = new Date("2026-07-21T10:02:00.000Z");
    await executor.settle("work", "failed", now.toISOString());
    failed = service.getRun(definition.id, run.id)!;
    expect(failed.nodeRuns.find((node) => node.nodeId === "work")?.resumeAt).toBe("2026-07-21T10:04:00.000Z");
    const settledReplay = await secondService.retryNode({ workflowId: definition.id, runId: run.id, nodeId: "work", idempotencyKey: "retry-1" });
    expect(settledReplay.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    secondService.dispose(); secondDatabase.close();
    service.dispose(); service = buildService(); now = new Date("2026-07-21T10:04:00.000Z");
    await service.recover(now.toISOString());
    expect(service.getRun(definition.id, run.id)?.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
    await executor.settle("work", "succeeded", now.toISOString());
    expect(service.getRun(definition.id, run.id)?.status).toBe("completed");
  });

  it("rejects incompatible retry-key reuse for another Employee", async () => {
    const definition = save("retry-key-conflict", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } }, worker("alpha"), worker("beta"),
      { id: "alpha-end", type: "end", name: "Alpha", config: { result: "success" } },
      { id: "beta-end", type: "end", name: "Beta", config: { result: "success" } },
    ], [edge("start-alpha", "start", "success", "alpha"), edge("start-beta", "start", "success", "beta"),
      edge("alpha-end", "alpha", "success", "alpha-end"), edge("beta-end", "beta", "success", "beta-end")]);
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.settle("alpha", "failed", now.toISOString());
    await executor.settle("beta", "failed", now.toISOString());
    await service.retryNode({ workflowId: definition.id, runId: run.id, nodeId: "alpha", idempotencyKey: "same-key" });
    await expect(service.retryNode({ workflowId: definition.id, runId: run.id, nodeId: "beta", idempotencyKey: "same-key" }))
      .rejects.toThrow(/idempotency key.*different/i);
  });

  it("wakes a future Wait committed after boot at exactly resumeAt without external recovery", async () => {
    service.dispose();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    service = buildService();
    const definition = save("timer-wait", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      { id: "pause", type: "wait", name: "Pause", config: { mode: "duration", minutes: 5 } },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ], [edge("start-pause", "start", "success", "pause"), edge("pause-finish", "pause", "success", "finish")]);
    const waiting = await service.startManual({ workflowId: definition.id, input: {} });
    now = new Date("2026-07-21T10:04:59.999Z");
    await vi.advanceTimersByTimeAsync(299_999);
    expect(service.getRun(definition.id, waiting.id)?.status).toBe("waiting");
    now = new Date("2026-07-21T10:05:00.000Z");
    await vi.advanceTimersByTimeAsync(1);
    expect(service.getRun(definition.id, waiting.id)?.status).toBe("completed");
    now = new Date("2026-07-21T11:00:00.000Z");
    vi.setSystemTime(now);
    const disposed = await service.startManual({ workflowId: definition.id, input: {} });
    service.dispose();
    now = new Date("2026-07-21T11:05:00.000Z");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(repository.getRun(definition.id, disposed.id)?.status).toBe("waiting");
  });

  it("times out a wedged running attempt at its deadline without external recovery", async () => {
    service.dispose();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    service = buildService();
    const definition = linear("timer-timeout", worker("work", 1, 0));
    const run = await service.startManual({ workflowId: definition.id, input: {} });

    now = new Date("2026-07-21T10:00:59.999Z");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(service.getRun(definition.id, run.id)?.attempts).toMatchObject([{ status: "running" }]);

    now = new Date("2026-07-21T10:01:00.000Z");
    await vi.advanceTimersByTimeAsync(1);
    expect(service.getRun(definition.id, run.id)?.attempts).toMatchObject([{
      status: "timed-out",
      error: { code: "workflow-timeout" },
    }]);
  });

  it("defaults an unconfigured employee attempt timeout to 180 minutes", async () => {
    const definition = linear("default-timeout", workerWithoutTimeout("work"));
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    expect(run.attempts).toMatchObject([{ resolvedConfig: { timeoutMinutes: 180 } }]);
  });

  it("preserves an authored employee attempt timeout", async () => {
    const authored = worker("work");
    const definition = linear("authored-timeout", {
      ...authored,
      config: { ...authored.config, timeoutMinutes: 17 },
    });
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    expect(run.attempts).toMatchObject([{ resolvedConfig: { timeoutMinutes: 17 } }]);
  });

  it("times out durably, stops the owned session, and advances the deterministic retry", async () => {
    const definition = linear("timeout-flow");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    now = new Date("2026-07-21T10:01:00.000Z");
    await service.recover(now.toISOString());
    const recovered = service.getRun(definition.id, run.id)!;
    expect(recovered.attempts.map((attempt) => ({ attempt: attempt.attempt, status: attempt.status })))
      .toEqual([{ attempt: 1, status: "timed-out" }, { attempt: 2, status: "running" }]);
    expect(executor.stopped).toEqual([expect.stringContaining(":work:1")]);
  });

  it("retries a running phase attempt orphaned inside its timeout by a gateway restart", async () => {
    const authoredWorker = worker("work", 2, 60);
    const definition = linear("restart-orphan-flow", {
      ...authoredWorker,
      config: { ...authoredWorker.config, timeoutMinutes: 180 },
    });
    const created = repository.createRun({
      workflowId: definition.id,
      input: {},
      trigger: { nodeId: "start", kind: "manual", payload: {} },
    });
    const registry = await import("../../sessions/registry.js");
    const key = `workflow:${definition.id}:${created.id}:work:1`;
    const session = registry.getOrCreateWorkflowAttemptSession({
      engine: "test-engine",
      source: "workflow",
      sourceRef: key,
      connector: "workflow",
      sessionKey: key,
      employee: "worker",
      model: "test-model",
      effortLevel: "high",
      prompt: "Run work.",
      workflowProvenance: {
        kind: "phase",
        workflowId: definition.id,
        workflowName: definition.id,
        runId: created.id,
        triggerSource: "manual",
        phase: { nodeId: "work", name: "work", index: 1, round: 1, attempt: 1 },
      },
    });
    registry.updateSession(session.id, { status: "running" });
    const config = {
      employeeId: "worker",
      engine: "test-engine",
      model: "test-model",
      effort: "high" as const,
      retry: { attempts: 2, delaySeconds: 60, backoff: "exponential" as const },
      timeoutMinutes: 180,
    };
    const detail = repository.getRun(definition.id, created.id)!;
    repository.mutateRun(detail.id, detail.revision, (tx) => {
      tx.setRunStatus("running");
      tx.setNodeStatus("start", "completed", {
        activated: true,
        startedAt: now.toISOString(),
        endedAt: now.toISOString(),
      });
      tx.setNodeStatus("work", "running", {
        activated: true,
        resolvedConfig: config,
        input: {},
        startedAt: now.toISOString(),
      });
      const attempt = tx.createAttempt({ nodeId: "work", resolvedConfig: config, input: {} });
      tx.settleAttempt("work", attempt.attempt, { status: "running", sessionId: session.id });
    });
    const { WorkflowSessionExecutor: ReceiptReader } = await import("../session-executor.js");
    const receiptReader = new ReceiptReader(
      {} as SessionManager,
      (sessionId) => {
        const stored = registry.getSession(sessionId);
        return stored ? { session: stored } : null;
      },
    );
    executor.terminalReader = (sessionId) => receiptReader.readTerminalCompletion(sessionId);

    now = new Date("2026-07-21T10:05:00.000Z");
    const recovery = registry as typeof registry & {
      recoverStaleWorkflowAttemptSessions?: () => number;
    };
    // Keep the call optional so reverting the boot sweep proves the incident
    // assertion below instead of failing earlier on a missing export.
    recovery.recoverStaleWorkflowAttemptSessions?.();
    await service.recover(now.toISOString());

    const recovered = service.getRun(definition.id, created.id)!;
    expect(recovered.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(recovered.nodeRuns.find((node) => node.nodeId === "work")).toMatchObject({ status: "running" });
    expect(recovered.status).toBe("running");
  });

  it("recovers persisted dispatch intent and post-dispatch crash without duplicate session or attempt", async () => {
    const definition = linear("crash-flow");
    const created = repository.createRun({ workflowId: definition.id, input: {}, trigger: { nodeId: "start", kind: "manual", payload: {} } });
    const detail = repository.getRun(definition.id, created.id)!;
    const config = { employeeId: "worker", engine: "test-engine", model: "test-model", effort: "high" as const,
      retry: { attempts: 2, delaySeconds: 0, backoff: "exponential" as const }, timeoutMinutes: 1 };
    repository.mutateRun(detail.id, detail.revision, (tx) => {
      tx.setRunStatus("running"); tx.setNodeStatus("start", "completed", { activated: true, startedAt: now.toISOString(), endedAt: now.toISOString() });
      tx.setNodeStatus("work", "dispatching", { activated: true, resolvedConfig: config, input: {}, startedAt: now.toISOString() });
      tx.createAttempt({ nodeId: "work", resolvedConfig: config, input: {} });
    });
    service.dispose(); service = buildService();
    await service.recover(now.toISOString());
    expect(service.getRun(definition.id, created.id)?.attempts).toMatchObject([{ attempt: 1, status: "running" }]);
    expect(executor.sessions).toHaveLength(1);
    service.dispose(); service = buildService();
    await service.recover(now.toISOString());
    expect(service.getRun(definition.id, created.id)?.attempts).toHaveLength(1);
    expect(executor.sessions).toHaveLength(1);
  });

  it("reconstructs a crash-after-session-insert with the original durable phase session", async () => {
    const definition = linear("session-crash-flow");
    const created = repository.createRun({ workflowId: definition.id, input: {},
      trigger: { nodeId: "start", kind: "manual", payload: {} } });
    const config = { employeeId: "worker", engine: "test-engine", model: "test-model", effort: "high" as const,
      retry: { attempts: 2, delaySeconds: 0, backoff: "exponential" as const }, timeoutMinutes: 1 };
    const detail = repository.getRun(definition.id, created.id)!;
    repository.mutateRun(detail.id, detail.revision, (tx) => {
      tx.setRunStatus("running");
      tx.setNodeStatus("start", "completed", { activated: true, startedAt: now.toISOString(), endedAt: now.toISOString() });
      tx.setNodeStatus("work", "dispatching", { activated: true, resolvedConfig: config, input: {}, startedAt: now.toISOString() });
      tx.createAttempt({ nodeId: "work", resolvedConfig: config, input: {} });
    });
    const registry = await import("../../sessions/registry.js");
    const { SessionManager } = await import("../../sessions/manager.js");
    const { WorkflowSessionExecutor: RealExecutor } = await import("../session-executor.js");
    const key = `workflow:${definition.id}:${created.id}:work:1`;
    const inserted = registry.getOrCreateWorkflowAttemptSession({
      engine: config.engine, source: "workflow", sourceRef: key, connector: "workflow", sessionKey: key,
      employee: config.employeeId, model: config.model, effortLevel: config.effort, prompt: "Run work.",
      workflowProvenance: { kind: "phase", workflowId: definition.id, workflowName: definition.id,
        runId: created.id, triggerSource: "workflow", phase: { nodeId: "work", name: "work", index: 1, round: 1, attempt: 1 } },
    });
    const engine: Engine & { calls: number } = { name: "test-engine", calls: 0,
      run() { this.calls += 1; return new Promise(() => undefined); } };
    const sessionConfig = { gateway: { port: 0, host: "127.0.0.1" }, engines: { default: "test-engine",
      claude: { bin: "", model: "test" }, codex: { bin: "", model: "test" }, "test-engine": {} },
      connectors: {}, logging: { file: false, stdout: false, level: "error" } } as unknown as JinnConfig;
    // Fork adaptation: jimmy's SessionManager takes (config, engines, connectorNames)
    // and wires the employee roster through a setter instead of the constructor.
    const sessions = new SessionManager(sessionConfig, new Map([[engine.name, engine]]));
    sessions.setEmployeeProvider((id) => id === employee.name ? employee : undefined);
    service.dispose();
    service = new WorkflowService({ repository, executor: new RealExecutor(sessions),
      employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString() });

    expect(await service.recover(now.toISOString())).toEqual({ resumedRuns: 1, resumedWaits: 0, resumedComments: 0 });
    await vi.waitFor(() => expect(engine.calls).toBe(1));
    expect(service.getRun(definition.id, created.id)?.attempts).toMatchObject([
      { attempt: 1, status: "running", sessionId: inserted.id },
    ]);
    expect(await service.recover(now.toISOString())).toEqual({ resumedRuns: 0, resumedWaits: 0, resumedComments: 0 });
    expect(service.getRun(definition.id, created.id)?.attempts).toHaveLength(1);
    expect((await import("../../shared/db.js")).initDb().prepare("SELECT COUNT(*) AS count FROM sessions WHERE session_key = ?").get(key))
      .toEqual({ count: 1 });
    expect(engine.calls).toBe(1);
  });

  it("drains cancellation durably even when stopping an owned session fails", async () => {
    const definition = save("cancel-drain", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } }, worker("alpha"), worker("beta"),
      { id: "finish-a", type: "end", name: "A", config: { result: "success" } },
      { id: "finish-b", type: "end", name: "B", config: { result: "success" } },
    ], [edge("start-a", "start", "success", "alpha"), edge("start-b", "start", "success", "beta"),
      edge("a-end", "alpha", "success", "finish-a"), edge("b-end", "beta", "success", "finish-b")]);
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    executor.failStops = true;
    const cancelled = await service.cancelRun({ workflowId: definition.id, runId: run.id, reason: "stop" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.attempts.every((attempt) => attempt.status === "cancelled")).toBe(true);
    expect(cancelled.nodeRuns.some((node) => ["dispatching", "running", "waiting"].includes(node.status))).toBe(false);
  });

  it("persists dispatch failure into the authored retry path", async () => {
    const definition = linear("dispatch-retry");
    executor.failStarts = 1;
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    expect(run.status).toBe("waiting");
    await service.recover(now.toISOString());
    expect(service.getRun(definition.id, run.id)?.attempts.map((attempt) => attempt.status)).toEqual(["failed", "running"]);
  });

  it("routes an exhausted Employee error and settles a failure End", async () => {
    const definition = linear("failure-path", worker("work", 1, 0), "failure");
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.settle("work", "failed", now.toISOString());
    const failed = service.getRun(definition.id, run.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.nodeRuns.find((node) => node.nodeId === "failed")?.status).toBe("completed");
  });
});
