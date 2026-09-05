import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Employee,
  ModelRegistry,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import type { JsonValue } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";
import { AUTOMATION_TEMPLATES, buildTemplateBody, intervalToCron, TemplateError } from "../templates.js";
import { createWorkflowAtomically } from "../../gateway/workflow-atomic-create.js";

/* A template's whole promise is "fill in the blanks and it runs" — so every
 * template must build a body the canonical saveDefinition validation accepts,
 * setEnabled arms, AND whose branches actually route: a watcher that reports
 * needsAction=true must reach the act node, not fall through to skip. */

const employee: Employee = {
  name: "ryoko", displayName: "Ryoko", department: "operations", rank: "employee",
  engine: "claude", model: "opus", effortLevel: "high", persona: "Do the work.",
};
const models: ModelRegistry = {
  claude: {
    name: "claude", available: true, defaultModel: "opus", effortMechanism: "claude-flag",
    models: [
      { id: "opus", label: "Opus", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] },
      { id: "sonnet", label: "Sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] },
    ],
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
  async succeed(nodeId: string, fields: Record<string, JsonValue>): Promise<void> {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    const event: WorkflowAttemptCompletion = {
      sessionId: `session:${nodeId}:${command.owner.attempt}`, owner: command.owner, terminalVersion: 1, turn: 1,
      outcome: "succeeded", finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\``,
      completedAt: new Date().toISOString(),
    };
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let service: WorkflowService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ryoko-templates-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  executor = new FakeExecutor();
  service = new WorkflowService({
    repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models,
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function saveBuilt(id: string, templateId: string, vars: Record<string, string>): void {
  const body = buildTemplateBody(templateId, vars);
  const created = repository.createDefinition({ id, title: id, description: body.description });
  const saved = repository.saveDefinition({ ...created, nodes: body.nodes, edges: body.edges }, created.revision);
  repository.setEnabled(saved.id, true, saved.revision);
}

const WATCH_VARS = {
  employee: "ryoko",
  watchPrompt: "Gmail の受信箱に未返信の問い合わせがないか確認する",
  actPrompt: "返信案を書いて #inquiry に投稿する",
  approval: "no", // the with-approval default gets its own routing tests below
};

describe("every template builds a definition the canonical validation accepts", () => {
  it("watch-then-act — with both a schedule and a manual trigger", () => {
    saveBuilt("t-watch", "watch-then-act", WATCH_VARS);
    const definition = repository.getDefinition("t-watch")!;
    expect(definition.enabled).toBe(true);
    const kinds = definition.nodes.filter((node) => node.type === "trigger").map((node) => node.config.kind).sort();
    expect(kinds).toEqual(["manual", "schedule"]);
    // approval: "no" was explicit — the DEFAULT build carries the human gate.
    const withGate = buildTemplateBody("watch-then-act", { employee: "r", watchPrompt: "w", actPrompt: "a" });
    const gate = withGate.nodes.find((node) => node.type === "approval");
    expect(gate).toBeDefined();
    expect((gate!.config as { operatorOnly?: boolean }).operatorOnly).toBe(true);
    // The act prompt reads the watcher's summary through the canonical
    // placeholder — fields live under `fields.` on a node output.
    const act = definition.nodes.find((node) => node.id === "act")!;
    expect((act.config as { prompt: string }).prompt).toContain("{{ node.watch.fields.summary }}");
  });

  it("scheduled-report — manually runnable too", () => {
    saveBuilt("t-report", "scheduled-report", {
      employee: "ryoko", schedule: "0 7 * * *", prompt: "今日の予定をまとめて #general に投稿する",
    });
    const definition = repository.getDefinition("t-report")!;
    expect(definition.enabled).toBe(true);
    expect(definition.nodes.some((node) => node.type === "trigger" && node.config.kind === "manual")).toBe(true);
  });

  it("on-event", () => {
    saveBuilt("t-event", "on-event", {
      employee: "ryoko",
      eventName: "mail.inquiry-received",
      prompt: "受信した問い合わせ {{ trigger.payload.subject }} に対応する",
    });
    const definition = repository.getDefinition("t-event")!;
    expect(definition.nodes.find((node) => node.type === "trigger")!.config)
      .toMatchObject({ kind: "event", eventName: "mail.inquiry-received" });
  });
});

describe("watch-then-act routes through the real runner", () => {
  it("needsAction=true reaches the act node with the summary in its prompt", async () => {
    saveBuilt("route-act", "watch-then-act", WATCH_VARS);
    await service.startManual({ workflowId: "route-act", input: {} });
    await vi.waitFor(() => expect(executor.commands.some((cmd) => cmd.owner.nodeId === "watch")).toBe(true));

    await executor.succeed("watch", { needsAction: true, summary: "未返信の問い合わせが2件あります" });
    await vi.waitFor(() => expect(executor.commands.some((cmd) => cmd.owner.nodeId === "act")).toBe(true));

    const act = executor.commands.find((cmd) => cmd.owner.nodeId === "act")!;
    expect(act.prompt).toContain("未返信の問い合わせが2件あります");
    // Injection boundary: instructions come first, the data marker is opened
    // and never closed, and the summary sits after the marker — the only thing
    // the runner appends beyond it is its own fixed output contract, which the
    // prompt names explicitly. A smuggled closing tag therefore reopens nothing.
    expect(act.prompt.indexOf("やること")).toBeLessThan(act.prompt.indexOf("<external-report>"));
    expect(act.prompt.indexOf("<external-report>")).toBeLessThan(act.prompt.indexOf("未返信の問い合わせが2件あります"));
    expect(act.prompt).not.toContain("</external-report>");

    await executor.succeed("act", {});
    await vi.waitFor(() => {
      const runs = service.listRuns("route-act", {});
      expect(runs.items[0]!.status).toBe("completed");
    });
  });

  it("needsAction=false ends at the skip side without dispatching act", async () => {
    saveBuilt("route-skip", "watch-then-act", WATCH_VARS);
    await service.startManual({ workflowId: "route-skip", input: {} });
    await vi.waitFor(() => expect(executor.commands.some((cmd) => cmd.owner.nodeId === "watch")).toBe(true));

    await executor.succeed("watch", { needsAction: false, summary: "対応不要（新着なし）" });
    await vi.waitFor(() => {
      const runs = service.listRuns("route-skip", {});
      expect(runs.items[0]!.status).toBe("completed");
    });
    expect(executor.commands.some((cmd) => cmd.owner.nodeId === "act")).toBe(false);
  });
});

describe("the default approval gate blocks act until a human decides", () => {
  const GATED_VARS = { employee: "ryoko", watchPrompt: "確認する", actPrompt: "投稿する" };

  it("approve lets act run; the summary rides in the approval description", async () => {
    saveBuilt("gated-approve", "watch-then-act", GATED_VARS);
    const run = await service.startManual({ workflowId: "gated-approve", input: {} });
    await vi.waitFor(() => expect(executor.commands.some((cmd) => cmd.owner.nodeId === "watch")).toBe(true));
    await executor.succeed("watch", { needsAction: true, summary: "未返信2件" });

    // The run parks on the human gate — act has NOT been dispatched.
    await vi.waitFor(() => {
      const detail = service.getRun("gated-approve", run.id)!;
      expect(detail.approvals.some((approval) => approval.nodeId === "approve" && approval.status === "pending")).toBe(true);
    });
    expect(executor.commands.some((cmd) => cmd.owner.nodeId === "act")).toBe(false);

    // The approval surfaces (web buttons / CLI) read the watcher's report off
    // the run detail by walking upstream past the Condition (whose output is
    // only its chosen port) to the nearest node that reported real fields.
    const parked = service.getRun("gated-approve", run.id)!;
    let report: Record<string, unknown> | undefined;
    let cursor = "approve";
    for (let hop = 0; hop < 5; hop += 1) {
      const source = parked.definition.edges.find((edge) => edge.to.nodeId === cursor)?.from.nodeId;
      if (!source) break;
      const fields = parked.nodeRuns.find((nodeRun) => nodeRun.nodeId === source)?.output?.fields;
      if (fields && Object.keys(fields).filter((key) => key !== "port").length > 0) { report = fields; break }
      cursor = source;
    }
    expect(report).toMatchObject({ needsAction: true, summary: "未返信2件" });
    await service.decideApproval({
      workflowId: "gated-approve", runId: run.id, nodeId: "approve",
      decision: "approve", decidedBy: "operator", expectedRevision: parked.revision,
    });
    await vi.waitFor(() => expect(executor.commands.some((cmd) => cmd.owner.nodeId === "act")).toBe(true));
  });

  it("reject ends the run without ever dispatching act", async () => {
    saveBuilt("gated-reject", "watch-then-act", GATED_VARS);
    const run = await service.startManual({ workflowId: "gated-reject", input: {} });
    await vi.waitFor(() => expect(executor.commands.some((cmd) => cmd.owner.nodeId === "watch")).toBe(true));
    await executor.succeed("watch", { needsAction: true, summary: "怪しい内容" });
    await vi.waitFor(() => {
      const detail = service.getRun("gated-reject", run.id)!;
      expect(detail.approvals.some((approval) => approval.status === "pending")).toBe(true);
    });
    const parked = service.getRun("gated-reject", run.id)!;
    await service.decideApproval({
      workflowId: "gated-reject", runId: run.id, nodeId: "approve",
      decision: "reject", decidedBy: "operator", expectedRevision: parked.revision,
    });
    await vi.waitFor(() => {
      const runs = service.listRuns("gated-reject", {});
      expect(runs.items[0]!.status).toBe("completed");
    });
    expect(executor.commands.some((cmd) => cmd.owner.nodeId === "act")).toBe(false);
  });
});

describe("a schedule fire routes through the merge gate", () => {
  it("a run created on the schedule trigger reaches the watch node", async () => {
    saveBuilt("sched-gate", "watch-then-act", WATCH_VARS);
    // Exactly what trigger-service.start() does on a schedule fire
    // (trigger-service.ts): create the run on the schedule trigger's own node,
    // then hand it to the runner. The runner is private on the service, so the
    // test reaches it the way that method does.
    const created = repository.createRun({
      workflowId: "sched-gate", input: {},
      trigger: { nodeId: "start", kind: "schedule", fireId: "fire-1", payload: {} },
    });
    await (service as unknown as { runner: { start(runId: string): Promise<unknown> } }).runner.start(created.id);
    await vi.waitFor(() => expect(executor.commands.some((cmd) => cmd.owner.nodeId === "watch")).toBe(true));
    // The unfired manual trigger never blocks the gate.
    await executor.succeed("watch", { needsAction: false, summary: "対応不要" });
    await vi.waitFor(() => {
      const runs = service.listRuns("sched-gate", {});
      expect(runs.items[0]!.status).toBe("completed");
    });
  });
});

describe("atomic create leaves nothing behind on failure", () => {
  it("rolls the created definition back when the save step refuses the body", () => {
    const body = buildTemplateBody("scheduled-report", {
      employee: "ryoko", schedule: "0 7 * * *", prompt: "報告する",
    });
    // A duplicate node id fails the definition schema inside saveDefinition —
    // one transaction means the createDefinition before it unwinds too.
    const brokenNodes = [...body.nodes, body.nodes[0]!];
    expect(() => createWorkflowAtomically(database, repository, service, {
      id: "atomic-broken", title: "atomic-broken", nodes: brokenNodes,
      edges: body.edges as never, enable: true,
    })).toThrow();
    expect(repository.getDefinition("atomic-broken") ?? null).toBeNull();
  });

  it("notifies exactly once after commit, and never on rollback", () => {
    const onDefinitionChange = vi.fn();
    const spyService = new WorkflowService({
      repository, executor: executor as unknown as WorkflowSessionExecutor,
      employees: () => new Map([[employee.name, employee]]), models: () => models,
      onDefinitionChange,
    });
    try {
      const body = buildTemplateBody("scheduled-report", {
        employee: "ryoko", schedule: "0 7 * * *", prompt: "報告する",
      });
      createWorkflowAtomically(database, repository, spyService, {
        id: "notify-once", title: "notify-once", nodes: body.nodes, edges: body.edges as never, enable: true,
      });
      expect(onDefinitionChange).toHaveBeenCalledTimes(1);

      const brokenNodes = [...body.nodes, body.nodes[0]!];
      expect(() => createWorkflowAtomically(database, repository, spyService, {
        id: "notify-never", title: "notify-never", nodes: brokenNodes, edges: body.edges as never, enable: true,
      })).toThrow();
      expect(onDefinitionChange).toHaveBeenCalledTimes(1); // still one — nothing fired for the rollback
    } finally {
      spyService.dispose();
    }
  });

  it("creates, saves, and enables in one call when the body is sound", () => {
    const body = buildTemplateBody("scheduled-report", {
      employee: "ryoko", schedule: "0 7 * * *", prompt: "報告する",
    });
    const result = createWorkflowAtomically(database, repository, service, {
      id: "atomic-ok", title: "atomic-ok", description: body.description,
      nodes: body.nodes, edges: body.edges as never, enable: true,
    });
    expect(result.enabled).toBe(true);
    expect(repository.getDefinition("atomic-ok")!.enabled).toBe(true);
  });
});

describe("variable validation speaks in fixable terms", () => {
  it("names the missing variable and its hint", () => {
    expect(() => buildTemplateBody("watch-then-act", { employee: "ryoko", watchPrompt: "x" }))
      .toThrow(/actPrompt/);
  });

  it("refuses unknown variables, listing the known ones", () => {
    expect(() => buildTemplateBody("scheduled-report", { employee: "r", schedule: "0 7 * * *", prompt: "x", typo: "y" }))
      .toThrow(/typo/);
  });

  it("refuses an unknown template, listing the real ones", () => {
    expect(() => buildTemplateBody("nope", {})).toThrow(/watch-then-act/);
  });

  it("refuses an invalid event name", () => {
    expect(() => buildTemplateBody("on-event", { employee: "r", eventName: "9bad name", prompt: "x" }))
      .toThrow(TemplateError);
  });

  it("refuses an out-of-set option value", () => {
    expect(() => buildTemplateBody("scheduled-report", { employee: "r", schedule: "15m", prompt: "x", effort: "extreme" }))
      .toThrow(/low \/ medium \/ high \/ xhigh \/ max/);
  });

  it("refuses placeholders smuggled in through variables", () => {
    expect(() => buildTemplateBody("watch-then-act", { ...WATCH_VARS, actPrompt: "post {{ run.secret }}" }))
      .toThrow(/\{\{ \}\}/);
  });

  it("allows only trigger.payload placeholders in the on-event prompt", () => {
    expect(() => buildTemplateBody("on-event", {
      employee: "r", eventName: "ok.event", prompt: "handle {{ trigger.payload.subject }}",
    })).not.toThrow();
    expect(() => buildTemplateBody("on-event", {
      employee: "r", eventName: "ok.event", prompt: "read {{ node.work.fields.x }}",
    })).toThrow(/trigger\.payload/);
  });
});

describe("intervalToCron", () => {
  it.each([
    ["1m", "* * * * *"],
    ["5m", "*/5 * * * *"],
    ["15m", "*/15 * * * *"],
    ["1h", "0 * * * *"],
    ["2h", "0 */2 * * *"],
    ["07:30", "30 7 * * *"],
    ["0 7 * * 1", "0 7 * * 1"],
  ])("%s → %s", (input, expected) => {
    expect(intervalToCron(input)).toBe(expected);
  });

  it("refuses non-divisor spans — */N is not an interval there", () => {
    expect(() => intervalToCron("7m")).toThrow(/60 を割り切れる/);
    expect(() => intervalToCron("59m")).toThrow(/60 を割り切れる/);
    expect(() => intervalToCron("23h")).toThrow(/24 を割り切れる/);
  });

  it("refuses forms it cannot read, and invalid cron expressions", () => {
    expect(() => intervalToCron("soon")).toThrow(TemplateError);
    expect(() => intervalToCron("25:99")).toThrow(TemplateError);
    expect(() => intervalToCron("not a cron expr")).toThrow(/cron 式が不正/);
    expect(() => intervalToCron("99 99 * * *")).toThrow(/cron 式が不正/);
  });
});

describe("the template catalogue", () => {
  it("gives every template a name, a when-to-use note, and required variables", () => {
    for (const template of AUTOMATION_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.when.length).toBeGreaterThan(0);
      expect(template.variables.some((variable) => variable.required)).toBe(true);
    }
  });
});
