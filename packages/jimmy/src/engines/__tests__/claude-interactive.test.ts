import { describe, it, expect, vi } from "vitest";

// claude-interactive.ts imports node-pty at the top level. node-pty loads its
// native module at import time and that fails on Linux CI runners (looks for
// prebuilds/linux-x64/pty.node under a wrong relative path). TurnResolver is a
// pure-JS class with zero PTY dependency, so mocking the module keeps the test
// focused and CI-portable.
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

import {
  TurnResolver,
  buildAttachmentSuffix,
  buildClaudePtyEnv,
  isNativeClaudeCommand,
  pasteAndSubmit,
  sanitizeAssistantText,
  shouldSettleStalledTurn,
  sumTranscriptUsage,
} from "../claude-interactive.js";

describe("TurnResolver", () => {
  it("resolves only after BOTH SessionStart and Stop", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    let resolved: any;
    r.promise.then((v) => { resolved = v; });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "done" });
    await new Promise((res) => setTimeout(res, 5));
    expect(resolved).toBeUndefined(); // Stop alone is not enough
    r.onHook({ hook_event_name: "SessionStart", session_id: "claude-123" });
    await new Promise((res) => setTimeout(res, 5));
    expect(resolved.result).toBe("done");
    expect(resolved.sessionId).toBe("claude-123");
    expect(resolved.numTurns).toBe(1);
  });

  it("settles with an Interrupted error when killed", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.interrupt("Interrupted: user");
    const v = await r.promise;
    expect(v.error).toMatch(/^Interrupted/);
  });

  it("treats a missing session id as a hard error", async () => {
    const r = new TurnResolver({ fallbackSessionId: undefined });
    r.onHook({ hook_event_name: "SessionStart" }); // no session_id
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "x" });
    const v = await r.promise;
    expect(v.error).toMatch(/session id/i);
  });

  it("with assumeStarted, resolves on Stop alone using fallbackSessionId", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "ok" });
    const v = await r.promise;
    expect(v.result).toBe("ok");
    expect(v.sessionId).toBe("warm-sid");
    expect(v.numTurns).toBe(1);
  });

  it("settles immediately on StopFailure (does not wait for SessionStart) and exposes it", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "StopFailure", error: "rate_limit", error_details: "resets 3pm" });
    const v = await r.promise;
    expect(v.error).toMatch(/rate_limit/);
    expect(v.numTurns).toBe(1);
    expect(r.stopFailure?.error).toBe("rate_limit");
  });
});

describe("TurnResolver — StopFailure grace window (upstream port)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("holds a server_error StopFailure in grace and settles with the error after expiry", async () => {
    const r = new TurnResolver({ fallbackSessionId: "s", stopFailureGraceMs: 20 });
    let resolved: any;
    r.promise.then((v) => { resolved = v; });
    r.onHook({ hook_event_name: "StopFailure", error: "server_error" });
    await sleep(5);
    expect(resolved).toBeUndefined(); // held in grace, not settled yet
    await sleep(40);
    expect(resolved?.error).toMatch(/server_error/);
    expect(resolved?.numTurns).toBe(1);
  });

  it("a later Stop supersedes the graced failure — the CLI retried and finished", async () => {
    const r = new TurnResolver({ fallbackSessionId: "s", assumeStarted: true, stopFailureGraceMs: 50 });
    r.onHook({ hook_event_name: "StopFailure", error: "server_error" });
    await sleep(5);
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "recovered answer" });
    const v = await r.promise;
    expect(v.error).toBeUndefined();
    expect(v.result).toBe("recovered answer");
    expect(r.stopFailure).toBeUndefined(); // superseded, not exposed
  });

  it("tool-hook activity re-arms the grace window", async () => {
    const r = new TurnResolver({ fallbackSessionId: "s", stopFailureGraceMs: 30 });
    let resolved: any;
    r.promise.then((v) => { resolved = v; });
    r.onHook({ hook_event_name: "StopFailure", error: "server_error" });
    // Keep feeding activity past the original 30ms window.
    for (let i = 0; i < 4; i++) {
      await sleep(15);
      r.onHook({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    }
    expect(resolved).toBeUndefined(); // still alive well past 30ms
    await sleep(60); // quiet — grace finally expires
    expect(resolved?.error).toMatch(/server_error/);
  });

  it("defers settling while shouldDeferStopFailure reports in-flight work", async () => {
    let busy = true;
    const r = new TurnResolver({ fallbackSessionId: "s", stopFailureGraceMs: 10, shouldDeferStopFailure: () => busy });
    let resolved: any;
    r.promise.then((v) => { resolved = v; });
    r.onHook({ hook_event_name: "StopFailure", error: "server_error" });
    await sleep(40);
    expect(resolved).toBeUndefined(); // deferred — sub-agent still streaming
    busy = false;
    await sleep(30);
    expect(resolved?.error).toMatch(/server_error/);
  });

  it("rate_limit / authentication_failed still settle immediately", async () => {
    for (const error of ["rate_limit", "authentication_failed", "billing_error", "max_output_tokens"]) {
      const r = new TurnResolver({ fallbackSessionId: "s", stopFailureGraceMs: 10_000 });
      r.onHook({ hook_event_name: "StopFailure", error });
      const v = await r.promise; // resolves without waiting for any grace
      expect(v.error).toContain(error);
    }
  });

  it("PTY death with a pending graced failure reports the API error, not 'process exited'", async () => {
    const r = new TurnResolver({ fallbackSessionId: "s", stopFailureGraceMs: 10_000 });
    r.onHook({ hook_event_name: "StopFailure", error: "server_error" });
    r.interrupt("Interrupted: claude process exited");
    const v = await r.promise;
    expect(v.error).toMatch(/server_error/);
  });

  it("strips leaked thinking blocks from Stop hook assistant text", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true });
    r.onHook({
      hook_event_name: "Stop",
      last_assistant_message: "<thinking>private reasoning</thinking>\n\nVisible answer.",
    });
    const v = await r.promise;
    expect(v.result).toBe("Visible answer.");
  });

  it("can recover-complete a turn when the Stop hook is missing", async () => {
    const r = new TurnResolver({ fallbackSessionId: "old" });
    r.onHook({ hook_event_name: "SessionStart", session_id: "c1" });
    r.completeRecovered("transcript final", "c1");
    const v = await r.promise;
    expect(v.result).toBe("transcript final");
    expect(v.sessionId).toBe("c1");
  });
});

