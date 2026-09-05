import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonValue, WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService, WorkflowServiceError } from "../service.js";
import { Executor, employee, models } from "./iteration-harness.js";

/**
 * The runtime half of bounded iteration, on the shape it was built for: a body
 * that keeps asking for another round. It has to stop at exactly `maxRounds`,
 * leave through `exhausted`, and keep every round separately readable.
 */

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: Executor;
let service: WorkflowService;

function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}

function save(id: string, nodes: WorkflowNode[], edges: WorkflowDefinition["edges"]): WorkflowDefinition {
  const created = service.createDefinition({ id, title: id });
  const saved = service.saveDefinition({ ...created, nodes, edges }, created.revision);
  return service.setEnabled({ id, enabled: true, expectedRevision: saved.revision });
}

/** The loop body: one employee that reports a verdict, and echoes which round it
 *  believes it is in so the round binding can be read back off the attempt. */
function bodyWorkflow(): WorkflowDefinition {
  return save("body-flow", [
    { id: "start", type: "trigger", name: "Called", config: { kind: "workflow-call" } },
    { id: "work", type: "employee", name: "Work", config: {
      employee: { source: "fixed", value: "worker" },
      prompt: "Round {{ input.round }} of {{ input.maxRounds }}.",
      retry: { attempts: 1, delaySeconds: 0, backoff: "fixed" },
    } },
    { id: "finish", type: "end", name: "Finish", config: {
      result: "success", output: { source: "node", nodeId: "work", path: "fields" },
    } },
  ], [edge("start-work", "start", "success", "work"), edge("work-finish", "work", "success", "finish")]);
}

/** implement/verify/verdict as one authored body called at most `maxRounds`
 *  times — the shape that costs a duplicated round-2 subgraph today. */
