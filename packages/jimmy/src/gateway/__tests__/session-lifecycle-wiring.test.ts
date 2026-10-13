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

/**
 * Offset of the first `await` the gateway's cleanup reaches, comments aside.
 * Deliberately not the name of a call: whichever step is awaited first is where
 * the cleanup first yields to the turns that are still running, and another
 * workstream may put a new one ahead of today's.
 */
function firstAwaitOfCleanup(): number {
  const start = callSite("Gateway cleanup starting");
  const end = callSite("Gateway shutdown complete");
  let offset = start;
  for (const line of server.slice(start, end).split("\n")) {
    const code = /^\s*(\/\*|\*)/.test(line) ? "" : line.replace(/(^|[\s;])\/\/.*$/, "$1");
    const at = code.search(/\bawait\b/);
    if (at !== -1) return offset + at;
    offset += line.length + 1;
  }
  throw new Error("the cleanup in gateway/server.ts no longer awaits anything — this guard needs another look");
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

  it("declares the shutdown before the cleanup's first await", () => {
    // Until this is called, an engine process the shutdown's own SIGTERM reached
    // first reads as one that died for no reason — an error reply into the thread.
    // The first await is where a turn that is being settled gets to run, so
    // "before some later await" is not early enough.
    const begin = callSite("beginGatewayShutdown();");
    expect(callSite("Gateway cleanup starting")).toBeLessThan(begin);
    expect(begin, "beginGatewayShutdown() must come before the cleanup's first await").toBeLessThan(firstAwaitOfCleanup());
  });

  it("cancels the pending restart nudges before the cleanup's first await", () => {
    // A nudge accepted while the gateway is going down starts a turn that is killed at once.
    const cancel = callSite("cancelRestartNudges();");
    expect(callSite("Gateway cleanup starting")).toBeLessThan(cancel);
    expect(cancel, "cancelRestartNudges() must come before the cleanup's first await").toBeLessThan(firstAwaitOfCleanup());
    expect(server).toMatch(/cancelRestartNudges = resumeRestartInterruptedSessions\(\{[^}]*\}\)\.cancel;/);
  });

  it("finds the cleanup's first await in code, not in a comment about one", () => {
    // What the two guards above measure against: an awaited call inside the cleanup.
    const at = firstAwaitOfCleanup();
    expect(server.slice(at, at + 40)).toMatch(/^await \w+\(/);
    expect(at).toBeGreaterThan(callSite("Gateway cleanup starting"));
    expect(at).toBeLessThan(callSite("Gateway shutdown complete"));
  });

  it("gives the status reconciler the queue-ownership probe", () => {
    const start = callSite("startStatusReconciler({");
    const wiring = server.slice(start, server.indexOf("});", start));
    expect(wiring).toContain("isOwned:");
    expect(wiring).toContain("alwaysNotifyFor:");
  });
});
