import { describe, expect, it, vi } from "vitest";
import type { Employee, Engine, JinnConfig, WorkflowAttemptCompletion } from "../../shared/types.js";
import { invalidateModelRegistry } from "../../shared/models.js";
import { SessionManager } from "../manager.js";
import { getSession, initDb } from "../registry.js";

vi.mock("../context.js", () => ({ buildContext: () => "Workflow test context" }));

describe("workflow effort reaching the engine", () => {
  it("preserves Astra max from a workflow command through the parentless session", async () => {
    initDb();
    invalidateModelRegistry();
    const config = {
      gateway: { port: 7777, host: "127.0.0.1" },
      engines: {
        default: "codex",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.6-sol", effortLevel: "high", childEffortOverride: "low" },
      },
      connectors: {}, sessions: {},
    } as JinnConfig;
    const run = vi.fn<Engine["run"]>(async () => ({ sessionId: "astra-thread", result: "Done" }));
    const manager = new SessionManager(config, new Map([["codex", { name: "codex", run }]]));
    manager.setEmployeeProvider(() => ({
      name: "worker", displayName: "Worker", department: "platform", rank: "employee",
      engine: "codex", model: "gpt-5.6-sol", effortLevel: "medium", persona: "Work.",
    } as Employee));
    let unsubscribe = () => {};
    const completed = new Promise<WorkflowAttemptCompletion>((resolve) => {
      unsubscribe = manager.subscribeWorkflowAttemptCompletion(resolve);
    });
    try {
      const { sessionId } = await manager.runWorkflowAttempt({
        owner: { workflowId: "astra-effort", runId: "run-astra", nodeId: "work", attempt: 1 },
        employeeId: "worker", engine: "codex", model: "gpt-6-astra", effort: "max", prompt: "Do the work.",
      });
      expect((await completed).outcome).toBe("succeeded");
      expect(getSession(sessionId)?.parentSessionId).toBeNull();
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0][0]).toMatchObject({ model: "gpt-6-astra", effortLevel: "max" });
    } finally {
      unsubscribe();
    }
  });
});
