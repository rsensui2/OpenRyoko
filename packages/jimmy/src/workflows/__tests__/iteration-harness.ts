import type {
  Employee,
  ModelRegistry,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import type { JsonValue } from "../model.js";

/** The one employee, engine and executor a bounded-iteration run needs. Split
 *  out of the suite so the suite stays about the loop. */

export const employee: Employee = {
  name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work.",
};

export const models: ModelRegistry = {
  "test-engine": {
    name: "test-engine", available: true, defaultModel: "test-model", effortMechanism: "codex-config",
    models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }],
  },
};

export class Executor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: this.sessionId(command) };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  readTerminalCompletion(): null { return null; }
  /** Settle the attempt the body is currently parked on, reporting `fields`. */
  async settleLatest(fields: Record<string, JsonValue>): Promise<void> {
    await this.emit({ outcome: "succeeded", finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\`` });
  }
  /** Break the attempt the body is parked on, the way a crashed round arrives. */
  async failLatest(): Promise<void> {
    await this.emit({ outcome: "failed", error: "The body blew up." });
  }
  private async emit(outcome: Partial<WorkflowAttemptCompletion>): Promise<void> {
    const command = this.commands.at(-1)!;
    const event = {
      sessionId: this.sessionId(command), owner: command.owner, terminalVersion: 1, turn: 1,
      completedAt: "2026-08-20T12:05:00.000Z", ...outcome,
    } as WorkflowAttemptCompletion;
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }
  private sessionId(command: WorkflowAttemptCommand): string {
    return `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}`;
  }
}