function loopWorkflow(maxRounds: number): WorkflowDefinition {
  return save("loop-flow", [
    { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
    { id: "loop", type: "workflow-call", name: "Rework loop", config: {
      workflowId: { source: "fixed", value: "body-flow" },
      input: {
        round: { source: "trigger", path: "round" },
        maxRounds: { source: "trigger", path: "maxRounds" },
      },
      concurrency: 1,
      iterate: {
        maxRounds,
        continueWhile: [{
          left: { source: "node", nodeId: "loop", path: "fields.last.verdict" },
          operator: "equals", right: { source: "fixed", value: "rework" },
        }],
      },
    } },
    { id: "shipped", type: "end", name: "Shipped", config: {
      result: "success", output: { source: "fixed", value: { route: "shipped" } },
    } },
    { id: "escalated", type: "end", name: "Escalated", config: {
      result: "success", output: { source: "fixed", value: { route: "escalated" } },
    } },
  ], [
    edge("start-loop", "start", "success", "loop"),
    edge("loop-shipped", "loop", "success", "shipped"),
    edge("loop-escalated", "loop", "exhausted", "escalated"),
  ]);
}

/** The validation issue codes a rejected authoring call carried. */
function issueCodes(call: () => unknown): string[] {
  try { call(); } catch (error) {
    return error instanceof WorkflowServiceError ? (error.issues ?? []).map((issue) => issue.code) : [];
  }
  throw new Error("Expected the call to be refused.");
}

function endedAt(runId: string): { route: string; status: string } {
  const detail = service.getRun("loop-flow", runId)!;
  const ends = detail.nodeRuns.filter((node) => node.nodeType === "end" && node.status === "completed");
  return { route: ends.map((node) => node.nodeId).join(",") || "none", status: detail.status };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-iteration-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database, () => "2026-08-20T12:00:00.000Z");
  executor = new Executor();
  service = new WorkflowService({
    repository,
    executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]),
    models: () => models,
    now: () => "2026-08-20T12:00:00.000Z",
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded iteration at run time", () => {
  it("stops at exactly maxRounds and leaves through the exhausted route when the body keeps asking", async () => {
    bodyWorkflow();
    loopWorkflow(3);
    const run = await service.startManual({ workflowId: "loop-flow", input: {} });

    // Four verdicts offered, three rounds allowed.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (executor.commands.length <= attempt) break;
      await executor.settleLatest({ verdict: "rework" });
    }

    const children = repository.listChildRuns(run.id, "loop");
    expect(children).toHaveLength(3);
    expect(executor.commands).toHaveLength(3);
    expect(endedAt(run.id)).toEqual({ route: "escalated", status: "completed" });

    const output = service.getRun("loop-flow", run.id)!.nodeRuns.find((node) => node.nodeId === "loop")!.output!;
    expect(output.fields).toMatchObject({ round: 3, maxRounds: 3, port: "exhausted", exhausted: true });
  });

  it("leaves through success as soon as a round stops asking, without spending the rest of the bound", async () => {
    bodyWorkflow();
    loopWorkflow(3);
    const run = await service.startManual({ workflowId: "loop-flow", input: {} });

    await executor.settleLatest({ verdict: "rework" });
    await executor.settleLatest({ verdict: "ship" });

    expect(repository.listChildRuns(run.id, "loop")).toHaveLength(2);
    expect(endedAt(run.id)).toEqual({ route: "shipped", status: "completed" });
    expect(service.getRun("loop-flow", run.id)!.nodeRuns.find((node) => node.nodeId === "loop")!.output!.fields)
      .toMatchObject({ round: 2, port: "success", exhausted: false, last: { verdict: "ship" } });
  });

  it("tells each round which one it is", async () => {
    bodyWorkflow();
    loopWorkflow(2);
    await service.startManual({ workflowId: "loop-flow", input: {} });

    await executor.settleLatest({ verdict: "rework" });
    await executor.settleLatest({ verdict: "rework" });

    expect(executor.commands[0]!.prompt).toContain("Round 1 of 2.");
    expect(executor.commands[1]!.prompt).toContain("Round 2 of 2.");
  });

  it("keeps every round separately auditable, each with its own run, status and output", async () => {
    bodyWorkflow();
    loopWorkflow(3);
    const run = await service.startManual({ workflowId: "loop-flow", input: {} });

    await executor.settleLatest({ verdict: "rework" });
    await executor.settleLatest({ verdict: "ship" });

    const detail = service.getRun("loop-flow", run.id)!;
    const children = detail.childRuns.filter((child) => child.nodeId === "loop");
    expect(children.map((child) => child.itemIndex)).toEqual([0, 1]);
    expect(new Set(children.map((child) => child.runId)).size).toBe(2);
    expect(children.map((child) => child.endOutput)).toEqual([{ verdict: "rework" }, { verdict: "ship" }]);
    for (const child of children) {
      const body = service.getRun(child.workflowId, child.runId)!;
      expect(body.status).toBe("completed");
      expect(body.attempts.filter((attempt) => attempt.sessionId).length).toBe(1);
    }

    const rounds = detail.nodeRuns.find((node) => node.nodeId === "loop")!.output!.fields.rounds as JsonValue[];
    expect(rounds).toMatchObject([
      { round: 1, status: "succeeded", fields: { verdict: "rework" } },
      { round: 2, status: "succeeded", fields: { verdict: "ship" } },
    ]);
  });

  it("never lets a round replay the round before it", async () => {
    bodyWorkflow();
    loopWorkflow(2);
    const run = await service.startManual({ workflowId: "loop-flow", input: {} });

    await executor.settleLatest({ verdict: "rework" });
    await executor.settleLatest({ verdict: "rework" });

    const keys = repository.listChildRuns(run.id, "loop")
      .map((child) => service.getRun(child.workflowId, child.runId)!.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual([`${run.id}:loop:1`, `${run.id}:loop:2`]);
  });

  it("stops on a round that did not finish rather than reading it as a clean loop", async () => {
    bodyWorkflow();
    loopWorkflow(3);
    const run = await service.startManual({ workflowId: "loop-flow", input: {} });

    await executor.failLatest();

    // One round ran and broke. The loop neither claims success nor asks the
    // broken body for another round.
    expect(repository.listChildRuns(run.id, "loop")).toHaveLength(1);
    expect(executor.commands).toHaveLength(1);
    const detail = service.getRun("loop-flow", run.id)!;
    expect(detail.status).toBe("failed");
    expect(endedAt(run.id).route).toBe("none");
    const loop = detail.nodeRuns.find((node) => node.nodeId === "loop")!;
    expect(loop.status).not.toBe("completed");
    expect(detail.error?.message).toMatch(/round 1 failed/);
  });

  it("refuses to store a loop with no bound, but lets a half-drawn one stay saveable", async () => {
    bodyWorkflow();
    const loop = (iterate: Record<string, unknown>): WorkflowNode => ({
      id: "loop", type: "workflow-call", name: "Loop",
      config: { workflowId: { source: "fixed", value: "body-flow" }, concurrency: 1, iterate } as never,
    });
    const nodes = (iterate: Record<string, unknown>): WorkflowNode[] => [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      loop(iterate),
      { id: "shipped", type: "end", name: "Shipped", config: { result: "success" } },
    ];
    const wired = [edge("start-loop", "start", "success", "loop"), edge("loop-shipped", "loop", "success", "shipped")];
    const check = [{ left: { source: "node", nodeId: "loop", path: "fields.last.verdict" },
      operator: "equals", right: { source: "fixed", value: "rework" } }];

    // The bound is node-local, so it is refused before the definition is stored.
    const draft = service.createDefinition({ id: "unbounded-flow", title: "Unbounded" });
    expect(() => service.saveDefinition({ ...draft, nodes: nodes({ continueWhile: check }), edges: wired }, draft.revision))
      .toThrow(WorkflowServiceError);
    expect(issueCodes(() => service.saveDefinition(
      { ...draft, nodes: nodes({ continueWhile: check }), edges: wired }, draft.revision))).toContain("unbounded-iteration");

    // The exhausted route is a wiring rule: a loop mid-draw still saves, and
    // only enabling it insists the escalation lane exists.
    const partial = service.createDefinition({ id: "half-drawn-flow", title: "Half drawn" });
    const saved = service.saveDefinition(
      { ...partial, nodes: nodes({ maxRounds: 2, continueWhile: check }), edges: wired }, partial.revision);
    expect(saved.revision).toBeGreaterThan(partial.revision);
    expect(issueCodes(() => service.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision })))
      .toContain("iteration-missing-exhausted-route");
  });
});
