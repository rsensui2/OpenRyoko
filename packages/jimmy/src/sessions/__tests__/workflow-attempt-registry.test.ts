import { describe, expect, it, beforeEach } from "vitest";
import {
  claimWorkflowAttemptDispatch,
  getOrCreateWorkflowAttemptSession,
  getQueueItems,
  getSession,
  initDb,
  markQueueItemRunning,
  migrateSessionsSchema,
  recoverStaleSessions,
  recoverStaleWorkflowAttemptSessions,
  settleWorkflowAttemptDispatch,
  updateSession,
  createSession,
} from "../registry.js";
import { workflowAttemptInterruptionCause } from "../workflow-interruptions.js";
import type { Session, WorkflowSessionProvenance } from "../../shared/types.js";

/* The paths a graceful shutdown and the next boot share: the workflow sweep
 * must stamp a receipt the boot classifies as `gateway-restart` (retryable —
 * the run gets REPLACED, not failed), cancel the internal queue rows in the
 * same transaction, and never be undone by the generic session recovery. */

let counter = 0;

function provenance(runId: string): WorkflowSessionProvenance {
  return {
    kind: "phase", workflowId: "flow", workflowName: "flow", runId, triggerSource: "workflow",
    phase: { nodeId: "work", name: "work", index: 1, round: 1, attempt: 1 },
  };
}

function workflowSession(): Session {
  counter += 1;
  const runId = `run-${process.pid}-${counter}`;
  const key = `workflow:flow:${runId}:work:1`;
  return getOrCreateWorkflowAttemptSession({
    engine: "claude", source: "workflow", sourceRef: key, connector: "workflow", sessionKey: key,
    employee: "worker", prompt: "Do the work.", workflowProvenance: provenance(runId),
  });
}

beforeEach(() => {
  initDb();
});

describe("the shutdown/boot workflow sweep", () => {
  it("stamps a receipt the boot classifies as gateway-restart and cancels the queue row", () => {
    const session = workflowSession();
    const claim = claimWorkflowAttemptDispatch(session.id, session.sessionKey, "Do the work.");
    expect(claim).toBeTruthy();
    expect(markQueueItemRunning(claim!)).toBe(true);
    updateSession(session.id, { status: "running" });

    expect(recoverStaleWorkflowAttemptSessions()).toBeGreaterThanOrEqual(1);

    const swept = getSession(session.id)!;
    expect(swept.status).toBe("interrupted");
    expect(swept.attemptOutcome).toBe("interrupted");
    expect(swept.attemptTerminalVersion).toBe(1);
    expect(swept.attemptTurn).toBeGreaterThanOrEqual(1);
    // The classification the workflow runtime reads on the next boot — this is
    // what makes the attempt replaceable instead of a terminal operator stop.
    expect(workflowAttemptInterruptionCause(swept.lastError, swept, swept.attemptTurn)).toBe("gateway-restart");
    // The internal dispatch row died with the attempt: nothing pending survives.
    expect(getQueueItems(session.sessionKey)).toHaveLength(0);
  });

  it("is not undone by the generic session recovery, which skips workflow rows", () => {
    const session = workflowSession();
    updateSession(session.id, { status: "running" });

    recoverStaleSessions();
    // Generic recovery left the workflow row alone (still running, no receipt)…
    expect(getSession(session.id)!.status).toBe("running");
    expect(getSession(session.id)!.attemptOutcome).toBeNull();
    // …so the dedicated sweep still finds it and stamps the full receipt.
    expect(recoverStaleWorkflowAttemptSessions()).toBeGreaterThanOrEqual(1);
    expect(getSession(session.id)!.attemptOutcome).toBe("interrupted");
  });
});

describe("the durable dispatch claim", () => {
  it("clears the previous receipt in the claim transaction and closes the row on settle", () => {
    const session = workflowSession();
    const first = claimWorkflowAttemptDispatch(session.id, session.sessionKey, "Do the work.");
    expect(first).toBeTruthy();
    expect(markQueueItemRunning(first!)).toBe(true);
    // The CAS admits exactly one runner per row.
    expect(markQueueItemRunning(first!)).toBe(false);

    const settled = settleWorkflowAttemptDispatch(session.id, "succeeded");
    expect(settled?.attemptOutcome).toBe("succeeded");
    expect(settled?.attemptTurn).toBe(1);
    // Receipt and queue-row close are one transaction: no pending row survives
    // a settle for a restart to re-execute.
    expect(getQueueItems(session.sessionKey)).toHaveLength(0);

    // A reminder claim opens the next generation durably: the succeeded receipt
    // is cleared in the SAME transaction that creates the pending row.
    const second = claimWorkflowAttemptDispatch(session.id, session.sessionKey, "One more thing.");
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(getSession(session.id)!.attemptOutcome).toBeNull();
    expect(getSession(session.id)!.attemptTerminalVersion).toBe(0);
  });

  it("keeps an interrupted receipt over a late settle", () => {
    const session = workflowSession();
    const claim = claimWorkflowAttemptDispatch(session.id, session.sessionKey, "Do the work.");
    expect(claim).toBeTruthy();
    updateSession(session.id, { status: "running" });
    recoverStaleWorkflowAttemptSessions();

    const settled = settleWorkflowAttemptDispatch(session.id, "succeeded");
    expect(settled?.attemptOutcome).toBe("interrupted");
  });
});

describe("sessions schema migration", () => {
  it("tolerates re-running against a database that already has every column", () => {
    const database = initDb();
    // Both the sessions columns and queue_items.internal already exist here;
    // a re-run (two processes racing the same migration) must not throw.
    expect(() => migrateSessionsSchema(database)).not.toThrow();
    expect(() => migrateSessionsSchema(database)).not.toThrow();
  });
});

describe("non-workflow sessions", () => {
  it("are untouched by the workflow sweep", () => {
    const plain = createSession({ engine: "claude", source: "web", sourceRef: `web-${process.pid}-${counter += 1}` });
    updateSession(plain.id, { status: "running" });
    recoverStaleWorkflowAttemptSessions();
    expect(getSession(plain.id)!.status).toBe("running");
  });
});
