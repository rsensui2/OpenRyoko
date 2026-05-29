import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("../../shared/resolveBin.js", () => ({
  resolveBin: (bin: string) => `/usr/local/bin/${bin}`,
  formatSpawnError: (label: string, bin: string, err: Error) => `Failed to spawn ${label} (${bin}): ${err.message}`,
}));

import { spawn } from "node:child_process";
import { ClaudeEngine } from "../claude.js";
import { isUnresumableTranscriptError } from "../../shared/rateLimit.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  proc.pid = 12345;
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; });
  return proc;
}

function emit(proc: any, obj: unknown) {
  proc.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
}

// The exact API 400 the CLI surfaces when resuming a transcript whose latest
// assistant turn carries thinking blocks that no longer round-trip.
const THINKING_400 =
  "API Error: 400 messages.19.content.1: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";

describe("ClaudeEngine — unresumable transcript on --resume", () => {
  let engine: ClaudeEngine;

  beforeEach(() => { engine = new ClaudeEngine(); });
  afterEach(() => { vi.restoreAllMocks(); mockSpawn.mockReset(); });

  it("surfaces the thinking-block 400 as an unresumable-transcript error even when a rate_limit_event (status 'allowed') is streamed first", async () => {
    const proc = createMockProcess();
    mockSpawn.mockReturnValue(proc as any);

    const p = engine.run({
      prompt: "ping",
      cwd: "/tmp",
      sessionId: "s-resume",
      resumeSessionId: "poisoned-engine-session",
      model: "opus",
    });

    // The CLI emits a rate_limit_event on ordinary requests — this is the trap:
    // a blanket rateLimit?.status guard would swallow the real failure below.
    emit(proc, { type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    // The resumed conversation reports its full prior turn count (19), so the
    // zero-work dead-session heuristic deliberately ignores it.
    emit(proc, {
      type: "result",
      subtype: "error",
      is_error: true,
      result: THINKING_400,
      session_id: "poisoned-engine-session",
      num_turns: 19,
      total_cost_usd: 0,
    });
    proc.exitCode = 1;
    proc.emit("close", 1);

    const result = await p;

    // The error text is preserved, the rate_limit status is attached (the trap),
    // and the turn count is non-zero — yet it must still be classified as
    // unresumable so the manager drops the --resume ID and restarts fresh.
    expect(result.error).toContain("cannot be modified");
    expect(result.rateLimit?.status).toBe("allowed");
    expect(result.numTurns).toBe(19);
    expect(isUnresumableTranscriptError(result)).toBe(true);
  });
});
