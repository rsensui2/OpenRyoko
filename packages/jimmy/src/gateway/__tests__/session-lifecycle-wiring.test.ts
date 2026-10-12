import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// startGateway is not booted by any test, and gateway/server.ts is edited by
// several workstreams at once. The session-lifecycle recovery only works if a
// handful of calls are there AND in a particular order, so a merge that drops
// or moves one would otherwise go unnoticed until a restart in production.
// The behaviour of each call is covered where it lives (sessions/restart-resume,
// gateway/status-reconciler); this file only pins that server.ts still makes them.
const server = fs.readFileSync(path.join(import.meta.dirname, "..", "server.ts"), "utf-8");

/** Offset of a call in server.ts; fails with the call's name when it is gone. */
function callSite(call: string): number {
  const at = server.indexOf(call);
  expect(at, `gateway/server.ts no longer contains \`${call}\``).toBeGreaterThan(-1);
  return at;
}

describe("gateway/server.ts — session lifecycle wiring", () => {
  it("stamps restart interruptions before the boot sweeps erase the evidence", () => {
    const stamp = callSite("prepareRestartResume()");
    expect(stamp).toBeLessThan(callSite("= recoverStaleSessions()"));
    expect(stamp).toBeLessThan(callSite("= recoverStaleQueueItems()"));
  });

  it("chooses whom to nudge only after the queue replay", () => {
    expect(callSite("resumePendingWebQueueItems(apiContext)")).toBeLessThan(callSite("resumeRestartInterruptedSessions({"));
  });

  it("marks running sessions at shutdown before their engines are killed", () => {
    const mark = callSite("interruptRunningSessionsForShutdown()");
    expect(callSite("Gateway cleanup starting")).toBeLessThan(mark);
    expect(mark).toBeLessThan(callSite("interactiveClaudeEngine.killAll()"));
    expect(mark).toBeLessThan(callSite("codexEngine.killAll()"));
    // The workflow sweep runs first: it owns the attempts this call skips.
    expect(server.lastIndexOf("recoverStaleWorkflowAttemptSessions()")).toBeLessThan(mark);
  });

  it("gives the status reconciler the queue-ownership probe", () => {
    const start = callSite("startStatusReconciler({");
    const wiring = server.slice(start, server.indexOf("});", start));
    expect(wiring).toContain("isOwned:");
    expect(wiring).toContain("alwaysNotifyFor:");
  });
});
