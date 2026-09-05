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
import { STOP_NUDGE_TEXT } from "../../sessions/stop-nudge.js";
import type { WorkflowDefinition, WorkflowOutputSchema } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

/** Ordinary progress talk — the case the nudge exists for. It submits nothing,
 *  claims no terminal state, and asks the caller nothing. */
const NARRATION = "I am reviewing the remaining files now.";

const employee: Employee = {
  name: "worker",
  displayName: "Worker",
  department: "operations",
  rank: "employee",
  engine: "test-engine",
  model: "test-model",
  effortLevel: "high",
  persona: "Complete the workflow step.",
};
const models: ModelRegistry = {
  "test-engine": {
    name: "test-engine",
    available: true,
    defaultModel: "test-model",
    effortMechanism: "codex-config",
    models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }],
  },
};

class FakeExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  readonly reminders: Array<{ sessionId: string; text: string }> = [];
  remindError: Error | undefined;
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  private readonly turns = new Map<string, number>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: this.sessionId(command) };
  }
  async stopAttempt(): Promise<void> {}
  async remind(input: { sessionId: string; text: string }): Promise<void> {
    if (this.remindError) throw this.remindError;
    this.reminders.push(input);
  }
  attemptState(): { idle: boolean; runningChildren: number } {
    return { idle: true, runningChildren: 0 };
  }
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): WorkflowAttemptCompletion | null {
    return null;
  }
  async turnEnd(finalText: string): Promise<void> {
    const command = this.commands.at(-1)!;
    const sessionId = this.sessionId(command);
    const turn = (this.turns.get(sessionId) ?? 0) + 1;
    this.turns.set(sessionId, turn);
    await Promise.all([...this.listeners].map((listener) => listener({
      sessionId,
      owner: command.owner,
      turn,
      terminalVersion: 1,
      outcome: "succeeded",
      finalText,
      completedAt: now,
    })));
  }
  sessionId(command = this.commands.at(-1)!): string {
    return `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}`;
  }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let service: WorkflowService;
let now: string;

function saveDefinition(id: string, output?: WorkflowOutputSchema): WorkflowDefinition {
  const created = repository.createDefinition({ id, title: id });
  const saved = repository.saveDefinition({
    ...created,
    nodes: [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      {
        id: "work",
        type: "employee",
        name: "Work",
        config: {
          employee: { source: "fixed", value: "worker" },
          prompt: "Complete the work.",
          ...(output ? { output } : {}),
          retry: { attempts: 1, delaySeconds: 0, backoff: "fixed" },
        },
      },
      { id: "finish", type: "end", name: "Finish", config: { result: "success" } },
    ],
    edges: [
      { id: "start-work", from: { nodeId: "start", port: "success" }, to: { nodeId: "work", port: "input" } },
      { id: "work-finish", from: { nodeId: "work", port: "success" }, to: { nodeId: "finish", port: "input" } },
    ],
  }, created.revision);
  return repository.setEnabled(saved.id, true, saved.revision);
}

async function start(id: string, output?: WorkflowOutputSchema) {
  const definition = saveDefinition(id, output);
  const run = await service.startManual({ workflowId: definition.id, input: {} });
  return { definition, run, sessionId: executor.sessionId() };
}

function attempt(definitionId: string, runId: string) {
  return service.getRun(definitionId, runId)?.attempts[0];
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-stop-nudge-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  now = "2026-07-21T10:00:00.000Z";
  repository = new WorkflowRepository(database, () => now);
  executor = new FakeExecutor();
  service = new WorkflowService({
    repository,
    executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]),
    models: () => models,
    now: () => now,
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("stop nudge at turn end", () => {
  it("nudges a turn that ended on narration instead of arming the five-minute rung", async () => {
    const { definition, run, sessionId } = await start("narrated-turn");
    await executor.turnEnd(NARRATION);

    expect(executor.reminders).toEqual([{ sessionId, text: STOP_NUDGE_TEXT }]);
    expect(attempt(definition.id, run.id)).toMatchObject({ status: "running", stopNudgesSent: 1, remindersSent: 0 });
    expect(attempt(definition.id, run.id)?.nextReminderAt).toBeUndefined();
  });

  it("spends two nudges, then hands the third narration turn to the time ladder", async () => {
    const { definition, run } = await start("two-nudges-then-ladder");
    await executor.turnEnd(NARRATION);
    await executor.turnEnd(NARRATION);

    expect(executor.reminders).toHaveLength(2);
    expect(attempt(definition.id, run.id)).toMatchObject({ stopNudgesSent: 2 });

    await executor.turnEnd(NARRATION);

    expect(executor.reminders).toHaveLength(2);
    expect(attempt(definition.id, run.id)).toMatchObject({
      stopNudgesSent: 2,
      remindersSent: 0,
      nextReminderAt: "2026-07-21T10:05:00.000Z",
    });
  });

  it("does not nudge a turn that claimed a terminal state", async () => {
    const { definition, run } = await start("terminal-claim");
    await executor.turnEnd("The migration is implemented and all tests pass.");

    expect(executor.reminders).toEqual([]);
    expect(attempt(definition.id, run.id)).toMatchObject({
      stopNudgesSent: 0,
      nextReminderAt: "2026-07-21T10:05:00.000Z",
    });
  });

  it("does not nudge a turn that carried a valid output block", async () => {
    const output: WorkflowOutputSchema = {
      fields: { result: { type: "string", required: true } },
      allowAdditionalFields: false,
    };
    const { definition, run } = await start("narration-with-block", output);
    await executor.turnEnd(`${NARRATION}\n\`\`\`jinn-output\n{"result":"shipped"}\n\`\`\``);

    expect(executor.reminders).toEqual([]);
    expect(attempt(definition.id, run.id)).toMatchObject({ status: "completed", stopNudgesSent: 0 });
  });

  it("does not nudge a turn whose output was already submitted through the tool", async () => {
    const output: WorkflowOutputSchema = {
      fields: { result: { type: "string", required: true } },
      allowAdditionalFields: false,
    };
    const { definition, run, sessionId } = await start("submitted-then-narrated", output);
    await service.submitAttemptOutput({ sessionId, fields: { result: "shipped" } });
    await executor.turnEnd(NARRATION);

    expect(executor.reminders).toEqual([]);
    expect(attempt(definition.id, run.id)).toMatchObject({ status: "completed", stopNudgesSent: 0 });
  });

  it("arms the ordinary rung when the nudge cannot be dispatched", async () => {
    const { definition, run } = await start("undispatchable-nudge");
    executor.remindError = new Error('Workflow attempt session "session:x" is not idle.');

    await expect(executor.turnEnd(NARRATION)).resolves.toBeUndefined();

    expect(executor.reminders).toEqual([]);
    expect(attempt(definition.id, run.id)).toMatchObject({
      status: "running",
      stopNudgesSent: 0,
      remindersSent: 0,
      nextReminderAt: "2026-07-21T10:05:00.000Z",
    });
  });
});