describe("native Claude command handling (upstream port)", () => {
  it("classifies native local commands", () => {
    expect(isNativeClaudeCommand("/compact")).toBe(true);
    expect(isNativeClaudeCommand("/usage")).toBe(true);
    expect(isNativeClaudeCommand("  /model opus")).toBe(true);
    expect(isNativeClaudeCommand("/init")).toBe(false); // real-turn command
    expect(isNativeClaudeCommand("hello /compact")).toBe(false);
    expect(isNativeClaudeCommand("")).toBe(false);
  });

  it("a native turn's Stop settles EMPTY — stale last_assistant_message is not persisted", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true, native: true });
    r.onHook({ hook_event_name: "Stop", last_assistant_message: "PREVIOUS turn's text" });
    const v = await r.promise;
    expect(v.result).toBe("");
    expect(v.error).toBeUndefined();
  });

  it("completeNativeCommand settles empty (context mutators fire no Stop at all)", async () => {
    const r = new TurnResolver({ fallbackSessionId: "warm-sid", assumeStarted: true, native: true });
    r.completeNativeCommand();
    const v = await r.promise;
    expect(v.result).toBe("");
    expect(v.numTurns).toBe(1);
  });
});

describe("Jinn v0.27-v0.30 reliability ports", () => {
  it("scopes cumulative transcript usage to the current turn", () => {
    const content = [
      { type: "assistant", timestamp: "2026-08-17T00:00:00.000Z", message: { id: "old", usage: { input_tokens: 100, output_tokens: 10 } } },
      { type: "assistant", timestamp: "2026-08-17T00:01:00.000Z", message: { id: "new", usage: { input_tokens: 20, output_tokens: 3 } } },
      // Duplicate high-effort line with the same message id must not count twice.
      { type: "assistant", timestamp: "2026-08-17T00:01:01.000Z", message: { id: "new", usage: { input_tokens: 20, output_tokens: 3 } } },
    ].map((line) => JSON.stringify(line)).join("\n");
    const usage = sumTranscriptUsage(content, Date.parse("2026-08-17T00:00:30.000Z"));
    expect(usage).toMatchObject({ inputTokens: 20, outputTokens: 3, assistantTurns: 1 });
  });

  it("keeps attachment paths out of Claude's async image paste parser", () => {
    expect(buildAttachmentSuffix(["/tmp/a b.png"])).toContain("- `/tmp/a b.png`");
    expect(buildAttachmentSuffix(["/tmp/weird`file.png"])).toContain("- ``/tmp/weird`file.png``");
  });

  it("strips suggestion metadata without dropping the real answer", () => {
    expect(sanitizeAssistantText("<suggestion>do this next</suggestion>Real answer")).toBe("Real answer");
    expect(sanitizeAssistantText("Real answer<suggestion>unfinished")).toBe("Real answer");
  });

  it("restores the real model context ceiling behind the local proxy", () => {
    const env = buildClaudePtyEnv(4321, {
      PATH: "/bin",
      CLAUDECODE: "nested",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "750000",
      ANTHROPIC_BASE_URL: "https://stale.invalid",
      ANTHROPIC_API_KEY: "secret",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4321");
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("750000");
    expect(env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL).toBe("1");
  });

  it("requires both elapsed and quiet thresholds before settling a stall", () => {
    expect(shouldSettleStalledTurn(15 * 60_000, 5 * 60_000)).toBe(true);
    expect(shouldSettleStalledTurn(14 * 60_000, 8 * 60_000)).toBe(false);
    expect(shouldSettleStalledTurn(30 * 60_000, 4 * 60_000)).toBe(false);
  });

  it("retries Enter until a submit hook acknowledges the warm prompt", () => {
    vi.useFakeTimers();
    try {
      let submitted = false;
      const writes: string[] = [];
      const cancel = pasteAndSubmit({ write: (s: string) => writes.push(s) }, "hello", {
        submitted: () => submitted,
        intervalMs: 10,
        attempts: 2,
      });
      vi.advanceTimersByTime(150);
      expect(writes.filter((s) => s === "\r")).toHaveLength(1);
      vi.advanceTimersByTime(10);
      expect(writes.filter((s) => s === "\r")).toHaveLength(2);
      submitted = true;
      vi.advanceTimersByTime(20);
      expect(writes.filter((s) => s === "\r")).toHaveLength(2);
      cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
