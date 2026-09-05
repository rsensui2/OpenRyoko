import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

import { CodexEngine } from "../codex.js";
import type { StreamDelta } from "../../shared/types.js";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
const mockSpawn = vi.mocked(spawn);

/** Creates a mock ChildProcess that emits events and has controllable stdout/stderr */
function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn() };
  proc.pid = 12345;
  proc.exitCode = null;
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; });
  return proc;
}

describe("CodexEngine", () => {
  let engine: CodexEngine;

  beforeEach(() => {
    engine = new CodexEngine();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("run() — agent_message handling", () => {
    it.each([undefined, "thread-astra"])("passes Astra and max effort to Codex (resume=%s)", async (resumeSessionId) => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);
      const resultPromise = engine.run({
        prompt: "hello", cwd: "/tmp", model: "gpt-6-astra", effortLevel: "max", resumeSessionId,
      });
      const args = mockSpawn.mock.calls.at(-1)?.[1] as string[];
      expect(args[args.indexOf("--model") + 1]).toBe("gpt-6-astra");
      expect(args).toContain('model_reasoning_effort="max"');
      proc.exitCode = 0;
      proc.emit("close", 0);
      await resultPromise;
    });

    it("uses a positional fence so dash-prefixed prompts are never parsed as CLI flags", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);
      const resultPromise = engine.run({ prompt: "--help", cwd: "/tmp" });
      const args = mockSpawn.mock.calls.at(-1)?.[1] as string[];
      expect(args.slice(-2)).toEqual(["--", "--help"]);
      proc.exitCode = 0;
      proc.emit("close", 0);
      await resultPromise;
    });

    it("fences both the resume thread id and prompt", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);
      const resultPromise = engine.run({ prompt: "--help", resumeSessionId: "--last", cwd: "/tmp" });
      const args = mockSpawn.mock.calls.at(-1)?.[1] as string[];
      expect(args.slice(-3)).toEqual(["--", "--last", "--help"]);
      proc.exitCode = 0;
      proc.emit("close", 0);
      await resultPromise;
    });

    it("delivers only the final agent_message, not interim progress narration", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const resultPromise = engine.run({ prompt: "what model are you?", cwd: "/tmp" });

      // gpt-5.5 emits an interim "I'll do X first" message, then its real answer.
      proc.stdout.emit("data", Buffer.from(
        JSON.stringify({ type: "thread.started", thread_id: "th-1" }) + "\n" +
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I'll check the boot files first, then answer." } }) + "\n" +
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I'm running on gpt-5.5." } }) + "\n" +
        JSON.stringify({ type: "turn.completed" }) + "\n",
      ));
      proc.exitCode = 0;
      proc.emit("close", 0);

      const result = await resultPromise;
      // Regression: interim agent_messages used to be concatenated into the reply.
      expect(result.result).toBe("I'm running on gpt-5.5.");
      expect(result.result).not.toContain("boot files");
      expect(result.sessionId).toBe("th-1");
      expect(result.error).toBeUndefined();
    });

    it("still surfaces every agent_message to onStream for live progress", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const deltas: StreamDelta[] = [];
      const resultPromise = engine.run({
        prompt: "hi",
        cwd: "/tmp",
        onStream: (d) => deltas.push(d),
      });

      proc.stdout.emit("data", Buffer.from(
        JSON.stringify({ type: "thread.started", thread_id: "th-2" }) + "\n" +
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "working…" } }) + "\n" +
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done." } }) + "\n" +
        JSON.stringify({ type: "turn.completed" }) + "\n",
      ));
      proc.exitCode = 0;
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.result).toBe("done.");
      expect(deltas.filter((d) => d.type === "text").map((d) => d.content)).toEqual([
        "working…",
        "done.",
      ]);
    });

    it("keeps a single agent_message intact", async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const resultPromise = engine.run({ prompt: "hi", cwd: "/tmp" });

      proc.stdout.emit("data", Buffer.from(
        JSON.stringify({ type: "thread.started", thread_id: "th-3" }) + "\n" +
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "single answer" } }) + "\n" +
        JSON.stringify({ type: "turn.completed" }) + "\n",
      ));
      proc.exitCode = 0;
      proc.emit("close", 0);

      const result = await resultPromise;
      expect(result.result).toBe("single answer");
    });
  });
});
